const express = require("express");
const axios = require("axios");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { noteDispatchReply } = require("../utils/dispatching");
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

const { describeMetaSendError, TEXT_LIMITS } = require("../utils/metaSendError");
const { resolveRecipientId } = require("../utils/resolveRecipient");

const GRAPH_API = "https://graph.facebook.com/v24.0";

// HUMAN_AGENT extends the reply window to 7 days but needs its own App
// Review approval. Once Meta rejects the tag we stop attempting it, so
// out-of-window sends fail fast with the real reason (window expired).
let _fbHumanAgentApproved = true;

// ── In-flight send claims ────────────────────────────────────────────────────
// The auto-lock is written only after Meta accepted the message, so the time
// between the lock check and the lock creation spans the whole send. A claim
// taken before the lock check and released once the lock is written (or the
// send failed) keeps a second agent out of that window, as the unique lock
// index did when the lock was created before sending. Production runs one
// backend process, so an in-memory map is enough.
const _fbSendClaims = new Map(); // lockConvId -> { userId, count }
const noopRelease = () => {};

function fbSendClaimHolder(key) {
  return _fbSendClaims.get(key)?.userId || null;
}

/**
 * Take the claim on a conversation (shared when the same user already holds
 * it, e.g. two quick sends). Returns an idempotent release function, or null
 * when another user holds the claim.
 */
function takeFbSendClaim(key, userId) {
  const uid = String(userId);
  const held = _fbSendClaims.get(key);
  if (held && held.userId !== uid) return null;
  if (held) held.count += 1;
  else _fbSendClaims.set(key, { userId: uid, count: 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = _fbSendClaims.get(key);
    if (!current || current.userId !== uid) return;
    current.count -= 1;
    if (current.count <= 0) _fbSendClaims.delete(key);
  };
}

// ── Text parts waiting for their CRM row ────────────────────────────────────
// A text + attachment send is two Meta messages but ONE CRM row, stored under
// the attachment's id once both calls are done. While that row is not stored,
// the text part's message id is listed here, and the echo webhook
// (routes/webhooks.js) waits instead of storing the text a second time.
const _fbPendingTextMids = new Set();

function isTextSendPending(mid) {
  return _fbPendingTextMids.has(mid);
}

/**
 * Store a message the CRM sent, following the dedupe contract with the echo
 * webhook (routes/webhooks.js). With Meta's message id, a row the echo stored
 * first (no CRM sender) is claimed instead of duplicated. Without an id, a
 * plain insert.
 * @returns {Promise<{conversation: object, inserted: boolean}>}
 */
function storeFbCrmSend({ messageId, recipientId, content, attachments, sentBy }) {
  return storeCrmSend({
    platform: "facebook",
    customerId: recipientId,
    externalId: messageId,
    content,
    attachments,
    userId: sentBy,
  });
}

// ── Sender → thread-id resolution ───────────────────────────────────────────
// Webhook-created conversations are keyed by the sender's numeric PSID, but
// Graph history lives under the thread id (t_…). The per-user lookup
// (?user_id=) is light and targeted. Successes cache forever (thread ids are
// stable); failures back off for 10 minutes.
const _fbThreadIdCache = new Map(); // senderId -> { threadId|null, at }
const FB_THREAD_FAIL_TTL = 10 * 60 * 1000;
const FB_THREAD_CACHE_MAX = 500;

async function resolveFbThreadId(senderId, accessToken, pageId) {
  const cached = _fbThreadIdCache.get(senderId);
  if (
    cached &&
    (cached.threadId || Date.now() - cached.at < FB_THREAD_FAIL_TTL)
  ) {
    return cached.threadId;
  }
  let threadId = null;
  try {
    const r = await axios.get(`${GRAPH_API}/${pageId}/conversations`, {
      params: {
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
  if (_fbThreadIdCache.size >= FB_THREAD_CACHE_MAX) {
    _fbThreadIdCache.delete(_fbThreadIdCache.keys().next().value);
  }
  _fbThreadIdCache.set(senderId, { threadId, at: Date.now() });
  return threadId;
}

// In-memory cache — avoids slow Graph API calls on every request.
// 15 s is safe: webhooks and /send bust the cache via clearFbCache(), so
// real-time updates still surface immediately; this only throttles polling.
let _fbCache = null;
let _fbCacheTime = 0;
const FB_CACHE_TTL = 45000; // 45 s — webhooks clear it on new traffic
// Separate slim-mode cache (conversation list without embedded messages)
let _fbCacheSlim = null;
let _fbCacheSlimTime = 0;
// In-flight dedup — one Graph API request at a time
let _fbFetch = null;
let _fbFetchSlim = null;

async function fetchFacebookConversations(slim = false) {
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!accessToken || !pageId) {
    throw Object.assign(
      new Error(
        "FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_PAGE_ID missing in .env",
      ),
      { status: 400 },
    );
  }

  console.log("Fetching Facebook conversations for Page:", pageId);

  // slim=true: only 1 message per conversation for the preview list.
  const msgFields = slim
    ? "messages.limit(1){message,from,created_time}"
    : "messages.limit(20){message,from,to,created_time,attachments}";

  // Fetch conversations from the Page
  // Paginate to get all conversations (new ones may not be on the first page)
  let graphConversations = [];
  let nextUrl = `${GRAPH_API}/${pageId}/conversations`;
  let params = {
    fields: `participants{id,name,picture{url}},${msgFields}`,
    limit: 50,
    access_token: accessToken,
  };
  const maxPages = 1;
  for (let page = 0; page < maxPages; page++) {
    // Hard timeout — a degraded Graph edge must never stall the inbox
    const convRes =
      page === 0
        ? await axios.get(nextUrl, { params, timeout: 10000 })
        : await axios.get(nextUrl, { timeout: 10000 });
    const pageData = convRes.data.data || [];
    graphConversations = graphConversations.concat(pageData);
    nextUrl = convRes.data.paging?.next;
    if (!nextUrl || pageData.length === 0) break;
  }
  console.log(`Facebook API returned ${graphConversations.length} conversations`);

  // Format conversations
  // Threads to store (full mode only) and thread ids to record, both written
  // after the list is built, without holding up the response.
  const threadSyncs = [];
  const threadLinks = [];
  const ownIds = metaOwnIds("facebook", [pageId]);
  const formatted = graphConversations.map((conv) => {
    const participants = conv.participants?.data || [];
    const messages = conv.messages?.data || [];
    const lastMessage = messages[0];

    // Filter out the Page from participants to show only the user
    const otherParticipants = participants.filter((p) => p.id !== pageId);

    // The thread id of a listed customer is recorded, so the thread key
    // resolves to that customer's conversation later
    const customerId = otherParticipants[0]?.id;
    if (customerId) threadLinks.push({ customerId, threadId: conv.id });

    // Skip DB sync in slim mode — we only need the lastMessage preview
    if (!slim && messages.length > 0) {
      threadSyncs.push({
        platform: "facebook",
        graphMessages: messages,
        ownIds,
        customerId,
        threadId: conv.id,
        customerName: otherParticipants[0]?.name,
      });
    }

    // Build a name map from participants so messages with empty from.name
    // still resolve to the real person's name (Graph API sometimes omits
    // from.name even when participants[].name is populated)
    const participantMap = {};
    participants.forEach((p) => {
      if (p.id && p.name) participantMap[p.id] = p.name;
    });

    const resolveMsgFrom = (fromObj) => {
      if (!fromObj) return "Unknown";
      return (
        fromObj.name ||
        participantMap[fromObj.id] ||
        (fromObj.id === pageId ? "Page" : "Unknown")
      );
    };

    return {
      id: conv.id,
      participants: otherParticipants.map((p) => ({
        id: p.id,
        name: p.name || "Unknown",
        profilePicUrl: p.picture?.data?.url || null,
      })),
      lastMessage: lastMessage
        ? {
            text: lastMessage.message || "[Attachment]",
            from: resolveMsgFrom(lastMessage.from),
            time: lastMessage.created_time,
          }
        : null,
      // slim mode: omit messages array — frontend lazy-loads on conversation select
      messages: slim
        ? []
        : messages.map((m) => ({
            id: m.id,
            text: m.message || "",
            from: resolveMsgFrom(m.from),
            fromId: m.from?.id,
            to: m.to?.data?.[0]?.name || "Unknown",
            time: m.created_time,
            attachments: m.attachments?.data || [],
          })),
    };
  });

  // Store what the list revealed (non-blocking)
  recordGraphListInBackground("facebook", threadLinks, threadSyncs);

  // --- Merge in DB-only conversations (new senders the Graph API hasn't returned yet) ---
  // One entry per PERSON — see the Instagram route for why: a stored
  // conversation matches a Graph one through the thread id or the customer id.
  try {
    const merged = await mergeStoredConversations("facebook", formatted, {
      limit: 100,
    });
    if (merged > 0) {
      console.log(`Merging ${merged} DB-only Facebook conversation(s)`);
    }
  } catch (mergeErr) {
    console.error("DB merge non-fatal error:", mergeErr.message);
  }

  // Fill remaining missing avatars from stored Contacts (populated at
  // webhook time) — no extra Graph API calls.
  const missingAvatars = new Set();
  formatted.forEach((c) => {
    (c.participants || []).forEach((p) => {
      if (!p.profilePicUrl && p.id) missingAvatars.add(p.id);
    });
  });
  if (missingAvatars.size > 0) {
    const avatarMap = await getContactAvatarMap("facebook", missingAvatars);
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
    _fbCacheSlim = result;
    _fbCacheSlimTime = Date.now();
  } else {
    _fbCache = result;
    _fbCacheTime = Date.now();
  }
  return result;
}

function clearFbCache() {
  _fbCache = null;
  _fbCacheTime = 0;
  _fbCacheSlim = null;
  _fbCacheSlimTime = 0;
}

// GET /api/facebook/conversations - Fetch Facebook Page conversations
// Supports ?slim=1 for a lightweight list (no embedded messages — frontend lazy-loads them).
// Uses in-memory cache (2 min TTL) and in-flight dedup like Instagram.
router.get("/conversations", protect, async (req, res) => {
  const slim = req.query.slim === "1" || req.query.slim === "true";

  // Fast path: slim mode — separate cache, skips DB sync side-effects
  if (slim) {
    if (_fbCacheSlim && Date.now() - _fbCacheSlimTime < FB_CACHE_TTL) {
      return res.json({ conversations: _fbCacheSlim });
    }
    try {
      if (!_fbFetchSlim) {
        _fbFetchSlim = fetchFacebookConversations(true).finally(() => {
          _fbFetchSlim = null;
        });
      }
      const result = await _fbFetchSlim;
      return res.json({ conversations: result });
    } catch (slimErr) {
      console.error(
        "Slim FB fetch failed, falling back to full fetch:",
        slimErr.message,
      );
      // Fall through to full fetch path below
    }
  }

  if (_fbCache && Date.now() - _fbCacheTime < FB_CACHE_TTL) {
    return res.json({ conversations: _fbCache });
  }
  try {
    if (!_fbFetch) {
      _fbFetch = fetchFacebookConversations().finally(() => {
        _fbFetch = null;
      });
    }
    const result = await _fbFetch;
    return res.json({ conversations: result });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ message: error.message });
    }
    console.error(
      "Facebook API error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );

    // If the Graph API fails, fall back to conversations built from the local DB
    try {
      return res.json({
        conversations: await storedConversationList("facebook", 100),
      });
    } catch (dbErr) {
      console.error("DB fallback also failed:", dbErr.message);
    }

    return res.status(500).json({
      message: "Failed to fetch Facebook conversations",
      error: error.response?.data?.error?.message || error.message,
    });
  }
});

// GET /api/facebook/messages-paged
// Returns paginated messages for a specific conversation from the database.
// Cursor-based: pass `before` (ISO timestamp) to load messages older than that point.
// The conversation is found by either key the inbox may hold: the thread id
// (t_…) or the customer's PSID (see server/db/conversations.js).
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
    const stored = await conversations.findByKeys("facebook", keys);

    // --- Sync missing messages from Graph API on first page load ---
    // Only BLOCK when the thread has nothing local; otherwise respond now
    // and top up in the background. 8 s hard timeout.
    const syncThreadFromGraph = async () => {
      const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
      const pageId = process.env.FACEBOOK_PAGE_ID;
      if (!accessToken || !pageId) return;

      // A numeric id is the customer's PSID (webhook keying); Graph history
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
        fetchId = await resolveFbThreadId(customerId, accessToken, pageId);
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
        platform: "facebook",
        graphMessages: convRes.data.messages?.data || [],
        ownIds: metaOwnIds("facebook", [pageId]),
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
            "Optional FB conversation sync failed:",
            syncErr.message,
          );
        }
      } else {
        // Local history exists: give a fast sync one beat to land in THIS
        // response; if Meta is slow, respond now and tell the client to
        // refetch once — otherwise messages that only exist on Meta's side
        // stay invisible until the conversation is reopened.
        const sync = syncThreadFromGraph()
          .then(() => "done")
          .catch((e) => {
            console.error("FB background thread sync failed:", e.message);
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
    const found = await conversations.findByKeys("facebook", keys);
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
    console.error("FB messages-paged error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// POST /api/facebook/send - Send a Facebook Messenger message
// Body: { recipientId, message?, conversationId, attachment? }
// attachment = { url, name, mimeType, mediaType } from POST /api/uploads.
router.post("/send", protect, async (req, res) => {
  // Released in `finally` at the latest (see takeFbSendClaim).
  let releaseClaim = noopRelease;
  // Text part of a text + attachment send, once Meta accepted it.
  let acceptedText = null;
  // True once Meta accepted every part of the message.
  let allPartsSent = false;
  try {
    let { recipientId } = req.body;
    const { message, conversationId, attachment } = req.body;
    const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      return res.status(400).json({
        message:
          "FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_PAGE_ID missing in .env",
      });
    }
    if (!message?.trim() && !attachment?.url) {
      return res
        .status(400)
        .json({ message: "message or attachment is required" });
    }
    // Meta rejects over-long text with an opaque parameter error, so check
    // here and tell the agent exactly how much to cut.
    if (message && message.length > TEXT_LIMITS.facebook) {
      return res.status(400).json({
        message:
          `Message trop long : ${message.length} caractères, la limite Messenger est ${TEXT_LIMITS.facebook}. ` +
          "Envoyez-le en deux fois.",
      });
    }

    // --- Conversation Lock Check ---
    // Same repair as Instagram: never hand Meta a thread id as the recipient.
    const resolved = await resolveRecipientId(
      "facebook",
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
    const claimHolder = fbSendClaimHolder(lockConvId);
    if (claimHolder && claimHolder !== myId && req.user.role !== "admin") {
      return res.status(403).json({
        message: "This conversation was just locked by another agent.",
      });
    }
    // Agents are auto-locked after a successful send: hold the conversation
    // for the duration of the send.
    if (req.user.role === "agent") {
      releaseClaim = takeFbSendClaim(lockConvId, myId) || noopRelease;
    }
    const existing = await conversations.resolve("facebook", [
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

    // Build the Send API message objects: optional text, then optional media.
    // Messenger requires text and attachments to be separate messages.
    const messagePayloads = [];
    if (message?.trim()) messagePayloads.push({ text: message });
    if (attachment?.url) {
      const fbType = ["image", "video", "audio"].includes(attachment.mediaType)
        ? attachment.mediaType
        : "file";
      messagePayloads.push({
        attachment: {
          type: fbType,
          payload: { url: attachment.url, is_reusable: true },
        },
      });
    }

    // Send via Messenger Send API
    // First try RESPONSE (within 24h window), then fall back to HUMAN_AGENT tag (7-day window)
    console.log(
      `Facebook send — pageId=${pageId} recipientId=${recipientId} msgLen=${message?.length} attachment=${attachment?.mediaType || "none"}`,
    );
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
      } catch (sendErr) {
        const errData = sendErr.response?.data?.error;
        // Error code 10 / subcode 2018278 = outside the 24h allowed window
        const windowExpired =
          errData?.code === 10 || errData?.error_subcode === 2018278;
        if (!windowExpired) throw sendErr;
        // Don't retry a tag Meta already told us is unapproved — surface
        // the window error directly instead.
        if (!_fbHumanAgentApproved) throw sendErr;
        console.log(
          "24h window expired, retrying with HUMAN_AGENT message tag...",
        );
        try {
          const r = await axios.post(
            `${GRAPH_API}/${pageId}/messages`,
            {
              recipient: { id: recipientId },
              message: payload,
              messaging_type: "MESSAGE_TAG",
              tag: "HUMAN_AGENT",
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
            _fbHumanAgentApproved = false;
            console.warn(
              "[Facebook] HUMAN_AGENT tag not approved for this app — disabling the fallback",
            );
            throw sendErr; // report the real cause: the 24h window
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
          _fbPendingTextMids.add(mid);
        }
      }
    }
    allPartsSent = true;

    const messageId = lastData?.message_id || lastData?.id || null;

    const storedAttachments = attachment?.url
      ? [
          {
            type: ["image", "video", "audio"].includes(attachment.mediaType)
              ? attachment.mediaType
              : "file",
            url: attachment.url,
            name: attachment.name || null,
            mimeType: attachment.mimeType || null,
          },
        ]
      : [];

    // Save to database (non-blocking — don't let DB errors fail the response)
    let savedConversation = null;
    try {
      const saved = await storeFbCrmSend({
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

    // A dispatched agent's first answer: the admin's board shows it as started
    noteDispatchReply("facebook", [lockConvId, recipientId], req.user._id);

    // Auto-lock on first reply (agents), now that Meta accepted the message.
    // The message is already delivered, so a lock failure here must never
    // fail the request: log it and answer with the normal success.
    if (!existingLock && req.user.role === "agent") {
      try {
        const target =
          savedConversation ||
          existing ||
          (await conversations.ensureForCustomer({
            platform: "facebook",
            customerId: recipientId,
          }));
        const locked = await conversations.lock(target.id, req.user._id);
        if (!locked) {
          // Another agent locked between our check and this write
          console.log(
            "[Facebook:Lock] Lock race detected after send (non-fatal)",
          );
        }
      } catch (lockErr) {
        console.error(
          "[Facebook:Lock] Lock creation failed after send (non-fatal):",
          lockErr.message,
        );
      }
    }
    releaseClaim();

    // Emit socket event so the UI updates in real-time
    const io = req.app.get("io");
    // Clear cache so the next poll includes the sent message
    clearFbCache();
    if (io) {
      io.emit("messageSent", {
        platform: "facebook",
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
      "Facebook send error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );

    // Text + attachment send where Meta accepted the text but not the
    // attachment: the customer did receive the text, so store it (no lock:
    // the send as a whole failed) and show it in the inbox.
    if (acceptedText && !allPartsSent) {
      try {
        await storeFbCrmSend({
          messageId: acceptedText.mid,
          recipientId: acceptedText.recipientId,
          content: acceptedText.content || "",
          attachments: [],
          sentBy: req.user?._id || null,
        });
        clearFbCache();
        const io = req.app.get("io");
        if (io) {
          io.emit("messageSent", {
            platform: "facebook",
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

    // Every case goes through the shared mapper, which ALWAYS carries Metas
    // own wording through so no failure is a dead end for the agent.
    const described = describeMetaSendError(error, "facebook");
    return res.status(described.status).json(described);
  } finally {
    releaseClaim();
    if (acceptedText) _fbPendingTextMids.delete(acceptedText.mid);
  }
});

// GET /api/facebook/messages - Get stored Facebook messages from database
router.get("/messages", protect, async (req, res) => {
  try {
    return res.json({
      messages: await messages.recentOfPlatform("facebook", 100),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch messages" });
  }
});

// GET /api/facebook/diagnose — check token health, permissions, page subscription
router.get("/diagnose", protect, async (req, res) => {
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const result = { pageId, hasToken: !!accessToken };

  try {
    // 1. Who does this token belong to?
    const meRes = await axios.get(`${GRAPH_API}/me`, {
      params: { access_token: accessToken, fields: "id,name" },
    });
    result.tokenOwner = meRes.data;
    result.isPageToken = meRes.data.id === pageId;
  } catch (e) {
    result.tokenOwnerError = e.response?.data?.error || e.message;
  }

  try {
    // 2. What permissions does the token have?
    const permRes = await axios.get(`${GRAPH_API}/me/permissions`, {
      params: { access_token: accessToken },
    });
    result.permissions = permRes.data.data
      .filter((p) => p.status === "granted")
      .map((p) => p.permission);
  } catch (e) {
    result.permissionsError = e.response?.data?.error || e.message;
  }

  try {
    // 3. Is the app subscribed to the page?
    const subRes = await axios.get(`${GRAPH_API}/${pageId}/subscribed_apps`, {
      params: { access_token: accessToken },
    });
    result.subscribedApps = subRes.data.data;
  } catch (e) {
    result.subscribedAppsError = e.response?.data?.error || e.message;
  }

  try {
    // 4. Can we fetch conversations?
    const convRes = await axios.get(`${GRAPH_API}/${pageId}/conversations`, {
      params: { access_token: accessToken, limit: 1, fields: "participants" },
    });
    result.conversationsAccessible = true;
    result.sampleParticipants = convRes.data.data?.[0]?.participants?.data;
  } catch (e) {
    result.conversationsAccessible = false;
    result.conversationsError = e.response?.data?.error || e.message;
  }

  return res.json(result);
});

module.exports = router;
module.exports.clearCache = clearFbCache;
module.exports.isTextSendPending = isTextSendPending;
