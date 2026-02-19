const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const { protect } = require("../middleware/auth");

const GRAPH_API = "https://graph.facebook.com/v21.0";

// GET /api/instagram/conversations - Fetch Instagram conversations
router.get("/conversations", protect, async (req, res) => {
  try {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;

    let igAccountId;

    // Detect token type and get Instagram account ID
    if (accessToken.startsWith("IG")) {
      // Instagram User Token - call /me directly on Instagram Graph API
      const meRes = await axios.get(`${GRAPH_API}/me`, {
        params: {
          fields: "id,username",
          access_token: accessToken,
        },
      });
      igAccountId = meRes.data.id;
    } else {
      // Facebook Page Token - get linked Instagram business account
      const meRes = await axios.get(`${GRAPH_API}/me`, {
        params: {
          fields: "instagram_business_account",
          access_token: accessToken,
        },
      });
      igAccountId = meRes.data.instagram_business_account?.id;
    }

    if (!igAccountId) {
      return res
        .status(400)
        .json({ message: "No Instagram Business Account found" });
    }

    console.log("Instagram Account ID:", igAccountId);

    // Fetch conversations
    const convRes = await axios.get(
      `${GRAPH_API}/${igAccountId}/conversations`,
      {
        params: {
          platform: "instagram",
          fields:
            "participants,messages{message,from,to,created_time,attachments}",
          access_token: accessToken,
        },
      },
    );

    const conversations = convRes.data.data || [];

    // Format conversations
    const formatted = conversations.map((conv) => {
      const participants = conv.participants?.data || [];
      const messages = conv.messages?.data || [];
      const lastMessage = messages[0];

      return {
        id: conv.id,
        participants: participants.map((p) => ({
          id: p.id,
          name: p.name || p.username || "Unknown",
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

    return res.json({ conversations: formatted });
  } catch (error) {
    console.error(
      "Instagram API error:",
      error.response?.data || error.message,
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
    const { recipientId, message } = req.body;
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;

    let igAccountId;

    if (accessToken.startsWith("IG")) {
      const meRes = await axios.get(`${GRAPH_API}/me`, {
        params: { fields: "id,username", access_token: accessToken },
      });
      igAccountId = meRes.data.id;
    } else {
      const meRes = await axios.get(`${GRAPH_API}/me`, {
        params: {
          fields: "instagram_business_account",
          access_token: accessToken,
        },
      });
      igAccountId = meRes.data.instagram_business_account?.id;
    }

    if (!igAccountId) {
      return res
        .status(400)
        .json({ message: "No Instagram Business Account found" });
    }

    // Send message via Instagram API
    const sendRes = await axios.post(
      `${GRAPH_API}/${igAccountId}/messages`,
      {
        recipient: { id: recipientId },
        message: { text: message },
      },
      {
        params: { access_token: accessToken },
      },
    );

    // Save to database
    const newMessage = new Message({
      platform: "instagram",
      conversationId: recipientId,
      senderId: igAccountId,
      recipientId: recipientId,
      content: message,
      messageType: "text",
      direction: "outgoing",
      status: "sent",
      externalId: sendRes.data.message_id,
    });
    await newMessage.save();

    return res.json({ success: true, messageId: sendRes.data.message_id });
  } catch (error) {
    console.error(
      "Instagram send error:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      message: "Failed to send message",
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
