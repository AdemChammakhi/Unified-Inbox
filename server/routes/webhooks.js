const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const { protect } = require("../middleware/auth");

const GRAPH_API = "https://graph.facebook.com/v24.0";

function isLikelyRawId(value) {
  return typeof value === "string" && /^\d{6,}$/.test(value);
}

// In-memory log of recent webhook hits (last 50) — for debugging
const webhookLog = [];
function logWebhook(platform, type, summary) {
  webhookLog.unshift({
    platform,
    type,
    summary,
    time: new Date().toISOString(),
  });
  if (webhookLog.length > 50) webhookLog.length = 50;
}

// GET /api/webhooks/debug — check webhook health & recent DB messages (admin only)
router.get("/debug", protect, async (req, res) => {
  try {
    const recentMessages = await Message.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .select(
        "platform conversationId senderId senderName direction content createdAt externalId",
      );

    // Count messages per platform
    const igCount = await Message.countDocuments({ platform: "instagram" });
    const fbCount = await Message.countDocuments({ platform: "facebook" });
    const igIncoming = await Message.countDocuments({
      platform: "instagram",
      direction: "incoming",
    });

    return res.json({
      webhookHits: webhookLog,
      messageCounts: {
        instagram: igCount,
        instagramIncoming: igIncoming,
        facebook: fbCount,
      },
      recentMessages,
      envCheck: {
        INSTAGRAM_ACCESS_TOKEN: !!process.env.INSTAGRAM_ACCESS_TOKEN,
        INSTAGRAM_ACCOUNT_ID: !!process.env.INSTAGRAM_ACCOUNT_ID,
        FACEBOOK_PAGE_ACCESS_TOKEN: !!process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
        FACEBOOK_PAGE_ID: !!process.env.FACEBOOK_PAGE_ID,
        FACEBOOK_APP_SECRET: !!process.env.FACEBOOK_APP_SECRET,
        FACEBOOK_VERIFY_TOKEN: !!process.env.FACEBOOK_VERIFY_TOKEN,
        EMAIL_USER: !!process.env.EMAIL_USER,
        EMAIL_PASSWORD: !!process.env.EMAIL_PASSWORD,
        EMAIL_IMAP_HOST: !!process.env.EMAIL_IMAP_HOST,
        EMAIL_SMTP_HOST: !!process.env.EMAIL_SMTP_HOST,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Helper: look up a user's name/username from the Graph API (with timeout)
async function getSenderName(senderId, platform) {
  try {
    const token =
      platform === "facebook"
        ? process.env.FACEBOOK_PAGE_ACCESS_TOKEN
        : process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!token) return null;
    // For Facebook Messenger PSIDs, request only 'name' — the display name
    // field. first_name/last_name can be empty even when name is populated.
    const fields = platform === "instagram" ? "username,name" : "name";
    const res = await axios.get(`${GRAPH_API}/${senderId}`, {
      params: { fields, access_token: token },
      timeout: 5000, // 5s timeout so webhook doesn't hang
    });
    const resolvedName =
      res.data.username ||
      res.data.name ||
      [res.data.first_name, res.data.last_name].filter(Boolean).join(" ");
    if (!resolvedName || isLikelyRawId(resolvedName)) return null;
    return resolvedName;
  } catch {
    // Fallback for Facebook: query page conversations to get participant name
    if (platform === "facebook") {
      try {
        const pageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
        const pageId = process.env.FACEBOOK_PAGE_ID;
        if (!pageToken || !pageId) return null;
        const convRes = await axios.get(
          `${GRAPH_API}/${pageId}/conversations`,
          {
            params: {
              fields: "participants",
              user_id: senderId,
              access_token: pageToken,
            },
            timeout: 5000,
          },
        );
        const conv = convRes.data.data?.[0];
        const participant = conv?.participants?.data?.find(
          (p) => p.id === senderId,
        );
        if (participant?.name && !isLikelyRawId(participant.name)) {
          return participant.name;
        }
      } catch {
        // both lookups failed
      }
    }
    return null;
  }
}

// Helper: extract messaging events from an Instagram webhook entry.
// Instagram can deliver events in TWO formats:
//   1) entry.messaging  — array of {sender, recipient, message, ...}
//   2) entry.changes    — array of {field:"messages", value:{sender, recipient, message, ...}}
function extractInstagramEvents(entry) {
  const events = [];
  // Format 1: entry.messaging
  if (Array.isArray(entry.messaging) && entry.messaging.length > 0) {
    events.push(...entry.messaging);
  }
  // Format 2: entry.changes (field=messages wraps a single messaging event)
  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change.field === "messages" && change.value) {
        // The value object follows the same shape as a single messaging event
        events.push(change.value);
      }
    }
  }
  return events;
}

// Verify webhook signature from Meta
const verifySignature = (req, res, buf) => {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !process.env.FACEBOOK_APP_SECRET) return;

  const expectedSignature =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.FACEBOOK_APP_SECRET)
      .update(buf)
      .digest("hex");

  if (signature !== expectedSignature) {
    throw new Error("Invalid webhook signature");
  }
};

// ============ WHATSAPP WEBHOOKS ============

// GET - WhatsApp webhook verification
router.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST - Receive WhatsApp messages
router.post("/whatsapp", async (req, res) => {
  logWebhook("whatsapp", "POST", `object=${req.body?.object}`);
  try {
    const body = req.body;
    const io = req.app.get("io");

    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field === "messages") {
            const value = change.value;
            const messages = value.messages || [];

            for (const msg of messages) {
              // Look up WhatsApp sender name from contacts
              const contact = value.contacts?.[0];
              const waName =
                contact?.profile?.name || contact?.wa_id || msg.from;

              const newMessage = await Message.create({
                platform: "whatsapp",
                conversationId: msg.from,
                senderId: msg.from,
                senderName: waName,
                recipientId: value.metadata.phone_number_id,
                content: msg.text?.body || "",
                messageType: msg.type || "text",
                direction: "incoming",
                status: "delivered",
                externalId: msg.id,
              });

              console.log("WhatsApp message saved:", newMessage._id);

              // Emit real-time event with formatted data
              if (io) {
                io.emit("newMessage", {
                  platform: "whatsapp",
                  message: {
                    id: msg.id,
                    text: msg.text?.body || "",
                    from: msg.from,
                    fromId: msg.from,
                    time: new Date().toISOString(),
                  },
                  conversationId: msg.from,
                  senderId: msg.from,
                });
              }
            }

            // Handle status updates
            const statuses = value.statuses || [];
            for (const status of statuses) {
              await Message.findOneAndUpdate(
                { externalId: status.id },
                { status: status.status },
              );

              if (io) {
                io.emit("messageStatus", {
                  externalId: status.id,
                  status: status.status,
                });
              }
            }
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
    return res.sendStatus(200);
  }
});

// ============ INSTAGRAM WEBHOOKS ============

// GET - Instagram webhook verification
router.get("/instagram", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.FACEBOOK_VERIFY_TOKEN) {
    console.log("Instagram webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST - Receive Instagram messages
router.post("/instagram", async (req, res) => {
  const body = req.body;
  logWebhook(
    "instagram",
    "POST",
    `object=${body?.object}, entries=${body?.entry?.length}, keys=${body?.entry?.map((e) => Object.keys(e).join("/")).join("; ")}`,
  );
  // Log the full payload structure for debugging (first 2000 chars)
  console.log(
    "=== INSTAGRAM WEBHOOK RAW ===",
    JSON.stringify(body, null, 2).slice(0, 2000),
  );
  try {
    const io = req.app.get("io");

    if (body.object === "instagram" || body.object === "page") {
      for (const entry of body.entry || []) {
        // Extract events from BOTH entry.messaging and entry.changes formats
        const events = extractInstagramEvents(entry);
        console.log(
          `Instagram webhook entry: ${events.length} event(s) extracted (messaging=${entry.messaging?.length || 0}, changes=${entry.changes?.length || 0})`,
        );

        for (const event of events) {
          const senderId = event.sender?.id;
          const recipientId = event.recipient?.id;

          // Skip messages sent by the page itself
          if (
            senderId === process.env.FACEBOOK_PAGE_ID ||
            senderId === process.env.INSTAGRAM_ACCOUNT_ID
          ) {
            console.log("Skipping IG echo (sent by page):", senderId);
            continue;
          }

          if (event.message) {
            const msgText = event.message.text || "";
            const msgMid = event.message.mid;

            console.log(
              `Instagram incoming msg from ${senderId}: "${msgText.slice(0, 80)}" mid=${msgMid}`,
            );

            // Look up Instagram sender name (with timeout)
            const igSenderName = await getSenderName(senderId, "instagram");

            // Upsert to DB (avoids duplicate errors if webhook fires twice)
            const newMessage = await Message.findOneAndUpdate(
              { externalId: msgMid },
              {
                $setOnInsert: {
                  platform: "instagram",
                  conversationId: senderId,
                  senderId: senderId,
                  senderName: igSenderName,
                  recipientId: recipientId,
                  content: msgText,
                  messageType: event.message.attachments
                    ? "attachment"
                    : "text",
                  direction: "incoming",
                  status: "delivered",
                  externalId: msgMid,
                  timestamp: new Date(),
                },
              },
              { upsert: true, new: true },
            );

            console.log("Instagram message saved:", newMessage._id);

            // Emit real-time event with formatted data for instant UI update
            if (io) {
              io.emit("newMessage", {
                platform: "instagram",
                message: {
                  id: msgMid,
                  text: msgText,
                  from: igSenderName,
                  fromId: senderId,
                  time: new Date().toISOString(),
                },
                conversationId: senderId,
                senderId: senderId,
                senderName: igSenderName,
              });
            }
          }

          // Handle message reactions
          if (event.reaction) {
            if (io) {
              io.emit("messageReaction", {
                platform: "instagram",
                messageId: event.reaction.mid,
                reaction: event.reaction.reaction,
                action: event.reaction.action,
              });
            }
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("Instagram webhook error:", error);
    return res.sendStatus(200);
  }
});

// ============ FACEBOOK MESSENGER WEBHOOKS ============

// GET - Facebook Messenger webhook verification
router.get("/facebook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.FACEBOOK_VERIFY_TOKEN) {
    console.log("Facebook Messenger webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST - Receive Facebook Messenger messages
router.post("/facebook", async (req, res) => {
  logWebhook(
    "facebook",
    "POST",
    `object=${req.body?.object}, entries=${req.body?.entry?.length}`,
  );
  try {
    const body = req.body;
    const io = req.app.get("io");

    if (body.object === "page") {
      for (const entry of body.entry || []) {
        const messaging = entry.messaging || [];

        for (const event of messaging) {
          const senderId = event.sender?.id;
          const recipientId = event.recipient?.id;

          // Skip messages sent by the page itself
          if (senderId === process.env.FACEBOOK_PAGE_ID) continue;

          // Detect Instagram messages arriving via Page subscription
          // (happens if IG messaging events are routed through the Page webhook)
          const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
          const isInstagramMsg = igAccountId && recipientId === igAccountId;
          const detectedPlatform = isInstagramMsg ? "instagram" : "facebook";
          if (isInstagramMsg) {
            console.log(
              "INFO: Instagram message detected in Facebook webhook route, saving as instagram platform",
            );
          }

          // Handle incoming messages
          if (event.message) {
            const message = event.message;
            console.log(
              `New ${detectedPlatform} message from ${senderId}: ${message.text}`,
            );

            // Look up sender name
            const resolvedSenderName = await getSenderName(
              senderId,
              detectedPlatform,
            );
            const fbSenderName = resolvedSenderName || "Unknown";

            const newMessage = await Message.findOneAndUpdate(
              { externalId: message.mid },
              {
                $setOnInsert: {
                  platform: detectedPlatform,
                  conversationId: senderId,
                  senderId: senderId,
                  senderName: fbSenderName,
                  recipientId: recipientId,
                  content: message.text || "",
                  messageType: message.attachments ? "attachment" : "text",
                  direction: "incoming",
                  status: "delivered",
                  externalId: message.mid,
                  timestamp: new Date(),
                },
              },
              { upsert: true, new: true },
            );

            console.log(`${detectedPlatform} message saved:`, newMessage._id);

            // Emit real-time event with formatted data for instant UI update
            if (io) {
              io.emit("newMessage", {
                platform: detectedPlatform,
                message: {
                  id: message.mid,
                  text: message.text || "",
                  from: fbSenderName,
                  fromId: senderId,
                  time: new Date().toISOString(),
                },
                conversationId: senderId,
                senderId: senderId,
                senderName: fbSenderName,
              });
            }
          }

          // Handle message deliveries
          if (event.delivery) {
            console.log("Facebook message delivered:", event.delivery.mids);
          }

          // Handle message reads
          if (event.read) {
            console.log("Facebook message read at:", event.read.watermark);
          }
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("Facebook webhook error:", error);
    return res.sendStatus(200);
  }
});

module.exports = router;
