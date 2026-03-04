const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { protect } = require("../middleware/auth");

const GRAPH_API = "https://graph.facebook.com/v24.0";

// GET /api/instagram/conversations - Fetch Instagram conversations
router.get("/conversations", protect, async (req, res) => {
  try {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      return res.status(400).json({
        message: "INSTAGRAM_ACCESS_TOKEN or FACEBOOK_PAGE_ID missing in .env",
      });
    }

    console.log("Using Facebook Page ID:", pageId);

    // Fetch conversations using the Facebook Page ID (not Instagram Account ID)
    const convRes = await axios.get(`${GRAPH_API}/${pageId}/conversations`, {
      params: {
        platform: "instagram",
        fields:
          "participants,messages{message,from,to,created_time,attachments}",
        access_token: accessToken,
      },
    });

    const conversations = convRes.data.data || [];

    // Format conversations
    const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
    const formatted = conversations.map((conv) => {
      const participants = conv.participants?.data || [];
      const messages = conv.messages?.data || [];
      const lastMessage = messages[0];

      // Filter out the page's own Instagram account so participants[0] is always the other user
      const otherParticipants = participants.filter(
        (p) => p.id !== igAccountId && p.id !== pageId,
      );

      // Build a name lookup from participants
      const nameMap = {};
      participants.forEach((p) => {
        nameMap[p.id] = p.username || p.name || "Unknown";
      });

      // Sync all messages to database (non-blocking)
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
              senderName:
                m.from?.username ||
                m.from?.name ||
                nameMap[m.from?.id] ||
                "Unknown",
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

      return {
        id: conv.id,
        participants: otherParticipants.map((p) => ({
          id: p.id,
          name: p.username || p.name || "Unknown",
        })),
        lastMessage: lastMessage
          ? {
              text: lastMessage.message || "[Attachment]",
              from:
                lastMessage.from?.username ||
                lastMessage.from?.name ||
                "Unknown",
              time: lastMessage.created_time,
            }
          : null,
        messages: messages.map((m) => ({
          id: m.id,
          text: m.message || "",
          from: m.from?.username || m.from?.name || "Unknown",
          fromId: m.from?.id,
          to: m.to?.data?.[0]?.username || m.to?.data?.[0]?.name || "Unknown",
          time: m.created_time,
          attachments: m.attachments?.data || [],
        })),
      };
    });

    return res.json({ conversations: formatted });
  } catch (error) {
    console.error(
      "Instagram API error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );
    return res.status(500).json({
      message: "Failed to fetch Instagram conversations",
      error: error.response?.data?.error?.message || error.message,
    });
  }
});

// POST /api/instagram/send - Send an Instagram message
router.post("/send", protect, async (req, res) => {
  try {
    const { recipientId, message, conversationId } = req.body;
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      return res.status(400).json({
        message: "INSTAGRAM_ACCESS_TOKEN or FACEBOOK_PAGE_ID missing in .env",
      });
    }

    // --- Conversation Lock Check ---
    const lockConvId = conversationId || recipientId;
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
      await ConversationLock.create({
        conversationId: lockConvId,
        platform: "instagram",
        lockedBy: req.user._id,
      });
    }

    console.log(
      "Instagram send - recipientId:",
      recipientId,
      "pageId:",
      pageId,
    );

    // Send message via Instagram Messaging API
    const sendRes = await axios.post(
      `${GRAPH_API}/${pageId}/messages`,
      {
        recipient: { id: recipientId },
        message: { text: message },
      },
      {
        params: { access_token: accessToken },
      },
    );

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
      });
    } catch (dbErr) {
      console.error("DB save error (non-fatal):", dbErr.message);
    }

    // Emit socket event so the UI updates in real-time
    const io = req.app.get("io");
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

    // Detect 24-hour window error
    if (apiError?.code === 10 || apiError?.error_subcode === 2534022) {
      return res.status(400).json({
        message:
          "Cannot send: the 24-hour messaging window has expired. The user must message you first before you can reply.",
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

module.exports = router;
