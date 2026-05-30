const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { protect } = require("../middleware/auth");

const GRAPH_API = "https://graph.facebook.com/v24.0";

// In-memory cache — avoids slow Graph API calls on every request
let _fbCache = null;
let _fbCacheTime = 0;
const FB_CACHE_TTL = 5000; // 5 seconds
// Separate slim-mode cache (conversation list without embedded messages)
let _fbCacheSlim = null;
let _fbCacheSlimTime = 0;
// In-flight dedup — one Graph API request at a time
let _fbFetch = null;
let _fbFetchSlim = null;

// Returns a display-friendly name from what is already stored in the DB.
// Does NOT make any external API calls — name resolution happens once at
// webhook-receive time (webhooks.js getSenderName) and is persisted then.
function resolveStoredName(senderName) {
  if (!senderName) return "Unknown";
  // If the stored value looks like a raw numeric Facebook/Instagram ID, ignore it
  if (/^\d{6,}$/.test(senderName)) return "Unknown";
  return senderName;
}

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
  let conversations = [];
  let nextUrl = `${GRAPH_API}/${pageId}/conversations`;
  let params = {
    fields: `participants{id,name,picture{url}},${msgFields}`,
    limit: 50,
    access_token: accessToken,
  };
  const maxPages = 1;
  for (let page = 0; page < maxPages; page++) {
    const convRes =
      page === 0
        ? await axios.get(nextUrl, { params })
        : await axios.get(nextUrl);
    const pageData = convRes.data.data || [];
    conversations = conversations.concat(pageData);
    nextUrl = convRes.data.paging?.next;
    if (!nextUrl || pageData.length === 0) break;
  }
  console.log(`Facebook API returned ${conversations.length} conversations`);

  // Format conversations
  const formatted = conversations.map((conv) => {
    const participants = conv.participants?.data || [];
    const messages = conv.messages?.data || [];
    const lastMessage = messages[0];

    // Filter out the Page from participants to show only the user
    const otherParticipants = participants.filter((p) => p.id !== pageId);

    // Skip DB sync in slim mode — we only need the lastMessage preview
    if (!slim) {
      for (const m of messages) {
        const direction = m.from?.id === pageId ? "outgoing" : "incoming";
        Message.findOneAndUpdate(
          { externalId: m.id },
          {
            $setOnInsert: {
              platform: "facebook",
              conversationId: conv.id,
              senderId: m.from?.id || "unknown",
              senderName: m.from?.name || "Unknown",
              recipientId: m.to?.data?.[0]?.id || pageId,
              content: m.message || "",
              messageType: m.attachments ? "attachment" : "text",
              direction,
              status: direction === "outgoing" ? "sent" : "delivered",
              externalId: m.id,
              timestamp: m.created_time,
            },
          },
          { upsert: true },
        ).catch((err) =>
          console.error("FB message sync error (non-fatal):", err.message),
        );
      }
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

  // --- Merge in DB-only conversations (new senders the Graph API hasn't returned yet) ---
  try {
    const knownIds = new Set();
    formatted.forEach((c) => {
      knownIds.add(c.id);
      c.participants.forEach((p) => knownIds.add(p.id));
    });

    const recentDbMsgs = await Message.find({
      platform: "facebook",
    })
      .sort({ timestamp: -1 })
      .limit(200);

    // Build a map of key (conversationId/senderId) -> latest message in DB
    const dbLatestMap = {};
    for (const m of recentDbMsgs) {
      const key = m.conversationId || m.senderId;
      const displayName = resolveStoredName(m.senderName);
      if (!dbLatestMap[key]) {
        dbLatestMap[key] = {
          text: m.content || "",
          from: displayName,
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
      const displayName = resolveStoredName(m.senderName);
      if (!newConvMap[key]) {
        newConvMap[key] = {
          id: key,
          participants: [{ id: m.senderId, name: displayName }],
          lastMessage: null,
          messages: [],
        };
      }
      const conv = newConvMap[key];
      const msg = {
        id: m.externalId || m._id.toString(),
        text: m.content || "",
        from: displayName,
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

    const dbOnlyConvs = Object.values(newConvMap);
    if (dbOnlyConvs.length > 0) {
      console.log(
        `Merging ${dbOnlyConvs.length} DB-only Facebook conversation(s)`,
      );
      formatted.unshift(...dbOnlyConvs);
    }
  } catch (mergeErr) {
    console.error("DB merge non-fatal error:", mergeErr.message);
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
      const dbMessages = await Message.find({ platform: "facebook" })
        .sort({ timestamp: -1 })
        .limit(500);

      const convMap = {};
      for (const m of dbMessages) {
        const incomingDisplayName = resolveStoredName(m.senderName);
        if (!convMap[m.conversationId]) {
          convMap[m.conversationId] = {
            id: m.conversationId,
            participants: [
              {
                id: m.direction === "incoming" ? m.senderId : m.recipientId,
                name: m.direction === "incoming" ? incomingDisplayName : "Page",
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
          from: m.direction === "incoming" ? incomingDisplayName : "Page",
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
      message: "Failed to fetch Facebook conversations",
      error: error.response?.data?.error?.message || error.message,
    });
  }
});

// GET /api/facebook/messages-paged
// Returns paginated messages for a specific conversation from MongoDB.
// Cursor-based: pass `before` (ISO timestamp) to load messages older than that point.
router.get("/messages-paged", protect, async (req, res) => {
  try {
    const { conversationId, participantId, limit = 30, before } = req.query;
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    const pageLimit = Math.min(Number(limit) || 30, 100);
    // --- NEW: Sync missing messages from Graph API on first page load ---
    if (!before && !/^\d+$/.test(conversationId)) {
      try {
        const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
        const pageId = process.env.FACEBOOK_PAGE_ID;
        if (accessToken && pageId) {
          const convRes = await axios.get(`${GRAPH_API}/${conversationId}`, {
            params: {
              fields:
                "messages.limit(30){message,from,to,created_time,attachments}",
              access_token: accessToken,
            },
          });
          const msgs = convRes.data.messages?.data || [];

          // Wait for all DB insertions to finish so the following find() gets them
          await Promise.all(
            msgs.map(async (m) => {
              const direction = m.from?.id === pageId ? "outgoing" : "incoming";
              await Message.findOneAndUpdate(
                { externalId: m.id },
                {
                  $setOnInsert: {
                    platform: "facebook",
                    conversationId: conversationId,
                    senderId: m.from?.id || "unknown",
                    senderName: m.from?.name || "Unknown",
                    recipientId: m.to?.data?.[0]?.id || pageId,
                    content: m.message || "",
                    messageType: m.attachments ? "attachment" : "text",
                    direction,
                    status: direction === "outgoing" ? "sent" : "delivered",
                    externalId: m.id,
                    timestamp: m.created_time,
                  },
                },
                { upsert: true },
              );
            }),
          );
        }
      } catch (syncErr) {
        console.error("Optional FB conversation sync failed:", syncErr.message);
      }
    }
    // Webhook messages are saved with conversationId = senderId (PSID).
    // API-synced messages are saved with conversationId = Graph API conv.id (e.g. "t_…").
    // Accept both so we never miss webhook-saved messages when the user opens a conversation.
    const convIdFilter =
      participantId && participantId !== conversationId
        ? { $in: [conversationId, participantId] }
        : conversationId;
    const query = { platform: "facebook", conversationId: convIdFilter };
    if (before) query.timestamp = { $lt: new Date(before) };

    const messages = await Message.find(query)
      .sort({ timestamp: -1 })
      .limit(pageLimit)
      .lean();

    return res.json({
      messages: messages.reverse().map((m) => ({
        id: m.externalId || m._id.toString(),
        text: m.content || "",
        from: m.senderName || "Unknown",
        fromId: m.senderId,
        time: m.timestamp || m.createdAt,
        direction: m.direction,
        messageType: m.messageType,
        attachmentUrl: m.attachmentUrl || null,
      })),
      hasMore: messages.length === pageLimit,
    });
  } catch (err) {
    console.error("FB messages-paged error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// POST /api/facebook/send - Send a Facebook Messenger message
router.post("/send", protect, async (req, res) => {
  try {
    const { recipientId, message, conversationId } = req.body;
    const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      return res.status(400).json({
        message:
          "FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_PAGE_ID missing in .env",
      });
    }

    // --- Conversation Lock Check ---
    const lockConvId = conversationId || recipientId;
    const existingLock = await ConversationLock.findOne({
      conversationId: lockConvId,
      platform: "facebook",
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
          platform: "facebook",
          lockedBy: req.user._id,
        });
      } catch (lockErr) {
        // Duplicate key: another agent locked between our check and create
        if (lockErr.code === 11000) {
          const raceLock = await ConversationLock.findOne({
            conversationId: lockConvId,
            platform: "facebook",
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

    // Send message via Messenger Send API
    // First try RESPONSE (within 24h window), then fall back to HUMAN_AGENT tag (7-day window)
    console.log(
      `Facebook send — pageId=${pageId} recipientId=${recipientId} msgLen=${message?.length}`,
    );
    let sendRes;
    try {
      sendRes = await axios.post(
        `${GRAPH_API}/${pageId}/messages`,
        {
          recipient: { id: recipientId },
          message: { text: message },
          messaging_type: "RESPONSE",
        },
        {
          params: { access_token: accessToken },
        },
      );
    } catch (sendErr) {
      const errData = sendErr.response?.data?.error;
      // Error code 10 / subcode 2018278 = outside the 24h allowed window
      if (errData?.code === 10 || errData?.error_subcode === 2018278) {
        console.log(
          "24h window expired, retrying with HUMAN_AGENT message tag...",
        );
        sendRes = await axios.post(
          `${GRAPH_API}/${pageId}/messages`,
          {
            recipient: { id: recipientId },
            message: { text: message },
            messaging_type: "MESSAGE_TAG",
            tag: "HUMAN_AGENT",
          },
          {
            params: { access_token: accessToken },
          },
        );
      } else {
        throw sendErr;
      }
    }

    const messageId = sendRes.data.message_id || sendRes.data.id || null;

    // Save to database (non-blocking — don't let DB errors fail the response)
    try {
      await Message.create({
        platform: "facebook",
        conversationId: recipientId,
        senderId: pageId,
        senderName: "Page",
        recipientId: recipientId,
        content: message,
        messageType: "text",
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
    // Clear cache so the next poll includes the sent message
    clearFbCache();
    if (io) {
      io.emit("messageSent", {
        platform: "facebook",
        message: {
          id: messageId,
          text: message,
          from: "You",
          fromId: pageId,
          time: new Date().toISOString(),
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
    return res.status(500).json({
      message: "Failed to send message",
      error: apiError?.message || error.message,
      code: apiError?.code,
      subcode: apiError?.error_subcode,
      type: apiError?.type,
    });
  }
});

// GET /api/facebook/messages - Get stored Facebook messages from database
router.get("/messages", protect, async (req, res) => {
  try {
    const messages = await Message.find({ platform: "facebook" })
      .sort({ timestamp: -1 })
      .limit(100);
    return res.json({ messages });
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
