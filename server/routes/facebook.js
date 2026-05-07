const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { protect } = require("../middleware/auth");

const GRAPH_API = "https://graph.facebook.com/v24.0";

// Returns a display-friendly name from what is already stored in the DB.
// Does NOT make any external API calls — name resolution happens once at
// webhook-receive time (webhooks.js getSenderName) and is persisted then.
function resolveStoredName(senderName) {
  if (!senderName) return "Unknown";
  // If the stored value looks like a raw numeric Facebook/Instagram ID, ignore it
  if (/^\d{6,}$/.test(senderName)) return "Unknown";
  return senderName;
}

// GET /api/facebook/conversations - Fetch Facebook Page conversations
router.get("/conversations", protect, async (req, res) => {
  try {
    const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      return res.status(400).json({
        message:
          "FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_PAGE_ID missing in .env",
      });
    }

    console.log("Fetching Facebook conversations for Page:", pageId);

    // Fetch conversations from the Page
    // Paginate to get all conversations (new ones may not be on the first page)
    let conversations = [];
    let nextUrl = `${GRAPH_API}/${pageId}/conversations`;
    let params = {
      fields: "participants,messages{message,from,to,created_time,attachments}",
      limit: 60,
      access_token: accessToken,
    };
    const maxPages = 3;
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

      // Sync all messages to database (non-blocking)
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
        })),
        lastMessage: lastMessage
          ? {
              text: lastMessage.message || "[Attachment]",
              from: resolveMsgFrom(lastMessage.from),
              time: lastMessage.created_time,
            }
          : null,
        messages: messages.map((m) => ({
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
        direction: "incoming",
      })
        .sort({ timestamp: -1 })
        .limit(200);

      const newConvMap = {};
      for (const m of recentDbMsgs) {
        if (knownIds.has(m.senderId) || knownIds.has(m.conversationId))
          continue;
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

    return res.json({ conversations: formatted });
  } catch (error) {
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
      await ConversationLock.create({
        conversationId: lockConvId,
        platform: "facebook",
        lockedBy: req.user._id,
      });
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
      });
    } catch (dbErr) {
      console.error("DB save error (non-fatal):", dbErr.message);
    }

    // Emit socket event so the UI updates in real-time
    const io = req.app.get("io");
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
