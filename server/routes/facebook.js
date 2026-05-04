const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { protect } = require("../middleware/auth");

const GRAPH_API = "https://graph.facebook.com/v24.0";

function isLikelyRawId(value) {
  return typeof value === "string" && /^\d{6,}$/.test(value);
}

async function resolveFacebookProfileName(senderId, accessToken) {
  if (!senderId || !accessToken || senderId === "unknown") return null;
  try {
    const res = await axios.get(`${GRAPH_API}/${senderId}`, {
      params: {
        fields: "first_name,last_name,name",
        access_token: accessToken,
      },
      timeout: 5000,
    });
    const resolvedName =
      res.data.name ||
      [res.data.first_name, res.data.last_name].filter(Boolean).join(" ");
    if (!resolvedName || isLikelyRawId(resolvedName)) return null;
    return resolvedName;
  } catch {
    return null;
  }
}

async function getBestDisplayName({
  senderId,
  senderName,
  accessToken,
  nameCache,
}) {
  if (senderName && !isLikelyRawId(senderName)) return senderName;
  if (!senderId || senderId === "unknown") return "Unknown";
  if (nameCache.has(senderId)) return nameCache.get(senderId);

  const resolved = await resolveFacebookProfileName(senderId, accessToken);
  const finalName = resolved || "Unknown";
  nameCache.set(senderId, finalName);
  return finalName;
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

      return {
        id: conv.id,
        participants: otherParticipants.map((p) => ({
          id: p.id,
          name: p.name || "Unknown",
        })),
        lastMessage: lastMessage
          ? {
              text: lastMessage.message || "[Attachment]",
              from: lastMessage.from?.name || "Unknown",
              time: lastMessage.created_time,
            }
          : null,
        messages: messages.map((m) => ({
          id: m.id,
          text: m.message || "",
          from: m.from?.name || "Unknown",
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
      const nameCache = new Map();
      for (const m of recentDbMsgs) {
        if (knownIds.has(m.senderId) || knownIds.has(m.conversationId))
          continue;
        const key = m.conversationId || m.senderId;
        const displayName = await getBestDisplayName({
          senderId: m.senderId,
          senderName: m.senderName,
          accessToken,
          nameCache,
        });
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
      const nameCache = new Map();
      for (const m of dbMessages) {
        const incomingDisplayName = await getBestDisplayName({
          senderId: m.senderId,
          senderName: m.senderName,
          accessToken,
          nameCache,
        });
        if (!convMap[m.conversationId]) {
          convMap[m.conversationId] = {
            id: m.conversationId,
            participants: [
              {
                id: m.direction === "incoming" ? m.senderId : m.recipientId,
                name:
                  m.direction === "incoming"
                    ? incomingDisplayName
                    : m.recipientId,
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
    console.error(
      "Facebook send error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );
    return res.status(500).json({
      message: "Failed to send message",
      error: error.response?.data?.error?.message || error.message,
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

module.exports = router;
