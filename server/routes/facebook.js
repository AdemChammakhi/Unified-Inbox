const express = require("express");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const { protect } = require("../middleware/auth");

const GRAPH_API = "https://graph.facebook.com/v24.0";

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
    const convRes = await axios.get(`${GRAPH_API}/${pageId}/conversations`, {
      params: {
        fields:
          "participants,messages{message,from,to,created_time,attachments}",
        access_token: accessToken,
      },
    });

    const conversations = convRes.data.data || [];

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

    return res.json({ conversations: formatted });
  } catch (error) {
    console.error(
      "Facebook API error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );
    return res.status(500).json({
      message: "Failed to fetch Facebook conversations",
      error: error.response?.data?.error?.message || error.message,
    });
  }
});

// POST /api/facebook/send - Send a Facebook Messenger message
router.post("/send", protect, async (req, res) => {
  try {
    const { recipientId, message } = req.body;
    const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;

    if (!accessToken || !pageId) {
      return res.status(400).json({
        message:
          "FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_PAGE_ID missing in .env",
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
