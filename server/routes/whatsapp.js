const express = require("express");
const router = express.Router();
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { protect } = require("../middleware/auth");
const {
  updateConversationAfterMessage,
} = require("../services/conversationService");
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { sanitizeId } = require("../utils/sanitize");
const { messageTypeFor } = require("../utils/metaPayload");

// Body: { recipientId, message?, conversationId, attachment? }
// attachment = { url, name, mimeType, mediaType } from POST /api/uploads.
router.post("/send", protect, async (req, res) => {
  try {
    const { recipientId, message, conversationId, attachment } = req.body;
    console.log("[WA:Send] START", { recipientId, conversationId, messageLen: message?.length, attachment: attachment?.mediaType || "none" });
    const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
    const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({
        message:
          "WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing in .env",
      });
    }
    if (!message?.trim() && !attachment?.url) {
      return res
        .status(400)
        .json({ message: "message or attachment is required" });
    }

    // --- Conversation Lock Check ---
    const lockConvId = sanitizeId(conversationId) || sanitizeId(recipientId);
    if (!lockConvId) {
      return res.status(400).json({ message: "Invalid conversationId or recipientId" });
    }
    console.log("[WA:Send] Step 1 - Lock check for:", lockConvId);
    const existingLock = await ConversationLock.findOne({
      conversationId: lockConvId,
      platform: "whatsapp",
    });
    console.log("[WA:Send] Step 1 - Lock result:", existingLock ? "locked" : "unlocked");

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

    // --- Save the outgoing message to DB ---
    console.log("[WA:Send] Step 2 - Saving message to DB");
    const newMessage = await Message.create({
      platform: "whatsapp",
      senderId: "agent",
      senderName: `${req.user.firstName} ${req.user.lastName}`,
      recipientId: recipientId,
      conversationId: lockConvId,
      direction: "outgoing",
      messageType: messageTypeFor(storedAttachments),
      attachments: storedAttachments,
      content: message || "",
      sentBy: req.user._id,
      status: "sent",
    });
    console.log("[WA:Send] Step 2 - Message saved:", newMessage._id);

    // --- Send to WhatsApp API ---
    const apiUrl =
      (process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v24.0").trim();
    const fullUrl = `${apiUrl}/${phoneNumberId}/messages`;
    console.log("[WA:Send] Step 3 - Calling WhatsApp API to:", recipientId);

    // Build payloads: media (link-based) carries the text as caption where
    // supported; audio has no caption, so text goes as a separate message.
    const payloads = [];
    if (attachment?.url) {
      const waType =
        attachment.mediaType === "file"
          ? "document"
          : attachment.mediaType || "document";
      const media = { link: attachment.url };
      if (waType === "document" && attachment.name) {
        media.filename = attachment.name;
      }
      if (message?.trim() && waType !== "audio") {
        media.caption = message;
      } else if (message?.trim() && waType === "audio") {
        payloads.push({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipientId,
          type: "text",
          text: { preview_url: false, body: message },
        });
      }
      payloads.push({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientId,
        type: waType,
        [waType]: media,
      });
    } else {
      payloads.push({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientId,
        type: "text",
        text: { preview_url: false, body: message },
      });
    }

    let sendRes;
    try {
      for (const payload of payloads) {
        sendRes = await axios.post(fullUrl, payload, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        });
      }
      console.log("[WA:Send] Step 3 - API success:", sendRes.data);
    } catch (apiErr) {
      console.error(
        "[WA:Send] Step 3 - API FAILED:",
        JSON.stringify(apiErr.response?.data || apiErr.message, null, 2),
      );
      // Fail the message in DB if it didn't send
      await Message.findByIdAndUpdate(newMessage._id, { status: "failed" });
      return res.status(500).json({
        message: "Failed to send message via WhatsApp API",
        error: apiErr.response?.data || apiErr.message,
      });
    }

    // --- Update the Conversation snippet ---
    console.log("[WA:Send] Step 4 - Updating conversation snippet");
    await updateConversationAfterMessage(lockConvId, newMessage);
    console.log("[WA:Send] Step 4 - Done");

    // --- Emit Socket event ---
    const io = req.app.get("io");
    if (io) {
      io.emit("messageSent", {
        platform: "whatsapp",
        conversationId: lockConvId,
        recipientId: recipientId,
        message: {
          id: newMessage._id.toString(),
          text: newMessage.content,
          from: newMessage.senderName || "You",
          fromId: newMessage.senderId,
          time: newMessage.timestamp || newMessage.createdAt,
          direction: newMessage.direction,
          attachments: storedAttachments,
        },
      });
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
// Supports ?slim=1: returns the conversation list without embedded messages —
// the frontend lazy-loads them from /messages-paged on selection anyway.
router.get("/conversations", protect, async (req, res) => {
  try {
    const slim = req.query.slim === "1" || req.query.slim === "true";
    const dbMessages = await Message.find({ platform: "whatsapp" })
      .sort({ timestamp: -1 })
      .limit(500)
      .lean();

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
      if (!slim) conv.messages.unshift(msg);
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

// GET /api/whatsapp/media/:mediaId — stream WhatsApp media to the browser.
// Meta's media URLs require the access token and expire after ~5 minutes, so
// we fetch a fresh URL per request and pipe the binary through.
// Auth: standard Bearer header OR ?token= query param — <img>/<video> tags
// cannot send Authorization headers.
router.get("/media/:mediaId", async (req, res) => {
  try {
    let token = null;
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) token = header.split(" ")[1];
    if (!token && typeof req.query.token === "string") token = req.query.token;
    if (!token || !process.env.JWT_SECRET) return res.sendStatus(401);
    try {
      jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.sendStatus(401);
    }

    const mediaId = sanitizeId(req.params.mediaId);
    if (!mediaId || !/^[\w.-]+$/.test(mediaId)) {
      return res.status(400).json({ message: "Invalid media id" });
    }

    const accessToken = (process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
    if (!accessToken) {
      return res.status(400).json({ message: "WHATSAPP_ACCESS_TOKEN missing" });
    }

    const apiUrl = (
      process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v24.0"
    ).trim();

    // Step 1: resolve the media ID to a short-lived CDN URL
    const metaRes = await axios.get(
      `${apiUrl}/${encodeURIComponent(mediaId)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000,
      },
    );
    const mediaUrl = metaRes.data?.url;
    if (!mediaUrl) return res.status(404).json({ message: "Media not found" });

    // Step 2: stream the binary (also requires the token)
    const upstream = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: "stream",
      timeout: 30000,
    });
    if (metaRes.data?.mime_type) {
      res.setHeader("Content-Type", metaRes.data.mime_type);
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    upstream.data.pipe(res);
  } catch (err) {
    console.error(
      "WA media proxy error:",
      err.response?.status || err.message,
    );
    return res.status(502).json({ message: "Failed to fetch media" });
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

    const safeConvId = sanitizeId(conversationId);
    if (!safeConvId) {
      return res.status(400).json({ message: "Invalid conversationId" });
    }

    const query = { platform: "whatsapp", conversationId: safeConvId };
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
        attachments: m.attachments || [],
        context: m.context || null,
      })),
      hasMore: messages.length === pageLimit,
    });
  } catch (err) {
    console.error("WA messages-paged error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
