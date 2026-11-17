const express = require("express");
const axios = require("axios");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth");
const { sanitizeId, isValidGraphId } = require("../utils/sanitize");
const {
  getContactAvatarMap,
  storeCrmSend,
  syncGraphMessages,
  metaOwnIds,
} = require("../services/conversationService");
const {
  mergeStoredConversations,
  storedConversationList,
  recordGraphListInBackground,
} = require("../services/inboxLists");
const conversations = require("../db/conversations");
const messages = require("../db/messages");
const { isBlocked, reportGraphError } = require("../utils/graphAuthGate");

const { describeMetaSendError, TEXT_LIMITS } = require("../utils/metaSendError");
const { resolveRecipientId } = require("../utils/resolveRecipient");

const GRAPH_API = "https://graph.facebook.com/v24.0";

// Cache for the auto-discovered Instagram Business Account ID
let _resolvedIgAccountId = null;

/**
 * Resolve the Instagram Business Account ID reliably:
 * 1. Use INSTAGRAM_ACCOUNT_ID env var if set.
 * 2. Otherwise fetch it from the Graph API via the linked Facebook Page.
 * Result is cached in memory so the API is only hit once per process lifetime.
 */
async function resolveIgAccountId(accessToken, pageId) {
  if (_resolvedIgAccountId) return _resolvedIgAccountId;

  const envId = process.env.INSTAGRAM_ACCOUNT_ID;
  if (envId) {
    _resolvedIgAccountId = envId;
    return _resolvedIgAccountId;
  }

  // Auto-discover via the Page's linked Instagram Business Account
  try {
    const res = await axios.get(`${GRAPH_API}/${pageId}`, {
      params: {
        fields: "instagram_business_account",
        access_token: accessToken,
      },
      timeout: 5000,
    });
    const discovered = res.data?.instagram_business_account?.id;
    if (!discovered) {
      throw new Error(
        "No Instagram Business Account linked to this Facebook Page. " +
          "Link your Instagram Professional account to the Page in Meta Business Suite.",
      );
    }
    console.log(
      `[Instagram] Auto-discovered IG Business Account ID: ${discovered} (INSTAGRAM_ACCOUNT_ID env var not set)`,
    );
    _resolvedIgAccountId = discovered;
  } catch (err) {
    // Re-throw with a clear message so the send route can surface it
    throw Object.assign(
      new Error(
        `Could not resolve Instagram Business Account ID: ${err.response?.data?.error?.message || err.message}`,
      ),
      { status: 500 },
    );
  }

  return _resolvedIgAccountId;
}

// In-memory cache — avoids hitting the slow Graph API on every poll.
// 15 s is safe: webhooks and /send bust the cache via clearIgCache(), so
// real-time updates still surface immediately; this only throttles polling.
let _igCache = null;
let _igCacheTime = 0;
const IG_CACHE_TTL = 45000; // 45 s — webhooks clear it on new traffic
// Separate slim-mode cache (conversation list without embedded messages)
let _igCacheSlim = null;
let _igCacheSlimTime = 0;
// In-flight promise — ensures only ONE Graph API request runs at a time even if many
// clients ask concurrently (prevents thundering herd / rate-limit hammering)
let _igFetch = null;
let _igFetchSlim = null;

// ── Circuit breaker for the IG conversations edge ───────────────────────────
// On Pages with high DM volume Meta starts answering this edge with error
// code 1 ("Please reduce the amount of data…") after 15-25 s — for EVERY
// request, even id-only with limit 10. Without a breaker each inbox poll
// stalls the full 20 s before falling back to the DB. When the edge fails we
// serve the DB-built list (webhooks keep it current) and retry Meta later.
let _igListBackoffUntil = 0;
const IG_LIST_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes
const IG_LIST_TIMEOUT_MS = 8000; // hard cap — never let Meta stall the inbox

// profile_pic on individual IGSID lookups needs User Profile access; once we
// see it fail we stop asking so every later lookup is a single request.
let _igPicSupported = true;

// HUMAN_AGENT needs its own App Review approval — stop attempting it once
// Meta rejects the tag, so the caller sees the original error instead.
let _igHumanAgentApproved = true;

// ── In-flight send claims ────────────────────────────────────────────────────
// The auto-lock is written only after Meta accepted the message, so the time
// between the lock check and the lock creation spans the whole send. A claim
// taken before the lock check and released once the lock is written (or the
// send failed) keeps a second agent out of that window, as the unique lock
// index did when the lock was created before sending. Production runs one
// backend process, so an in-memory map is enough.
const _igSendClaims = new Map(); // lockConvId -> { userId, count }
const noopRelease = () => {};

function igSendClaimHolder(key) {
  return _igSendClaims.get(key)?.userId || null;
}

/**
 * Take the claim on a conversation (shared when the same user already holds
 * it, e.g. two quick sends). Returns an idempotent release function, or null
 * when another user holds the claim.
 */
function takeIgSendClaim(key, userId) {
  const uid = String(userId);
  const held = _igSendClaims.get(key);
  if (held && held.userId !== uid) return null;
  if (held) held.count += 1;
  else _igSendClaims.set(key, { userId: uid, count: 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = _igSendClaims.get(key);
    if (!current || current.userId !== uid) return;
    current.count -= 1;
    if (current.count <= 0) _igSendClaims.delete(key);
  };
}

// ── Text parts waiting for their CRM row ────────────────────────────────────
// A text + attachment send is two Meta messages but ONE CRM row, stored under
// the attachment's id once both calls are done. While that row is not stored,
// the text part's message id is listed here, and the echo webhook
// (routes/webhooks.js) waits instead of storing the text a second time.
const _igPendingTextMids = new Set();

function isTextSendPending(mid) {
  return _igPendingTextMids.has(mid);
}

/**
 * Store a message the CRM sent, following the dedupe contract with the echo
 * webhook (routes/webhooks.js). With Meta's message id, a row the echo stored
 * first (no CRM sender) is claimed instead of duplicated. Without an id, a
 * plain insert.
 * @returns {Promise<{conversation: object, inserted: boolean}>}
 */
function storeIgCrmSend({ messageId, recipientId, content, attachments, sentBy }) {
  return storeCrmSend({
    platform: "instagram",
    customerId: recipientId,
    externalId: messageId,
    content,
    attachments,
    userId: sentBy,
  });
}

// ── Sender → thread-id resolution ───────────────────────────────────────────
// Webhook-created conversations are keyed by the sender's numeric IGSID, but
// Graph history lives under the thread id (t_…). The per-user lookup
// (?user_id=) is a light, targeted query — it can work even while the bulk
// conversations edge is failing for this Page. Successes cache forever
// (thread ids are stable); failures back off for 10 minutes.
const _igThreadIdCache = new Map(); // senderId -> { threadId|null, at }
const THREAD_ID_FAIL_TTL = 10 * 60 * 1000;
const THREAD_ID_CACHE_MAX = 500;

async function resolveIgThreadId(senderId, accessToken, pageId) {
  const cached = _igThreadIdCache.get(senderId);
  if (
    cached &&
    (cached.threadId || Date.now() - cached.at < THREAD_ID_FAIL_TTL)
  ) {
    return cached.threadId;
  }
  let threadId = null;
  try {
    const r = await axios.get(`${GRAPH_API}/${pageId}/conversations`, {
      params: {
        platform: "instagram",
        user_id: senderId,
        fields: "id",
        access_token: accessToken,
      },
      timeout: 5000,
    });
    threadId = r.data?.data?.[0]?.id || null;
  } catch {
    // cached below as a failure — retried after the TTL
  }
  if (_igThreadIdCache.size >= THREAD_ID_CACHE_MAX) {
    _igThreadIdCache.delete(_igThreadIdCache.keys().next().value);
  }
  _igThreadIdCache.set(senderId, { threadId, at: Date.now() });
  return threadId;
}

/**
 * Look up one IGSID's profile: { name, avatar } or null.
 * Single request when profile_pic is known-unsupported; otherwise tries the
 * combined fields once and downgrades permanently on failure.
 */
async function lookupIgProfile(id, accessToken) {
  if (!isValidGraphId(id)) return null;
  // Without Advanced Access every lookup fails — don't even try while the
  // gate is closed (it re-probes hourly and self-heals after App Review).
  if (isBlocked("instagram")) return null;
  const get = (fields) =>
    axios.get(`${GRAPH_API}/${encodeURIComponent(id)}`, {
      params: { fields, access_token: accessToken },
      timeout: 4000,
    });
  try {
    let r;
    if (_igPicSupported) {
      try {
        r = await get("username,name,profile_pic");
      } catch {
        _igPicSupported = false;
        console.warn(
          "[Instagram] profile_pic unavailable for this app — name-only lookups from now on",
        );
        r = await get("username,name");
      }
    } else {
      r = await get("username,name");
    }
    const n = r.data?.username || r.data?.name;
    if (!n || /^\d{6,}$/.test(n)) return null;
    return { name: n, avatar: r.data?.profile_pic || null };
  } catch (err) {
    reportGraphError("instagram", err);
    return null;
  }
}

// ── Background profile healer ────────────────────────────────────────────────
// Conversations stored while a webhook-time lookup failed carry placeholder
// names ("User 1234", raw IDs, "Unknown"). This repairs them a few at a time
// and stores names/avatars on the conversation and the contact so the list
// routes can reuse them.
// Throttled: at most one run every 3 minutes, 10 sender lookups per run.
let _igHealRunning = false;
let _igLastHealAt = 0;
const IG_HEAL_INTERVAL_MS = 3 * 60 * 1000;

async function healInstagramProfiles() {
  if (_igHealRunning || Date.now() - _igLastHealAt < IG_HEAL_INTERVAL_MS) {
    return;
  }
  // No point querying the DB when lookups are permission-blocked
  if (isBlocked("instagram")) return;
  _igHealRunning = true;
  _igLastHealAt = Date.now();
  try {
    const accessToken =
      process.env.INSTAGRAM_ACCESS_TOKEN ||
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    if (!accessToken) return;

    const senderIds = await conversations.placeholderCustomers("instagram", 10);
    if (senderIds.length === 0) return;

    let healed = 0;
    for (const senderId of senderIds) {
      const profile = await lookupIgProfile(senderId, accessToken);
      if (!profile?.name) continue;
      // Conversation, identity and contact at once, so the avatar backfill
      // picks it up everywhere
      await conversations.updateProfile("instagram", senderId, {
        name: profile.name,
        avatar: profile.avatar,
      });
      healed++;
    }
    if (healed > 0) {
      clearIgCache(); // next poll reflects healed names/avatars
      console.log(`[Instagram] profile heal: repaired ${healed} sender(s)`);
    }
  } catch (err) {
    console.error("IG profile heal error (non-fatal):", err.message);
  } finally {
    _igHealRunning = false;
  }
}

async function fetchInstagramConversations(slim = false) {
  const accessToken =
    process.env.INSTAGRAM_ACCESS_TOKEN ||
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!accessToken || !pageId) {
    throw Object.assign(new Error("No access token configured"), {
      status: 400,
    });
  }

  console.log("Using Facebook Page ID:", pageId);

  // slim=true: request only 1 message per conversation (for the preview list).
  // This cuts the Graph API payload by ~95% and skips the DB upsert loop.
  const conversationFields = slim
    ? "participants{id,name,username,profile_pic},messages.limit(1){message,from,created_time}"
    : "participants{id,name,username,profile_pic},messages.limit(5){message,from,to,created_time,attachments}";
  const graphConversations = [];
  const seenConvIds = new Set();

  if (Date.now() < _igListBackoffUntil) {
    console.log(
      "[Instagram] conversations edge in backoff — serving DB-built list",
    );
  } else {
    const folders = ["inbox", "other"];
    let edgeFailed = false;
    for (const folder of folders) {
      let nextUrl = `${GRAPH_API}/${pageId}/conversations`;
      let params = {
        platform: "instagram",
        folder,
        fields: conversationFields,
        limit: 10,
        access_token: accessToken,
      };
      const maxPages = 1;
      for (let page = 0; page < maxPages; page++) {
        try {
          const convRes =
            page === 0
              ? await axios.get(nextUrl, {
                  params,
                  timeout: IG_LIST_TIMEOUT_MS,
                })
              : await axios.get(nextUrl, { timeout: IG_LIST_TIMEOUT_MS });
          const pageData = convRes.data.data || [];
          for (const conv of pageData) {
            if (!seenConvIds.has(conv.id)) {
              seenConvIds.add(conv.id);
              graphConversations.push(conv);
            }
          }
          nextUrl = convRes.data.paging?.next;
          if (!nextUrl || pageData.length === 0) break;
        } catch (folderErr) {
          edgeFailed = true;
          console.error(
            `Instagram folder=${folder} page=${page} error:`,
            folderErr.response?.data?.error?.message || folderErr.message,
          );
          break;
        }
      }
      // A dead edge fails identically for every folder — don't pay the
      // timeout twice
      if (edgeFailed && graphConversations.length === 0) break;
    }
    if (edgeFailed && graphConversations.length === 0) {
      _igListBackoffUntil = Date.now() + IG_LIST_BACKOFF_MS;
      console.warn(
        `[Instagram] conversations edge unusable — DB-only list for ${IG_LIST_BACKOFF_MS / 60000} min`,
      );
    }
  }

  console.log(
    `Instagram API returned ${graphConversations.length} conversations total`,
  );

  // Resolve the IG Business Account ID (uses env var or auto-discovers via API).
  // This ensures participant filtering always excludes the correct account ID even
  // if INSTAGRAM_ACCOUNT_ID is not set in the environment.
  let igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
  if (!igAccountId) {
    try {
      igAccountId = await resolveIgAccountId(accessToken, pageId);
    } catch {
      // Non-fatal: fall back to undefined — filtering will only exclude by pageId
    }
  }

  // --- Pass 1: build formatted list from Graph API response ---
  // Threads to store (full mode only) and thread ids to record, both written
  // after the list is built, without holding up the response.
  const threadSyncs = [];
  const threadLinks = [];
  const ownIds = metaOwnIds("instagram", [igAccountId, pageId]);
  const formatted = graphConversations.map((conv) => {
    const participants = conv.participants?.data || [];
    const messages = conv.messages?.data || [];
    const lastMessage = messages[0];

    const otherParticipants = participants.filter(
      (p) => p.id !== igAccountId && p.id !== pageId,
    );

    // nameMap: participant id → best available name (username preferred over display name)
    const nameMap = {};
    participants.forEach((p) => {
      const best = p.username || p.name;
      if (best && !/^\d{6,}$/.test(best)) nameMap[p.id] = best;
    });

    const resolveFromName = (fromObj) =>
      fromObj?.username || fromObj?.name || nameMap[fromObj?.id] || null;

    // The thread id of a listed customer is recorded, so the thread key
    // resolves to that customer's conversation later
    const customerId = otherParticipants[0]?.id;
    if (customerId) threadLinks.push({ customerId, threadId: conv.id });

    // Skip DB sync in slim mode — we only need the lastMessage preview
    if (!slim && messages.length > 0) {
      threadSyncs.push({
        platform: "instagram",
        graphMessages: messages,
        ownIds,
        customerId,
        threadId: conv.id,
        customerName: customerId ? nameMap[customerId] : undefined,
      });
    }

    return {
      id: conv.id,
      participants: otherParticipants.map((p) => ({
        id: p.id,
        name: p.username || p.name || null, // null signals "needs resolution"
        profilePicUrl: p.profile_pic || null,
      })),
      lastMessage: lastMessage
        ? {
            text: lastMessage.message || "[Attachment]",
            from: resolveFromName(lastMessage.from),
            time: lastMessage.created_time,
          }
        : null,
      // slim mode: omit messages array — frontend lazy-loads on conversation select
      messages: slim
        ? []
        : messages.map((m) => ({
            id: m.id,
            text: m.message || "",
            from: resolveFromName(m.from),
            fromId: m.from?.id,
            to: m.to?.data?.[0]?.username || m.to?.data?.[0]?.name || "Unknown",
            time: m.created_time,
            attachments: m.attachments?.data || [],
          })),
      _nameMap: nameMap, // carry forward for resolution pass
    };
  });

  // Store what the list revealed (non-blocking)
  recordGraphListInBackground("instagram", threadLinks, threadSyncs);

  // --- Pass 2: supplementary lookup for participants still without a name ---
  // The Graph API sometimes omits username/name in the participants sub-fields.
  // For those, directly call /{igsid}?fields=username,name to get the real handle.
  const unknownIds = new Set();
  formatted.forEach((conv) => {
    conv.participants.forEach((p) => {
      if (!p.name) unknownIds.add(p.id);
    });
  });

  const resolvedExtra = {}; // id -> { name, avatar }
  if (unknownIds.size > 0) {
    // Cap at 10 lookups to prevent 50+ sequential Graph API calls from stalling the response
    const idsToLookup = [...unknownIds].slice(0, 10);
    await Promise.all(
      idsToLookup.map(async (id) => {
        const profile = await lookupIgProfile(id, accessToken);
        if (profile?.name) resolvedExtra[id] = profile;
      }),
    );
  }

  // Apply resolved names/avatars and clean up the temporary _nameMap
  formatted.forEach((conv) => {
    delete conv._nameMap;
    conv.participants = conv.participants.map((p) => ({
      ...p,
      name: p.name || resolvedExtra[p.id]?.name || `User ${p.id.slice(-4)}`,
      profilePicUrl: p.profilePicUrl || resolvedExtra[p.id]?.avatar || null,
    }));
    // Patch lastMessage.from and each message.from with resolved names
    if (conv.lastMessage && !conv.lastMessage.from) {
      conv.lastMessage.from = "Unknown";
    }
    conv.messages = conv.messages.map((m) => ({
      ...m,
      from: m.from || resolvedExtra[m.fromId]?.name || "Unknown",
    }));
  });

  // Merge in DB-only conversations. One entry per PERSON: a stored
  // conversation matches a Graph one through the thread id or the customer
  // id, and its id is the thread id once known, so /messages-paged reads the
  // whole thread either way.
  try {
    await mergeStoredConversations("instagram", formatted, {
      limit: 100,
      extra: resolvedExtra,
      flags: { _fromDb: true },
    });
  } catch (mergeErr) {
    console.error("DB merge non-fatal error:", mergeErr.message);
  }

  // --- Pass 3: fill remaining missing avatars from stored Contacts ---
  // Webhook-time profile lookups persist avatars on Contact; this reuses them
  // for DB-only conversations without any extra Graph API calls.
  const missingAvatars = new Set();
  formatted.forEach((c) => {
    (c.participants || []).forEach((p) => {
      if (!p.profilePicUrl && p.id) missingAvatars.add(p.id);
    });
  });
  if (missingAvatars.size > 0) {
    const avatarMap = await getContactAvatarMap("instagram", missingAvatars);
    formatted.forEach((c) => {
      c.participants = (c.participants || []).map((p) => ({
        ...p,
        profilePicUrl: p.profilePicUrl || avatarMap[p.id] || null,
      }));
    });
  }

  formatted.sort(
    (a, b) =>
      new Date(b.lastMessage?.time || 0) - new Date(a.lastMessage?.time || 0),
  );
  const result = formatted.slice(0, 50);
  if (slim) {
    _igCacheSlim = result;
    _igCacheSlimTime = Date.now();
  } else {
    _igCache = result;
    _igCacheTime = Date.now();
  }

  // Repair placeholder names / capture avatars in the background (throttled)
  setImmediate(healInstagramProfiles);

  return result;
}

// GET /api/instagram/account-info - Resolve and return the IG Business Account ID in use
router.get("/account-info", protect, async (req, res) => {
  try {
    const accessToken =
      process.env.INSTAGRAM_ACCESS_TOKEN ||
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;
    if (!accessToken || !pageId) {
      return res
        .status(400)
        .json({ message: "Access token or Page ID not configured" });
    }
    // Always re-check live from the API on this debug endpoint
    const liveRes = await axios.get(`${GRAPH_API}/${pageId}`, {
      params: {
        fields: "instagram_business_account,name",
        access_token: accessToken,
      },
      timeout: 5000,
    });
    return res.json({
      configuredIgAccountId:
        process.env.INSTAGRAM_ACCOUNT_ID || "(not set — will auto-discover)",
      cachedIgAccountId: _resolvedIgAccountId || "(not cached yet)",
      liveIgAccountId:
        liveRes.data?.instagram_business_account?.id || "(none linked)",
      facebookPageId: pageId,
      pageName: liveRes.data?.name,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to fetch account info",
      error: err.response?.data?.error?.message || err.message,
    });
  }
});

// GET /api/instagram/conversations - Fetch Instagram conversations
// Supports ?slim=1 for a lightweight list (no embedded messages — frontend lazy-loads them).
// Uses in-flight deduplication: if a fetch is already running, concurrent requests
// wait on the same promise instead of each launching a separate Graph API call.
router.get("/conversations", protect, async (req, res) => {
  const slim = req.query.slim === "1" || req.query.slim === "true";

  // Fast path: slim mode — separate cache, no name-healing side-effects
  if (slim) {
    if (_igCacheSlim && Date.now() - _igCacheSlimTime < IG_CACHE_TTL) {
      return res.json({ conversations: _igCacheSlim });
    }
    try {
      if (!_igFetchSlim) {
        _igFetchSlim = fetchInstagramConversations(true).finally(() => {
          _igFetchSlim = null;
        });
      }
      const result = await _igFetchSlim;
      return res.json({ conversations: result });
    } catch (slimErr) {
      console.error(
        "Slim IG fetch failed, falling back to full fetch:",
        slimErr.message,
      );
      // Fall through to the full fetch path below
    }
  }

  if (_igCache && Date.now() - _igCacheTime < IG_CACHE_TTL) {
    return res.json({ conversations: _igCache });
  }
  try {
    if (!_igFetch) {
      _igFetch = fetchInstagramConversations().finally(() => {
        _igFetch = null;
      });
    }
    const result = await _igFetch;
    return res.json({ conversations: result });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ message: error.message });
    }
    console.error(
      "Instagram API error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );

    // Fallback to DB-only conversations
    try {
      return res.json({
        conversations: await storedConversationList("instagram", 100),
      });
    } catch (dbErr) {
      console.error("DB fallback also failed:", dbErr.message);
    }

    return res.status(500).json({
      message: "Failed to fetch Instagram conversations",
      error: error.response?.data?.error?.message || error.message,
    });
  }
});

// GET /api/instagram/messages-paged
// Returns paginated messages for a specific conversation from the database.
// Cursor-based: pass `before` (ISO timestamp) to load messages older than that point.
// The conversation is found by either key the inbox may hold: the thread id
// (t_…) or the customer's IGSID (see server/db/conversations.js).
router.get("/messages-paged", protect, async (req, res) => {
  try {
    const { conversationId, participantId, limit = 30, before } = req.query;
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    const pageLimit = Math.min(Number(limit) || 30, 100);
    const safeConvId = sanitizeId(conversationId);
    const safePartId = sanitizeId(participantId);
    if (!safeConvId) {
      return res.status(400).json({ message: "Invalid conversationId" });
    }
    const keys = [safeConvId, safePartId].filter(Boolean);
    const stored = await conversations.findByKeys("instagram", keys);

    // --- Sync missing messages from Graph API on first page load ---
    // Only BLOCK on this when we have nothing local to show; if the thread
    // already has messages in the DB, respond immediately and let the sync
    // top up in the background. Hard 8 s timeout — Meta must never stall
    // the inbox.
    const syncThreadFromGraph = async () => {
      const accessToken =
        process.env.INSTAGRAM_ACCESS_TOKEN ||
        process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
      const pageId = process.env.FACEBOOK_PAGE_ID;
      let accountId = process.env.INSTAGRAM_ACCOUNT_ID;
      if (!accountId && accessToken && pageId) {
        try {
          accountId = await resolveIgAccountId(accessToken, pageId);
        } catch {}
      }
      if (!accessToken || !(accountId || pageId)) return;

      // A numeric id is the customer's IGSID (webhook keying); Graph history
      // lives under the thread id: the requested key when it is one, else
      // the one recorded on the conversation, else Meta's per-user lookup.
      const numeric = (id) => typeof id === "string" && /^\d+$/.test(id);
      const customerId =
        (numeric(safePartId) && safePartId) ||
        stored[0]?.customerId ||
        (numeric(safeConvId) && safeConvId) ||
        undefined;
      let fetchId = !numeric(safeConvId)
        ? safeConvId
        : stored[0] && !numeric(stored[0].externalId)
          ? stored[0].externalId
          : null;
      if (!fetchId && customerId) {
        fetchId = await resolveIgThreadId(customerId, accessToken, pageId);
      }
      if (!fetchId || !isValidGraphId(fetchId)) return;
      const convRes = await axios.get(`${GRAPH_API}/${encodeURIComponent(fetchId)}`, {
        params: {
          fields:
            "messages.limit(30){message,from,to,created_time,attachments}",
          access_token: accessToken,
        },
        timeout: 8000,
      });
      // Stored in the customer's conversation (found from the messages when
      // the inbox only knew the thread), awaited so the page read below
      // sees the rows
      await syncGraphMessages({
        platform: "instagram",
        graphMessages: convRes.data.messages?.data || [],
        ownIds: metaOwnIds("instagram", [accountId, pageId, _resolvedIgAccountId]),
        customerId,
        threadId: fetchId,
      });
    };

    let refreshSuggested = false;
    if (!before) {
      const hasLocal = await messages.anyIn(stored.map((c) => c.id));
      if (!hasLocal) {
        try {
          await syncThreadFromGraph();
        } catch (syncErr) {
          console.error(
            "Optional IG conversation sync failed:",
            syncErr.message,
          );
        }
      } else {
        // Local history exists: give a fast sync one beat to land in THIS
        // response; if Meta is slow, respond now and tell the client to
        // refetch once — otherwise messages that only exist on Meta's side
        // (sent from the phone, arrived while webhooks were down) stay
        // invisible until the conversation is reopened.
        const sync = syncThreadFromGraph()
          .then(() => "done")
          .catch((e) => {
            console.error("IG background thread sync failed:", e.message);
            return "failed";
          });
        const winner = await Promise.race([
          sync,
          new Promise((r) => setTimeout(r, 1000, "pending")),
        ]);
        if (winner === "pending") refreshSuggested = true;
      }
    }

    // Read again: the sync may have created the conversation or recorded
    // its thread id
    const found = await conversations.findByKeys("instagram", keys);
    const page = await messages.page(
      found.map((c) => c.id),
      { before, limit: pageLimit },
    );

    return res.json({
      messages: page.messages,
      hasMore: page.hasMore,
      refreshSuggested,
    });
  } catch (err) {
    console.error("IG messages-paged error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// POST /api/instagram/send - Send an Instagram message
// Body: { recipientId, message?, conversationId, attachment? }
// attachment = { url, name, mimeType, mediaType } from POST /api/uploads.
// Instagram only supports image / audio / video media (8MB img, 25MB a/v).
router.post("/send", protect, async (req, res) => {
  // Released in `finally` at the latest (see takeIgSendClaim).
  let releaseClaim = noopRelease;
  // Text part of a text + attachment send, once Meta accepted it.
  let acceptedText = null;
  // True once Meta accepted every part of the message.
  let allPartsSent = false;
  try {
    let { recipientId } = req.body;
    const { message, conversationId, attachment } = req.body;

    if (!message?.trim() && !attachment?.url) {
      return res
        .status(400)
        .json({ message: "message or attachment is required" });
    }
    // Meta rejects over-long text with an opaque parameter error, so check
    // here and tell the agent exactly how much to cut.
    if (message && message.length > TEXT_LIMITS.instagram) {
      return res.status(400).json({
        message:
          `Message trop long : ${message.length} caractères, la limite Instagram est ${TEXT_LIMITS.instagram}. ` +
          "Envoyez-le en deux fois.",
      });
    }
    if (
      attachment?.url &&
      !["image", "audio", "video"].includes(attachment.mediaType)
    ) {
      return res.status(400).json({
        message:
          "Instagram only supports image, audio, and video attachments — send documents via another channel.",
      });
    }
    // Fall back to the Facebook Page Access Token — it works for Instagram messaging
    // when the Instagram Business account is linked to the Facebook Page
    const accessToken =
      process.env.INSTAGRAM_ACCESS_TOKEN ||
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      return res.status(400).json({
        message:
          "No access token found. Set INSTAGRAM_ACCESS_TOKEN or FACEBOOK_PAGE_ACCESS_TOKEN in .env",
      });
    }

    // --- Conversation Lock Check ---
    // The inbox falls back to the conversation id when Meta gave it no
    // participant — normal for Instagram under Standard Access — which sends
    // a `t_…` thread id to an API that only accepts a person.
    const resolved = await resolveRecipientId(
      "instagram",
      recipientId,
      conversationId,
    );
    recipientId = resolved.id;

    const lockConvId = sanitizeId(conversationId) || sanitizeId(recipientId);
    if (!lockConvId) {
      return res.status(400).json({ message: "Invalid conversationId or recipientId" });
    }
    // Another agent's send on this conversation is still in flight: its lock
    // is not written yet, but it will be once Meta accepts the message.
    const myId = req.user._id.toString();
    const claimHolder = igSendClaimHolder(lockConvId);
    if (claimHolder && claimHolder !== myId && req.user.role !== "admin") {
      return res.status(403).json({
        message: "This conversation was just locked by another agent.",
      });
    }
    // Agents are auto-locked after a successful send: hold the conversation
    // for the duration of the send.
    if (req.user.role === "agent") {
      releaseClaim = takeIgSendClaim(lockConvId, myId) || noopRelease;
    }
    const existing = await conversations.resolve("instagram", [
      lockConvId,
      recipientId,
    ]);
    const existingLock = existing?.lockedBy ? existing : null;
    // No lock will be created: the claim is not needed.
    if (existingLock) releaseClaim();
    if (
      existingLock &&
      existingLock.lockedBy !== String(req.user._id) &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({
        message:
          "This conversation is locked to another agent. Only the assigned agent can reply.",
      });
    }
    // The auto-lock for agents is created further down, only once Meta has
    // accepted the message, so a failed send never assigns anyone.

    // Send via the Facebook Page ID endpoint — this works for both Instagram DMs
    // and Messenger when the Instagram Business Account is linked to the Page.
    // Using /{ig-account-id}/messages causes code 3 "capability" errors even with
    // correct scopes; /{page-id}/messages is the correct endpoint for this setup.
    console.log(
      "Instagram send - recipientId:",
      recipientId,
      "pageId:",
      pageId,
    );

    // Build message objects: optional text, then optional media.
    // Text and attachments must be separate messages on the Send API.
    const messagePayloads = [];
    if (message?.trim()) messagePayloads.push({ text: message });
    if (attachment?.url) {
      messagePayloads.push({
        attachment: {
          type: attachment.mediaType,
          payload: { url: attachment.url },
        },
      });
    }

    // Send via Page messages endpoint
    // Try RESPONSE first (within 24h window), fall back to HUMAN_AGENT tag (7-day window)
    let lastData = null;
    for (const payload of messagePayloads) {
      try {
        const r = await axios.post(
          `${GRAPH_API}/${pageId}/messages`,
          {
            recipient: { id: recipientId },
            message: payload,
            messaging_type: "RESPONSE",
          },
          { params: { access_token: accessToken } },
        );
        lastData = r.data;
      } catch (firstErr) {
        if (!_igHumanAgentApproved) throw firstErr;
        console.log(
          "Instagram RESPONSE send failed, trying HUMAN_AGENT:",
          firstErr.response?.data?.error?.message || firstErr.message,
        );
        try {
          const r = await axios.post(
            `${GRAPH_API}/${pageId}/messages`,
            {
              recipient: { id: recipientId },
              message: payload,
              tag: "HUMAN_AGENT",
              messaging_type: "MESSAGE_TAG",
            },
            { params: { access_token: accessToken } },
          );
          lastData = r.data;
        } catch (tagErr) {
          const tagError = tagErr.response?.data?.error;
          if (
            tagError?.code === 100 &&
            /cannot tag/i.test(tagError?.message || "")
          ) {
            _igHumanAgentApproved = false;
            console.warn(
              "[Instagram] HUMAN_AGENT tag not approved for this app — disabling the fallback",
            );
            throw firstErr; // report the real cause, not the tag rejection
          }
          throw tagErr;
        }
      }
      // Remember an accepted text part that is followed by an attachment: its
      // CRM row is only stored after the attachment call (see below).
      if (payload.text && messagePayloads.length > 1) {
        const mid = lastData?.message_id || null;
        if (mid) {
          acceptedText = { mid, recipientId, pageId, content: message };
          _igPendingTextMids.add(mid);
        }
      }
    }
    allPartsSent = true;

    const messageId = lastData?.message_id || lastData?.id || null;

    const storedAttachments = attachment?.url
      ? [
          {
            type: attachment.mediaType,
            url: attachment.url,
            name: attachment.name || null,
            mimeType: attachment.mimeType || null,
          },
        ]
      : [];

    // Save to database (non-blocking — don't let DB errors fail the response)
    let savedConversation = null;
    try {
      const saved = await storeIgCrmSend({
        messageId,
        recipientId,
        content: message || "",
        attachments: storedAttachments,
        sentBy: req.user?._id || null,
      });
      savedConversation = saved.conversation;
      // The text part lives in this row. If the echo webhook stored it under
      // its own id before this row existed, remove that copy.
      if (acceptedText && acceptedText.mid !== messageId) {
        await messages.deleteEchoCopy([saved.conversation.id], acceptedText.mid);
      }
    } catch (dbErr) {
      console.error("DB save error (non-fatal):", dbErr.message);
    }

    // Auto-lock on first reply (agents), now that Meta accepted the message.
    // The message is already delivered, so a lock failure here must never
    // fail the request: log it and answer with the normal success.
    if (!existingLock && req.user.role === "agent") {
      try {
        const target =
          savedConversation ||
          existing ||
          (await conversations.ensureForCustomer({
            platform: "instagram",
            customerId: recipientId,
          }));
        const locked = await conversations.lock(target.id, req.user._id);
        if (!locked) {
          // Another agent locked between our check and this write
          console.log(
            "[Instagram:Lock] Lock race detected after send (non-fatal)",
          );
        }
      } catch (lockErr) {
        console.error(
          "[Instagram:Lock] Lock creation failed after send (non-fatal):",
          lockErr.message,
        );
      }
    }
    releaseClaim();

    // Emit socket event so the UI updates in real-time
    const io = req.app.get("io");
    // Clear cache so the next poll returns fresh data with the sent message
    clearIgCache();
    if (io) {
      io.emit("messageSent", {
        platform: "instagram",
        message: {
          id: messageId,
          text: message || "",
          from: "You",
          fromId: pageId,
          time: new Date().toISOString(),
          attachments: storedAttachments,
        },
        conversationId: recipientId,
        recipientId: recipientId,
      });
    }

    return res.json({ success: true, messageId });
  } catch (error) {
    const apiError = error.response?.data?.error;
    console.error(
      "Instagram send error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );

    // Text + attachment send where Meta accepted the text but not the
    // attachment: the customer did receive the text, so store it (no lock:
    // the send as a whole failed) and show it in the inbox.
    if (acceptedText && !allPartsSent) {
      try {
        await storeIgCrmSend({
          messageId: acceptedText.mid,
          recipientId: acceptedText.recipientId,
          content: acceptedText.content || "",
          attachments: [],
          sentBy: req.user?._id || null,
        });
        clearIgCache();
        const io = req.app.get("io");
        if (io) {
          io.emit("messageSent", {
            platform: "instagram",
            message: {
              id: acceptedText.mid,
              text: acceptedText.content || "",
              from: "You",
              fromId: acceptedText.pageId,
              time: new Date().toISOString(),
              attachments: [],
            },
            conversationId: acceptedText.recipientId,
            recipientId: acceptedText.recipientId,
          });
        }
      } catch (dbErr) {
        console.error(
          "DB save error for the delivered text part (non-fatal):",
          dbErr.message,
        );
      }
    }

    // IG-specific: a wrong/stale Business Account ID. Clear the cache so the
    // next send re-discovers it, then fall through to the shared mapper.
    if (
      apiError?.code === 100 &&
      typeof apiError?.message === "string" &&
      apiError.message.includes("does not exist")
    ) {
      _resolvedIgAccountId = null;
    }
    // Development Mode / app-capability restriction is IG-specific enough to
    // keep its own guidance.
    if (apiError?.code === 3) {
      return res.status(400).json({
        message:
          "Instagram bloque cet envoi : l'app est en mode Développement ou n'a pas la capacité messagerie. " +
          "Ajoutez le destinataire comme Testeur (App Roles) ou passez l'App Review.",
        error: apiError?.message,
      });
    }

    // Everything else goes through the shared mapper, which ALWAYS carries
    // Meta's own wording through so no failure is a dead end.
    const described = describeMetaSendError(error, "instagram");
    return res.status(described.status).json(described);
  } finally {
    releaseClaim();
    if (acceptedText) _igPendingTextMids.delete(acceptedText.mid);
  }
});

// POST /api/instagram/extend-token - Exchange short-lived token for a 60-day token
// Admin only: the response carries a long-lived Page token, which works
// against the Graph API outside the app.
router.post("/extend-token", protect, authorize("admin"), async (req, res) => {
  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const shortToken = process.env.INSTAGRAM_ACCESS_TOKEN;

    if (!appId || !appSecret) {
      return res.status(400).json({
        message:
          "FACEBOOK_APP_ID or FACEBOOK_APP_SECRET not configured in .env",
      });
    }

    const response = await axios.get(`${GRAPH_API}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      },
    });

    const longLivedToken = response.data.access_token;
    const expiresIn = response.data.expires_in; // seconds (usually ~5184000 = 60 days)

    return res.json({
      success: true,
      longLivedToken,
      expiresIn,
      expiresInDays: Math.round(expiresIn / 86400),
      note: "Copy this token into your .env as INSTAGRAM_ACCESS_TOKEN (and WHATSAPP_ACCESS_TOKEN if same page)",
    });
  } catch (error) {
    console.error(
      "Token extension error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      message: "Failed to extend token",
      error: error.response?.data?.error?.message || error.message,
    });
  }
});

// GET /api/instagram/messages - Get stored messages from database
router.get("/messages", protect, async (req, res) => {
  try {
    return res.json({
      messages: await messages.recentOfPlatform("instagram", 100),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch messages" });
  }
});

function clearIgCache() {
  _igCache = null;
  _igCacheTime = 0;
  _igCacheSlim = null;
  _igCacheSlimTime = 0;
}

module.exports = router;
module.exports.clearCache = clearIgCache;
module.exports.isTextSendPending = isTextSendPending;
