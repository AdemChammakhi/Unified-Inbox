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

    console.log("Using Facebook Page ID:", pageId);

    // Fetch conversations using the Facebook Page ID
    // Fetch from BOTH "inbox" and "other" (message requests) folders
    // so that DMs from people you don't follow are also included
    const conversationFields =
      "participants,messages{message,from,to,created_time,attachments}";
    let conversations = [];
    const seenConvIds = new Set();
    const folders = ["inbox", "other"]; // "other" = message requests

    for (const folder of folders) {
      let nextUrl = `${GRAPH_API}/${pageId}/conversations`;
      let params = {
        platform: "instagram",
        folder,
        fields: conversationFields,
        limit: 60,
        access_token: accessToken,
      };
      const maxPages = 3;
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

    // ALSO fetch conversations WITHOUT the platform filter —
    // some Instagram DMs appear here when they don't show with platform=instagram
    try {
      let nextUrl = `${GRAPH_API}/${pageId}/conversations`;
      let params = {
        fields: conversationFields,
        limit: 60,
        access_token: accessToken,
      };
      const convRes = await axios.get(nextUrl, { params });
      const pageData = convRes.data.data || [];
      for (const conv of pageData) {
        // Only include if it looks like an Instagram conversation
        // (participant has username field or participant ID matches IG account)
        const participants = conv.participants?.data || [];
        const isIg = participants.some(
          (p) => p.username || p.id === process.env.INSTAGRAM_ACCOUNT_ID,
        );
        if (isIg && !seenConvIds.has(conv.id)) {
          seenConvIds.add(conv.id);
          conversations.push(conv);
          console.log(`Found IG conversation from unfiltered API: ${conv.id}`);
        }
      }
    } catch (unfilteredErr) {
      console.error(
        "Unfiltered conversations fetch error (non-fatal):",
        unfilteredErr.response?.data?.error?.message || unfilteredErr.message,
      );
    }

    console.log(
      `Instagram API returned ${conversations.length} conversations total`,
    );
    if (conversations.length > 0) {
      console.log(
        "Conv IDs:",
        conversations.map((c) => c.id),
      );
    }

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

    // --- Merge in DB-only conversations (new senders the Graph API hasn't returned yet) ---
    try {
      const knownIds = new Set();
      formatted.forEach((c) => {
        knownIds.add(c.id);
        c.participants.forEach((p) => knownIds.add(p.id));
      });
      console.log(
        `Instagram merge: ${formatted.length} API conversations, knownIds count=${knownIds.size}`,
      );

      // Get recent messages from DB for this platform (both incoming AND outgoing)
      // so webhook-delivered conversations always surface even if the Graph API is stale
      const recentDbMsgs = await Message.find({
        platform: "instagram",
      })
        .sort({ createdAt: -1 })
        .limit(500);

      console.log(
        `Instagram merge: ${recentDbMsgs.length} recent DB messages found`,
      );

      // Group by conversationId, only keep those not already in API results
      const newConvMap = {};
      let skippedKnown = 0;
      for (const m of recentDbMsgs) {
        if (knownIds.has(m.senderId) || knownIds.has(m.conversationId)) {
          skippedKnown++;
          continue;
        }
        const key = m.conversationId || m.senderId;
        if (!newConvMap[key]) {
          newConvMap[key] = {
            id: key,
            participants: [{ id: m.senderId, name: m.senderName || "Unknown" }],
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
      console.log(
        `Instagram merge: ${skippedKnown} msgs matched known API convos, ${dbOnlyConvs.length} DB-only conversation(s) to add`,
      );
      if (dbOnlyConvs.length > 0) {
        console.log(
          "DB-only convos:",
          dbOnlyConvs.map((c) => ({
            id: c.id,
            name: c.participants[0]?.name,
            msgs: c.messages.length,
          })),
        );
        formatted.unshift(...dbOnlyConvs);
      }
    } catch (mergeErr) {
      console.error("DB merge non-fatal error:", mergeErr.message);
    }

    return res.json({ conversations: formatted.slice(0, 20) });
  } catch (error) {
    console.error(
      "Instagram API error:",
      JSON.stringify(error.response?.data, null, 2) || error.message,
    );

    // If the Graph API fails, fall back to conversations built from the local DB
    try {
      const dbMessages = await Message.find({ platform: "instagram" })
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
                name: m.direction === "incoming" ? m.senderName : m.recipientId,
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

    // Instagram Messaging API requires the Instagram Business Account ID, not the Page ID
    const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID || pageId;
    console.log(
      "Instagram send - recipientId:",
      recipientId,
      "igAccountId:",
      igAccountId,
    );

    // Send message via Instagram Messaging API
    // Try RESPONSE first (within 24h window), fall back to HUMAN_AGENT tag (7-day window)
    let sendRes;
    try {
      sendRes = await axios.post(
        `${GRAPH_API}/${igAccountId}/messages`,
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
        `${GRAPH_API}/${igAccountId}/messages`,
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
