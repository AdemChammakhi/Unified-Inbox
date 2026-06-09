const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { protect } = require("../middleware/auth");
const { sanitizeId, isValidGraphId } = require("../utils/sanitize");

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

// In-memory cache — avoids hitting the slow Graph API on every poll
let _igCache = null;
let _igCacheTime = 0;
const IG_CACHE_TTL = 5000; // 5 seconds
// Separate slim-mode cache (conversation list without embedded messages)
let _igCacheSlim = null;
let _igCacheSlimTime = 0;
// In-flight promise — ensures only ONE Graph API request runs at a time even if many
// clients ask concurrently (prevents thundering herd / rate-limit hammering)
let _igFetch = null;
let _igFetchSlim = null;

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
  const folders = ["inbox", "other"];

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
            ? await axios.get(nextUrl, { params })
            : await axios.get(nextUrl);
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
        console.error(
          `Instagram folder=${folder} page=${page} error:`,
          folderErr.response?.data?.error?.message || folderErr.message,
        );
        break;
      }
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
        const direction =
          m.from?.id === igAccountId || m.from?.id === pageId
            ? "outgoing"
            : "incoming";
        Message.findOneAndUpdate(
          { externalId: m.id },
          {
            $setOnInsert: {
              platform: "instagram",
              conversationId: conv.id,
              senderId: m.from?.id || "unknown",
              senderName: resolveFromName(m.from) || "Unknown",
              recipientId: m.to?.data?.[0]?.id || igAccountId,
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
          console.error("IG message sync error (non-fatal):", err.message),
        );
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

  // --- Pass 2: supplementary lookup for participants still without a name ---
  // The Graph API sometimes omits username/name in the participants sub-fields.
  // For those, directly call /{igsid}?fields=username,name to get the real handle.
  const unknownIds = new Set();
  formatted.forEach((conv) => {
    conv.participants.forEach((p) => {
      if (!p.name) unknownIds.add(p.id);
    });
  });

  const resolvedExtra = {};
  if (unknownIds.size > 0) {
    // Cap at 10 lookups to prevent 50+ sequential Graph API calls from stalling the response
    const idsToLookup = [...unknownIds].slice(0, 10);
    await Promise.all(
      idsToLookup.map(async (id) => {
        try {
          if (!isValidGraphId(id)) return;
          const r = await axios.get(`${GRAPH_API}/${encodeURIComponent(id)}`, {
            params: { fields: "username,name", access_token: accessToken },
            timeout: 4000,
          });
          const n = r.data?.username || r.data?.name;
          if (n && !/^\d{6,}$/.test(n)) resolvedExtra[id] = n;
        } catch {
          // non-fatal — will fall back to senderId partial display
        }
      }),
    );
  }

  // Apply resolved names and clean up the temporary _nameMap
  formatted.forEach((conv) => {
    delete conv._nameMap;
    conv.participants = conv.participants.map((p) => ({
      ...p,
      name: p.name || resolvedExtra[p.id] || `User ${p.id.slice(-4)}`,
    }));
    // Patch lastMessage.from and each message.from with resolved names
    if (conv.lastMessage && !conv.lastMessage.from) {
      conv.lastMessage.from = "Unknown";
    }
    conv.messages = conv.messages.map((m) => ({
      ...m,
      from: m.from || resolvedExtra[m.fromId] || "Unknown",
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
      .limit(500);

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
        ? resolvedExtra[m.senderId] || `User ${m.senderId.slice(-4)}`
        : m.senderName;
      if (!newConvMap[key]) {
        newConvMap[key] = {
          id: key,
          participants: [{ id: m.senderId, name: resolvedName }],
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

    // Background: patch any DB messages that have null or "Unknown" senderName
    // using the names we just resolved from the Graph API (non-blocking)
    setImmediate(async () => {
      try {
        const badMsgs = await Message.find({
          platform: "instagram",
          direction: "incoming",
          $or: [{ senderName: null }, { senderName: "Unknown" }],
        }).select("_id senderId");
        if (badMsgs.length === 0) return;
        const accessToken =
          process.env.INSTAGRAM_ACCESS_TOKEN ||
          process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
        if (!accessToken) return;
        const uniqueSenderIds = [...new Set(badMsgs.map((m) => m.senderId))];
        const nameUpdates = {};
        await Promise.all(
          uniqueSenderIds.map(async (id) => {
            try {
              const r = await axios.get(`${GRAPH_API}/${id}`, {
                params: { fields: "username,name", access_token: accessToken },
                timeout: 4000,
              });
              const n = r.data?.username || r.data?.name;
              if (n && !/^\d{6,}$/.test(n)) nameUpdates[id] = n;
            } catch {}
          }),
        );
        for (const [senderId, name] of Object.entries(nameUpdates)) {
          await Message.updateMany(
            {
              platform: "instagram",
              senderId,
              $or: [{ senderName: null }, { senderName: "Unknown" }],
            },
            { $set: { senderName: name } },
          );
        }
        if (Object.keys(nameUpdates).length > 0) {
          // Bust cache so the next fetch reflects the healed names
          _igCache = null;
          console.log(
            `IG name heal: patched ${Object.keys(nameUpdates).length} sender(s)`,
          );
        }
      } catch (healErr) {
        console.error("IG name heal error (non-fatal):", healErr.message);
      }
    });

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
        .limit(500);

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
    // --- NEW: Sync missing messages from Graph API on first page load ---
    if (!before && !/^\d+$/.test(conversationId)) {
      try {
        const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
        const accountId = process.env.INSTAGRAM_ACCOUNT_ID;
        if (accessToken && accountId && isValidGraphId(conversationId)) {
          const convRes = await axios.get(`${GRAPH_API}/${encodeURIComponent(conversationId)}`, {
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
              const direction =
                m.from?.id === accountId ? "outgoing" : "incoming";
              await Message.findOneAndUpdate(
                { externalId: m.id },
                {
                  $setOnInsert: {
                    platform: "instagram",
                    conversationId: conversationId,
                    senderId: m.from?.id || "unknown",
                    senderName: m.from?.name || "Unknown",
                    recipientId: m.to?.data?.[0]?.id || accountId,
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
        console.error("Optional IG conversation sync failed:", syncErr.message);
      }
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
    console.error("IG messages-paged error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// POST /api/instagram/send - Send an Instagram message
router.post("/send", protect, async (req, res) => {
  try {
    const { recipientId, message, conversationId } = req.body;
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

    // Send message via Page messages endpoint
    // Try RESPONSE first (within 24h window), fall back to HUMAN_AGENT tag (7-day window)
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
    } catch (firstErr) {
      console.log(
        "Instagram RESPONSE send failed, trying HUMAN_AGENT:",
        firstErr.response?.data?.error?.message || firstErr.message,
      );
      sendRes = await axios.post(
        `${GRAPH_API}/${pageId}/messages`,
        {
          recipient: { id: recipientId },
          message: { text: message },
          tag: "HUMAN_AGENT",
          messaging_type: "MESSAGE_TAG",
        },
        {
          params: { access_token: accessToken },
        },
      );
    }

    const messageId = sendRes.data.message_id || sendRes.data.id || null;

    // Save to database (non-blocking — don't let DB errors fail the response)
    try {
      await Message.create({
        platform: "instagram",
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
    // Clear cache so the next poll returns fresh data with the sent message
    clearIgCache();
    if (io) {
      io.emit("messageSent", {
        platform: "instagram",
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
      "Instagram send error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );

    // Detect app capability / Development Mode restriction (code 3)
    if (apiError?.code === 3) {
      return res.status(400).json({
        message:
          "Instagram messaging is blocked by the Meta App configuration. " +
          "Most likely cause: the app is in Development Mode and the recipient is not an App Tester. " +
          "Fix: add the recipient as a Tester at developers.facebook.com → App Roles, " +
          "or complete Meta App Review to switch to Live Mode.",
        error: apiError?.message,
      });
    }

    // Detect 24-hour window error
    if (apiError?.code === 10 || apiError?.error_subcode === 2534022) {
      return res.status(400).json({
        message:
          "Cannot send: the 24-hour messaging window has expired. The user must message you first before you can reply.",
        error: apiError?.message,
      });
    }

    // Detect "Object does not exist / wrong IG Account ID" error (code 100)
    // Reset the cached ID so the next call re-discovers it from the Graph API
    if (
      apiError?.code === 100 &&
      typeof apiError?.message === "string" &&
      apiError.message.includes("does not exist")
    ) {
      _resolvedIgAccountId = null;
      return res.status(400).json({
        message:
          `Instagram Business Account ID may be misconfigured (used: ${igAccountId}). ` +
          "The cached ID has been cleared and will be re-discovered on next send. " +
          "Verify INSTAGRAM_ACCOUNT_ID in .env matches the IG Professional Account linked to your Facebook Page.",
        error: apiError?.message,
      });
    }

    return res.status(500).json({
      message: "Failed to send message",
      error: apiError?.message || error.message,
    });
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
      .limit(100);
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
