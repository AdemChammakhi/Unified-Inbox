const express = require("express");
const router = express.Router();
const axios = require("axios");
const { protect } = require("../middleware/auth");
const {
  updateConversationAfterMessage,
} = require("../services/conversationService");
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");

router.post("/send", protect, async (req, res) => {
  try {
    const { recipientId, message, conversationId } = req.body;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({
        message:
          "WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing in .env",
      });
    }

    // --- Conversation Lock Check ---
    const lockConvId = conversationId || recipientId;
    const existingLock = await ConversationLock.findOne({
      conversationId: lockConvId,
      platform: "whatsapp",
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

    // --- Save the outgoing message to DB ---
    const newMessage = await Message.create({
      platform: "whatsapp",
      senderId: "agent",
      senderName: `${req.user.firstName} ${req.user.lastName}`,
      recipientId: recipientId,
      conversationId: lockConvId,
      direction: "outgoing",
      messageType: "text",
      content: message,
      sentBy: req.user._id,
      status: "sent",
    });

    // --- Send to WhatsApp API ---
    const apiUrl =
      process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v24.0";
    let sendRes;
    try {
      sendRes = await axios.post(
        `${apiUrl}/${phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipientId,
          type: "text",
          text: {
            preview_url: false,
            body: message,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );
    } catch (apiErr) {
      console.error(
        "WhatsApp API send error:",
        apiErr.response?.data || apiErr.message,
      );
      // Fail the message in DB if it didn't send
      await Message.findByIdAndUpdate(newMessage._id, { status: "failed" });
      return res.status(500).json({
        message: "Failed to send message via WhatsApp API",
        error: apiErr.response?.data || apiErr.message,
      });
    }

    // --- Update the Conversation snippet ---
    await updateConversationAfterMessage(lockConvId, newMessage);

    // --- Emit Socket event ---
    const io = req.app.get("io");
    if (io) {
      const socketMsg = { ...newMessage.toObject(), id: newMessage._id };
      io.emit("messageSent", socketMsg);
    }

    // --- Auto-lock functionality ---
    if (!existingLock) {
      try {
        await ConversationLock.create({
          conversationId: lockConvId,
          platform: "whatsapp",
          lockedBy: req.user._id,
          lockedAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        });
        if (io) {
          io.emit("conversationLocked", {
            conversationId: lockConvId,
            platform: "whatsapp",
            lockedBy: req.user,
          });
        }
      } catch (lockErr) {
        if (lockErr.code === 11000) {
          console.log("[WhatsApp:Lock] Lock race detected (non-fatal)");
        } else {
          throw lockErr;
        }
      }
    } else {
      existingLock.expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await existingLock.save();
    }

    return res.status(200).json({
      success: true,
      messageId: newMessage._id,
      whatsappRes: sendRes.data,
    });
  } catch (err) {
    console.error("WhatsApp Send Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/whatsapp/conversations - Fetch WhatsApp conversations from database
router.get("/conversations", protect, async (req, res) => {
  try {
    const dbMessages = await Message.find({ platform: "whatsapp" })
      .sort({ timestamp: -1 })
      .limit(500);

    const convMap = {};
    for (const m of dbMessages) {
      if (!convMap[m.conversationId]) {
        convMap[m.conversationId] = {
          id: m.conversationId,
          participants: [
            {
              id: m.direction === "incoming" ? m.senderId : m.recipientId,
              name: m.direction === "incoming" ? m.senderName : "Page/Agent",
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
        direction: m.direction,
      };
      conv.messages.unshift(msg);
      if (
        !conv.lastMessage ||
        new Date(msg.time) > new Date(conv.lastMessage.time)
      ) {
        conv.lastMessage = { text: msg.text, from: msg.from, time: msg.time };
      }
    }

    // Sort conversations by latest message time
    const conversations = Object.values(convMap).sort((a, b) => {
      const timeA = a.lastMessage?.time ? new Date(a.lastMessage.time).getTime() : 0;
      const timeB = b.lastMessage?.time ? new Date(b.lastMessage.time).getTime() : 0;
      return timeB - timeA;
    });

    return res.json({ conversations });
  } catch (error) {
    console.error("Failed to fetch WhatsApp conversations:", error);
    return res.status(500).json({ message: "Failed to fetch WhatsApp conversations", error: error.message });
  }
});

// GET /api/whatsapp/messages-paged
// Returns paginated messages for a specific WhatsApp conversation from MongoDB.
// Cursor-based: pass `before` (ISO timestamp) to load messages older than that point.
router.get("/messages-paged", protect, async (req, res) => {
  try {
    const { conversationId, limit = 30, before } = req.query;
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    const pageLimit = Math.min(Number(limit) || 30, 100);

    const query = { platform: "whatsapp", conversationId };
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
    console.error("WA messages-paged error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
