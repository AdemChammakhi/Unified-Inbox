const express = require("express");
const router = express.Router();
const axios = require("axios");
const jwt = require("jsonwebtoken");
const { protect } = require("../middleware/auth");
const { storeCrmSend } = require("../services/conversationService");
const conversations = require("../db/conversations");
const messages = require("../db/messages");
const { sanitizeId } = require("../utils/sanitize");

/** Locks taken by a WhatsApp send carry this (unenforced) expiry. */
const LOCK_EXPIRY_MS = 10 * 60 * 1000;

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
    const customerId = sanitizeId(recipientId) || lockConvId;
    if (!lockConvId || !customerId) {
      return res.status(400).json({ message: "Invalid conversationId or recipientId" });
    }
    console.log("[WA:Send] Step 1 - Lock check for:", lockConvId);
    const existing = await conversations.resolve("whatsapp", [lockConvId, customerId]);
    const existingLock = existing?.lockedBy ? existing : null;
    console.log("[WA:Send] Step 1 - Lock result:", existingLock ? "locked" : "unlocked");

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

    // --- Send to WhatsApp API ---
    const apiUrl =
      (process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v24.0").trim();
    const fullUrl = `${apiUrl}/${phoneNumberId}/messages`;
    console.log("[WA:Send] Step 2 - Calling WhatsApp API to:", recipientId);

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
      console.log("[WA:Send] Step 2 - API success:", sendRes.data);
    } catch (apiErr) {
      console.error(
        "[WA:Send] Step 2 - API FAILED:",
        JSON.stringify(apiErr.response?.data || apiErr.message, null, 2),
      );
      // Nothing is stored for a refused send: the schema keeps no delivery
      // status (decision D3), and the agent sees the error right away.
      return res.status(500).json({
        message: "Failed to send message via WhatsApp API",
        error: apiErr.response?.data || apiErr.message,
      });
    }

    // --- Save the outgoing message, now that WhatsApp accepted it ---
    // The message is delivered already: a database error must not fail the
    // request (the agent would send it twice).
    const wamid = sendRes?.data?.messages?.[0]?.id || null;
    console.log("[WA:Send] Step 3 - Saving message to DB");
    let saved = null;
    try {
      saved = await storeCrmSend({
        platform: "whatsapp",
        customerId,
        externalId: wamid,
        content: message || "",
        attachments: storedAttachments,
        userId: req.user._id,
      });
      console.log("[WA:Send] Step 3 - Message saved:", saved.messageId);
    } catch (dbErr) {
      console.error("[WA:Send] Step 3 - DB save error (non-fatal):", dbErr.message);
    }
    const sentAt = new Date();

    // --- Emit Socket event ---
    const io = req.app.get("io");
    if (io) {
      io.emit("messageSent", {
        platform: "whatsapp",
        conversationId: lockConvId,
        recipientId: recipientId,
        message: {
          id: wamid || String(saved?.messageId || sentAt.getTime()),
          text: message || "",
          from: `${req.user.firstName} ${req.user.lastName}`,
          fromId: "agent",
          time: sentAt.toISOString(),
          direction: "outgoing",
          attachments: storedAttachments,
        },
      });
    }

    // --- Auto-lock functionality ---
    const lockTarget = saved?.conversation?.id || existing?.id || null;
    if (!existingLock && lockTarget) {
      const locked = await conversations.lock(lockTarget, req.user._id, {
        expiresInMs: LOCK_EXPIRY_MS,
      });
      if (locked) {
        if (io) {
          io.emit("conversationLocked", {
            conversationId: lockConvId,
            platform: "whatsapp",
            lockedBy: req.user,
          });
        }
      } else {
        console.log("[WhatsApp:Lock] Lock race detected (non-fatal)");
      }
    } else if (existingLock) {
      await conversations.refreshLockExpiry(existingLock.id, LOCK_EXPIRY_MS);
    }

    return res.status(200).json({
      success: true,
      messageId: wamid || saved?.messageId || null,
      whatsappRes: sendRes.data,
    });
  } catch (err) {
    console.error("WhatsApp Send Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/whatsapp/conversations - Fetch WhatsApp conversations from database
// Supports ?slim=1 (the only mode the inbox uses): every conversation comes
// without embedded messages — the frontend lazy-loads them from
// /messages-paged on selection.
router.get("/conversations", protect, async (req, res) => {
  try {
    const rows = await conversations.recentWithLastMessage("whatsapp", 200);

    const list = rows.map((c) => {
      const last = c.lastMessage;
      const incoming = last.senderType === "contact";
      return {
        id: c.externalId,
        participants: [
          {
            id: c.customerId || c.externalId,
            name: c.name && c.name !== "Unknown" ? c.name : c.customerId || c.externalId,
          },
        ],
        lastMessage: {
          text: last.text || "",
          from: incoming ? c.name || "Unknown" : last.senderUserName || "Page/Agent",
          time: last.time,
        },
        messages: [],
      };
    });

    return res.json({ conversations: list });
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
// Returns paginated messages for a specific WhatsApp conversation.
// Cursor-based: pass `before` (ISO timestamp) to load messages older than that point.
router.get("/messages-paged", protect, async (req, res) => {
  try {
    const { conversationId, participantId, limit = 30, before } = req.query;
    if (!conversationId) {
      return res.status(400).json({ message: "conversationId is required" });
    }
    const pageLimit = Math.min(Number(limit) || 30, 100);

    const safeConvId = sanitizeId(conversationId);
    if (!safeConvId) {
      return res.status(400).json({ message: "Invalid conversationId" });
    }
    const keys = [safeConvId, sanitizeId(participantId)].filter(Boolean);
    const found = await conversations.findByKeys("whatsapp", keys);
    const { messages: rows, hasMore } = await messages.page(
      found.map((c) => c.id),
      { before, limit: pageLimit },
    );

    return res.json({ messages: rows, hasMore });
  } catch (err) {
    console.error("WA messages-paged error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;
