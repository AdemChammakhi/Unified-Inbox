const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { Contact } = require("../models");
const { protect } = require("../middleware/auth");
const { sanitizeId, isValidGraphId } = require("../utils/sanitize");
const {
  parseGraphAttachments,
  messageTypeFor,
} = require("../utils/metaPayload");
const { getContactAvatarMap } = require("../services/conversationService");
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
const IG_CACHE_TTL = 15000; // 15 seconds
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
// Messages stored while a webhook-time lookup failed carry placeholder names
// ("User 1234", raw IDs, "Unknown"). This repairs them a few at a time and
// stores names/avatars on the Contact so the list routes can reuse them.
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

    const badNameFilter = {
      $or: [
        { senderName: null },
        { senderName: "Unknown" },
        { senderName: /^User \d{4}$/ },
        { senderName: /^\d{6,}$/ },
      ],
    };
    const badMsgs = await Message.find({
      platform: "instagram",
      direction: "incoming",
      ...badNameFilter,
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .select("senderId")
      .lean();
    if (badMsgs.length === 0) return;

    const senderIds = [...new Set(badMsgs.map((m) => m.senderId))].slice(0, 10);
    let healed = 0;
    for (const senderId of senderIds) {
      const profile = await lookupIgProfile(senderId, accessToken);
      if (!profile?.name) continue;
      await Message.updateMany(
        { platform: "instagram", senderId, ...badNameFilter },
        { $set: { senderName: profile.name } },
      );
      // Persist on the Contact so avatar backfill picks it up everywhere
      await Contact.findOrCreateByPlatformId("instagram", senderId, {
        name: profile.name,
        avatar: profile.avatar,
      }).catch(() => {});
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
  let conversations = [];
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
              conversations.push(conv);
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
      if (edgeFailed && conversations.length === 0) break;
    }
    if (edgeFailed && conversations.length === 0) {
      _igListBackoffUntil = Date.now() + IG_LIST_BACKOFF_MS;
      console.warn(
        `[Instagram] conversations edge unusable — DB-only list for ${IG_LIST_BACKOFF_MS / 60000} min`,
      );
    }
  }

  console.log(
    `Instagram API returned ${conversations.length} conversations total`,
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
  // Collected across all conversations and flushed as ONE bulkWrite below
  // instead of firing an individual findOneAndUpdate per message.
  const syncOps = [];
  const formatted = conversations.map((conv) => {
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

    // Skip DB sync in slim mode — we only need the lastMessage preview
    if (!slim) {
      for (const m of messages) {
        if (!m.id) continue;
        const direction =
          m.from?.id === igAccountId || m.from?.id === pageId
            ? "outgoing"
            : "incoming";
        const graphAtts = parseGraphAttachments(m.attachments);
        syncOps.push({
          updateOne: {
            filter: { externalId: m.id },
            update: {
              $setOnInsert: {
                platform: "instagram",
                conversationId: conv.id,
                senderId: m.from?.id || "unknown",
                senderName: resolveFromName(m.from) || "Unknown",
                recipientId: m.to?.data?.[0]?.id || igAccountId,
                content: m.message || "",
                messageType: messageTypeFor(graphAtts),
                attachments: graphAtts,
                direction,
                status: direction === "outgoing" ? "sent" : "delivered",
                externalId: m.id,
                timestamp: m.created_time,
              },
            },
            upsert: true,
          },
        });
      }
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

  // Flush the DB sync as a single unordered bulk upsert (non-blocking)
  if (syncOps.length > 0) {
    Message.bulkWrite(syncOps, { ordered: false }).catch((err) =>
      console.error("IG message sync error (non-fatal):", err.message),
    );
  }

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

  // Merge in DB-only conversations
  try {
    const knownIds = new Set();
    formatted.forEach((c) => {
      knownIds.add(c.id);
      c.participants.forEach((p) => knownIds.add(p.id));
    });

    const recentDbMsgs = await Message.find({ platform: "instagram" })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    // Build a map of key (conversationId/senderId) -> latest message in DB
    const dbLatestMap = {};
    for (const m of recentDbMsgs) {
      const key = m.conversationId || m.senderId;
      if (!dbLatestMap[key]) {
        dbLatestMap[key] = {
          text: m.content || "",
          from: m.senderName || "Unknown",
          time: m.timestamp || m.createdAt,
        };
      }
    }

    // Update Graph API conversations if DB has a newer message
    formatted.forEach((c) => {
      let dbLatest = dbLatestMap[c.id];
      if (!dbLatest) {
        // Try participant IDs
        for (const p of c.participants || []) {
          if (dbLatestMap[p.id]) {
            dbLatest = dbLatestMap[p.id];
            break;
          }
        }
      }

      if (dbLatest) {
        const serverTime = new Date(c.lastMessage?.time || 0).getTime();
        const dbTime = new Date(dbLatest.time).getTime();
        if (dbTime > serverTime) {
          c.lastMessage = dbLatest;
        }
      }
    });

    const newConvMap = {};
    for (const m of recentDbMsgs) {
      if (knownIds.has(m.senderId) || knownIds.has(m.conversationId)) continue;
      const key = m.conversationId || m.senderId;
      // Resolve name: prefer stored name, then supplementary lookup, then partial ID
      const isUnknown =
        !m.senderName ||
        m.senderName === "Unknown" ||
        /^\d{6,}$/.test(m.senderName);
      const resolvedName = isUnknown
        ? resolvedExtra[m.senderId]?.name || `User ${m.senderId.slice(-4)}`
        : m.senderName;
      if (!newConvMap[key]) {
        newConvMap[key] = {
          id: key,
          participants: [
            {
              id: m.senderId,
              name: resolvedName,
              profilePicUrl: resolvedExtra[m.senderId]?.avatar || null,
            },
          ],
          lastMessage: null,
          messages: [],
          _fromDb: true,
        };
      }
      const conv = newConvMap[key];
      const msg = {
        id: m.externalId || m._id.toString(),
        text: m.content || "",
        from: m.senderName || "Unknown",
        fromId: m.senderId,
        time: m.timestamp || m.createdAt,
        direction: m.direction,
      };
      conv.messages.push(msg);
      if (
        !conv.lastMessage ||
        new Date(msg.time) > new Date(conv.lastMessage.time)
      ) {
        conv.lastMessage = { text: msg.text, from: msg.from, time: msg.time };
      }
    }

    const dbOnlyConvs = Object.values(newConvMap);
    if (dbOnlyConvs.length > 0) {
      formatted.unshift(...dbOnlyConvs);
    }
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
      const dbMessages = await Message.find({ platform: "instagram" })
        .sort({ timestamp: -1 })
        .limit(500)
        .lean();

      const convMap = {};
      for (const m of dbMessages) {
        const isUnknown =
          !m.senderName ||
          m.senderName === "Unknown" ||
          /^\d{6,}$/.test(m.senderName);
        const displayName = isUnknown
          ? `User ${m.senderId.slice(-4)}`
          : m.senderName;
        if (!convMap[m.conversationId]) {
          convMap[m.conversationId] = {
            id: m.conversationId,
            participants: [
              {
                id: m.direction === "incoming" ? m.senderId : m.recipientId,
                name: m.direction === "incoming" ? displayName : "Page",
              },
            ],
            lastMessage: null,
            messages: [],
          };
        }
        const conv = convMap[m.conversationId];
        const msg = {
          id: m.externalId || m._id.toString(),
          text: m.content || "",
          from: m.senderName || "Unknown",
          fromId: m.senderId,
          time: m.timestamp || m.createdAt,
        };
        conv.messages.push(msg);
        if (
          !conv.lastMessage ||
          new Date(msg.time) > new Date(conv.lastMessage.time)
        ) {
          conv.lastMessage = { text: msg.text, from: msg.from, time: msg.time };
        }
      }

      return res.json({ conversations: Object.values(convMap) });
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
// Returns paginated messages for a specific conversation from MongoDB.
// Cursor-based: pass `before` (ISO timestamp) to load messages older than that point.
// Uses the messages_paged index: { platform, conversationId, timestamp -1 }.
router.get("/messages-paged", protect, async (req, res) => {
  try {
    const { conversationId, participantId, limit = 30, before } = req.query;
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    const pageLimit = Math.min(Number(limit) || 30, 100);
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

      if (accessToken && (accountId || pageId) && isValidGraphId(conversationId)) {
          // Numeric id = webhook keying (the sender's IGSID). Graph history
          // lives under the t_… thread id — resolve it, but keep STORING
          // under the requested id so webhook and synced rows share a key.
          let fetchId = conversationId;
          if (/^\d+$/.test(conversationId)) {
            fetchId = await resolveIgThreadId(
              conversationId,
              accessToken,
              pageId,
            );
            if (!fetchId) return;
          }
          const convRes = await axios.get(`${GRAPH_API}/${encodeURIComponent(fetchId)}`, {
            params: {
              fields:
                "messages.limit(30){message,from,to,created_time,attachments}",
              access_token: accessToken,
            },
            timeout: 8000,
          });
          const msgs = convRes.data.messages?.data || [];

          // One awaited bulk upsert so the following find() sees the rows,
          // without 30 parallel round-trips to MongoDB.
          const pageSyncOps = msgs
            .filter((m) => m.id)
            .map((m) => {
              const isOutgoing =
                m.from?.id &&
                (m.from.id === accountId ||
                  m.from.id === pageId ||
                  m.from.id === _resolvedIgAccountId);
              const direction = isOutgoing ? "outgoing" : "incoming";
              const senderName = isOutgoing
                ? "Page"
                : m.from?.username || m.from?.name || "Unknown";
              const graphAtts = parseGraphAttachments(m.attachments);
              return {
                updateOne: {
                  filter: { externalId: m.id },
                  update: {
                    $setOnInsert: {
                      platform: "instagram",
                      conversationId: conversationId,
                      senderId: m.from?.id || "unknown",
                      senderName,
                      recipientId: m.to?.data?.[0]?.id || accountId || pageId,
                      content: m.message || "",
                      messageType: messageTypeFor(graphAtts),
                      attachments: graphAtts,
                      direction,
                      status: direction === "outgoing" ? "sent" : "delivered",
                      externalId: m.id,
                      timestamp: m.created_time,
                    },
                  },
                  upsert: true,
                },
              };
            });
          if (pageSyncOps.length > 0) {
            await Message.bulkWrite(pageSyncOps, { ordered: false });
          }
      }
    };

    let refreshSuggested = false;
    if (!before) {
      const hasLocal = await Message.exists({
        platform: "instagram",
        conversationId: sanitizeId(conversationId) || "-",
      });
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
          new Promise((r) => setTimeout(r, 2500, "pending")),
        ]);
        if (winner === "pending") refreshSuggested = true;
      }
    }

    const pageId = process.env.FACEBOOK_PAGE_ID;
    const accountId = process.env.INSTAGRAM_ACCOUNT_ID || _resolvedIgAccountId;

    // Heal existing DB records where outgoing messages were saved as incoming
    if (pageId || accountId) {
      Message.updateMany(
        {
          platform: "instagram",
          direction: "incoming",
          $or: [
            ...(pageId ? [{ senderId: pageId }] : []),
            ...(accountId ? [{ senderId: accountId }] : []),
            { senderName: "Page" },
            { senderName: "You" },
          ],
        },
        { $set: { direction: "outgoing" } }
      ).catch(() => {});
    }

    // Webhook messages are saved with conversationId = senderId (the participant's IGSID).
    // API-synced messages are saved with conversationId = Graph API conv.id (e.g. "t_…").
    // Accept both so we never miss webhook-saved messages when the user opens a conversation.
    const safeConvId = sanitizeId(conversationId);
    const safePartId = sanitizeId(participantId);
    if (!safeConvId) {
      return res.status(400).json({ message: "Invalid conversationId" });
    }
    const convIdFilter =
      safePartId && safePartId !== safeConvId
        ? { $in: [safeConvId, safePartId] }
        : safeConvId;
    const query = { platform: "instagram", conversationId: convIdFilter };
    if (before) query.timestamp = { $lt: new Date(before) };

    const messages = await Message.find(query)
      .sort({ timestamp: -1 })
      .limit(pageLimit)
      .lean();

    return res.json({
      messages: messages.reverse().map((m) => {
        const isOutgoing =
          m.direction === "outgoing" ||
          (pageId && m.senderId === pageId) ||
          (accountId && m.senderId === accountId) ||
          m.senderName === "Page" ||
          m.senderName === "You";
        return {
          id: m.externalId || m._id.toString(),
          text: m.content || "",
          from: isOutgoing ? "Page" : m.senderName || "Unknown",
          fromId: m.senderId,
          time: m.timestamp || m.createdAt,
          direction: isOutgoing ? "outgoing" : "incoming",
          messageType: m.messageType,
          attachmentUrl: m.attachmentUrl || null,
          attachments: m.attachments || [],
          context: m.context || null,
        };
      }),
      hasMore: messages.length === pageLimit,
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
    const existingLock = await ConversationLock.findOne({
      conversationId: lockConvId,
      platform: "instagram",
    });
    if (
      existingLock &&
      existingLock.lockedBy.toString() !== req.user._id.toString() &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({
        message:
          "This conversation is locked to another agent. Only the assigned agent can reply.",
      });
    }
    // Auto-lock on first reply (marketing agents)
    if (!existingLock && req.user.role === "marketing") {
      try {
        await ConversationLock.create({
          conversationId: lockConvId,
          platform: "instagram",
          lockedBy: req.user._id,
        });
      } catch (lockErr) {
        // Duplicate key: another agent locked between our check and create
        if (lockErr.code === 11000) {
           const raceLock = await ConversationLock.findOne({
            conversationId: lockConvId,
            platform: "instagram",
          });
          if (
            raceLock &&
            raceLock.lockedBy.toString() !== req.user._id.toString()
          ) {
            return res.status(403).json({
              message: "This conversation was just locked by another agent.",
            });
          }
        } else {
          throw lockErr;
        }
      }
    }

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
    }

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
    try {
      await Message.create({
        platform: "instagram",
        conversationId: recipientId,
        senderId: pageId,
        senderName: "Page",
        recipientId: recipientId,
        content: message || "",
        messageType: messageTypeFor(storedAttachments),
        attachments: storedAttachments,
        direction: "outgoing",
        status: "sent",
        externalId: messageId,
        sentBy: req.user?._id || null,
      });
    } catch (dbErr) {
      console.error("DB save error (non-fatal):", dbErr.message);
    }

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
  }
});

// POST /api/instagram/extend-token - Exchange short-lived token for a 60-day token
router.post("/extend-token", protect, async (req, res) => {
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
    const messages = await Message.find({ platform: "instagram" })
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();
    return res.json({ messages });
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
