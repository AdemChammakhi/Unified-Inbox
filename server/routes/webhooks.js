const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");
const { protect } = require("../middleware/auth");
const instagramRoute = require("./instagram");
const facebookRoute = require("./facebook");
const emailRoute = require("./email");
const { getOrCreateConversation, updateConversationAfterMessage } = require("../services/conversationService");
const { sanitizeId, isValidGraphId } = require("../utils/sanitize");
const {
  parseMetaReferral,
  parseWhatsAppReferral,
  parseMessageContext,
  parseMetaAttachments,
  parseWhatsAppAttachments,
  whatsAppMessageText,
  messageTypeFor,
} = require("../utils/metaPayload");
const { isBlocked, reportGraphError } = require("../utils/graphAuthGate");

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

// Helper: look up a user's profile (name + picture) from the Graph API.
// profile_pic requires User Profile access on some setups — once the combined
// request fails we remember that per platform and go straight to name-only,
// so a missing permission costs at most ONE extra call per process lifetime
// and never the display name.
const _picSupported = { instagram: true, facebook: true };

async function getSenderProfile(senderId, platform) {
  const empty = { name: null, avatar: null };
  const token =
    platform === "facebook"
      ? process.env.FACEBOOK_PAGE_ACCESS_TOKEN
      : process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token || !isValidGraphId(senderId)) return empty;

  // For Facebook Messenger PSIDs, request 'name' — first_name/last_name can
  // be empty even when name is populated.
  const nameFields = platform === "instagram" ? "username,name" : "name";

  const fetchProfile = async (fields) => {
    const res = await axios.get(
      `${GRAPH_API}/${encodeURIComponent(senderId)}`,
      {
        params: { fields, access_token: token },
        timeout: 5000, // 5s timeout so webhook doesn't hang
      },
    );
    const resolvedName =
      res.data.username ||
      res.data.name ||
      [res.data.first_name, res.data.last_name].filter(Boolean).join(" ");
    return {
      name: !resolvedName || isLikelyRawId(resolvedName) ? null : resolvedName,
      avatar: res.data.profile_pic || null,
    };
  };

  // Fallback for Facebook: the page-conversations edge resolves participant
  // names with plain page permissions — works even without Advanced Access.
  const facebookConversationsFallback = async () => {
    try {
      const pageId = process.env.FACEBOOK_PAGE_ID;
      if (!pageId) return empty;
      const convRes = await axios.get(`${GRAPH_API}/${pageId}/conversations`, {
        params: {
          fields: "participants",
          user_id: senderId,
          access_token: token,
        },
        timeout: 5000,
      });
      const conv = convRes.data.data?.[0];
      const participant = conv?.participants?.data?.find(
        (p) => p.id === senderId,
      );
      if (participant?.name && !isLikelyRawId(participant.name)) {
        return { name: participant.name, avatar: null };
      }
    } catch {
      // fallback failed too
    }
    return empty;
  };

  // While the app lacks Advanced Access, individual profile lookups fail for
  // every real customer — skip them entirely (the gate re-probes hourly, so
  // this heals itself the moment Meta approves App Review).
  if (isBlocked(platform)) {
    return platform === "facebook" ? facebookConversationsFallback() : empty;
  }

  try {
    if (!_picSupported[platform]) {
      return await fetchProfile(nameFields);
    }
    return await fetchProfile(`${nameFields},profile_pic`);
  } catch {
    try {
      if (_picSupported[platform]) {
        _picSupported[platform] = false;
        console.warn(
          `[Webhook] profile_pic unavailable for ${platform} — name-only lookups from now on`,
        );
      }
      return await fetchProfile(nameFields);
    } catch (err) {
      reportGraphError(platform, err);
      if (platform === "facebook") {
        return facebookConversationsFallback();
      }
      return empty;
    }
  }
}

// ─── Ad-referral buffer ──────────────────────────────────────────────────────
// Messenger delivers ad referrals for EXISTING threads as a standalone
// messaging_referrals event, separate from the message the user then types.
// We cache the parsed context briefly and attach it to the sender's next
// message so the inbox can show "replied to this ad" on the right bubble.
const _pendingReferrals = new Map(); // "<platform>:<senderId>" -> { context, at }
const REFERRAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFERRAL_MAX_ENTRIES = 500;

function rememberReferral(platform, senderId, context) {
  if (!senderId || !context) return;
  // Bounded: evict the oldest entry when full (Map preserves insertion order)
  if (_pendingReferrals.size >= REFERRAL_MAX_ENTRIES) {
    const oldest = _pendingReferrals.keys().next().value;
    _pendingReferrals.delete(oldest);
  }
  _pendingReferrals.set(`${platform}:${senderId}`, {
    context,
    at: Date.now(),
  });
}

function takeReferral(platform, senderId) {
  if (!senderId) return null;
  const key = `${platform}:${senderId}`;
  const hit = _pendingReferrals.get(key);
  if (!hit) return null;
  _pendingReferrals.delete(key);
  if (Date.now() - hit.at > REFERRAL_TTL_MS) return null;
  return hit.context;
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

// Verify Meta's X-Hub-Signature-256 HMAC on webhook POSTs.
// Requires req.rawBody captured by express.json({ verify }) in server/index.js.
// Enforced only when FACEBOOK_APP_SECRET is configured, so local setups
// without a secret keep working.
const verifyMetaSignature = (req, res, next) => {
  const secret = process.env.FACEBOOK_APP_SECRET;
  if (!secret) return next();

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) {
    console.warn(
      `[Webhook] Rejected ${req.path}: missing signature header or raw body`,
    );
    return res.sendStatus(401);
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    console.warn(`[Webhook] Rejected ${req.path}: invalid signature`);
    return res.sendStatus(401);
  }

  return next();
};

// ============ WHATSAPP WEBHOOKS ============

// GET - WhatsApp webhook verification
router.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified");
    return res.status(200).type("text/plain").send(String(challenge).replace(/[^0-9]/g, ''));
  }
  return res.sendStatus(403);
});

// POST - Receive WhatsApp messages
router.post("/whatsapp", verifyMetaSignature, async (req, res) => {
  logWebhook("whatsapp", "POST", `object=${req.body?.object}`);
  res.sendStatus(200); // Acknowledge immediately — prevents Meta retries on slow processing
  const body = req.body;
  const io = req.app.get("io");
  try {
    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field === "messages") {
            const value = change.value;
            const messages = value.messages || [];

            for (const msg of messages) {
              const contact = value.contacts?.[0];
              const waName =
                contact?.profile?.name || contact?.wa_id || msg.from;

              const { conversation } = await getOrCreateConversation({
                platform: "whatsapp",
                externalSenderId: msg.from,
                senderName: waName,
              });

              const safeMsgId = sanitizeId(msg.id);
              const safeMsgFrom = sanitizeId(msg.from);
              if (!safeMsgId || !safeMsgFrom) continue;

              // Media (image/video/audio/document/sticker) + CTWA ad referral
              const waAttachments = parseWhatsAppAttachments(msg);
              const waContext = parseWhatsAppReferral(msg.referral);
              const waText = whatsAppMessageText(msg);

              const newMessage = await Message.findOneAndUpdate(
                { externalId: safeMsgId },
                {
                  $setOnInsert: {
                    platform: "whatsapp",
                    conversationId: msg.from,
                    senderId: msg.from,
                    senderName: waName,
                    recipientId: value.metadata.phone_number_id,
                    content: waText,
                    messageType:
                      msg.type === "reaction"
                        ? "reaction"
                        : messageTypeFor(waAttachments),
                    attachments: waAttachments,
                    context: waContext,
                    direction: "incoming",
                    status: "delivered",
                    externalId: msg.id,
                    timestamp: new Date(),
                  },
                },
                { upsert: true, new: true }
              );

              console.log("[Webhook:WhatsApp] Message saved/upserted:", newMessage._id);

              await updateConversationAfterMessage(conversation._id, newMessage);

              // Emit real-time event with formatted data
              if (io) {
                io.emit("newMessage", {
                  platform: "whatsapp",
                  message: {
                    id: msg.id,
                    text: waText,
                    from: waName,
                    fromId: msg.from,
                    time: new Date().toISOString(),
                    attachments: waAttachments,
                    context: waContext,
                  },
                  conversationId: msg.from,
                  senderId: msg.from,
                  senderName: waName,
                });
              }
            }

            // Handle status updates
            const statuses = value.statuses || [];
            for (const status of statuses) {
              const safeStatusId = sanitizeId(status.id);
              const safeStatusVal = sanitizeId(status.status);
              if (!safeStatusId || !safeStatusVal) continue;
              await Message.findOneAndUpdate(
                { externalId: safeStatusId },
                { status: safeStatusVal },
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
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
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
    return res.status(200).type("text/plain").send(String(challenge).replace(/[^0-9]/g, ''));
  }
  return res.sendStatus(403);
});

// POST - Receive Instagram messages
router.post("/instagram", verifyMetaSignature, async (req, res) => {
  const body = req.body;
  logWebhook(
    "instagram",
    "POST",
    `object=${body?.object}, entries=${body?.entry?.length}, keys=${body?.entry?.map((e) => Object.keys(e).join("/")).join("; ")}`,
  );

  res.sendStatus(200); // Acknowledge immediately — prevents Meta retries on slow processing
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

          // Standalone ad referral (arrives before/without a message when a
          // user taps a Click-to-Instagram ad). Cached so the next message in
          // this thread can be attributed to the ad.
          if (event.referral && !event.message) {
            const standalone = parseMetaReferral(event.referral);
            if (standalone && senderId) {
              rememberReferral("instagram", senderId, standalone);
              console.log(
                `[Webhook:IG] Ad referral cached for ${senderId}:`,
                standalone.title || standalone.adId,
              );
            }
          }

          if (event.message) {
            const msgText = event.message.text || "";
            const msgMid = event.message.mid;
            const msgTime = new Date().toISOString();
            const igAttachments = parseMetaAttachments(event.message);
            const igContext =
              parseMessageContext(event.message) ||
              takeReferral("instagram", senderId);

            console.log(
              `Instagram incoming msg from ${senderId}: "${msgText.slice(0, 80)}" mid=${msgMid}`,
            );

            // --- Emit socket event IMMEDIATELY with a placeholder name ---
            // This ensures the client gets the notification and sees the message
            // without waiting for the slow Graph API name lookup + DB operations.
            const placeholderName = `User ${senderId.slice(-4)}`;
            if (io) {
              io.emit("newMessage", {
                platform: "instagram",
                message: {
                  id: msgMid,
                  text: msgText,
                  from: placeholderName,
                  fromId: senderId,
                  time: msgTime,
                  attachments: igAttachments,
                  context: igContext,
                },
                conversationId: senderId,
                senderId: senderId,
                senderName: placeholderName,
              });
              console.log("[Socket] IG newMessage emitted immediately (placeholder):", msgMid);
            }

            // --- Now do the slow work: profile resolution, DB upsert, conversation sync ---
            const igProfile = await getSenderProfile(senderId, "instagram");
            const igDisplayName = igProfile.name || placeholderName;

            // Resolve Conversation document (creates Channel + Contact if needed)
            const { conversation: igConv } = await getOrCreateConversation({
              platform: "instagram",
              externalSenderId: senderId,
              senderName: igDisplayName,
              senderAvatar: igProfile.avatar,
            });

            // Upsert to DB (avoids duplicate errors if webhook fires twice)
            const safeMsgMid = sanitizeId(msgMid);
            if (!safeMsgMid) {
              console.warn("[Webhook:IG] Skipping message with invalid mid");
              continue;
            }
            const igSavedMsg = await Message.findOneAndUpdate(
              { externalId: safeMsgMid },
              {
                $setOnInsert: {
                  platform: "instagram",
                  conversationId: senderId,
                  senderId: senderId,
                  senderName: igDisplayName,
                  recipientId: recipientId,
                  content: msgText,
                  messageType: messageTypeFor(igAttachments),
                  attachments: igAttachments,
                  context: igContext,
                  direction: "incoming",
                  status: "delivered",
                  externalId: msgMid,
                  timestamp: new Date(),
                },
              },
              { upsert: true, new: true, includeResultMetadata: true },
            );

            const wasInserted = igSavedMsg.lastErrorObject?.updatedExisting === false;
            if (wasInserted) {
              const savedDoc = igSavedMsg.value;
              // Update Conversation lastMessage/counters
              await updateConversationAfterMessage(igConv._id, savedDoc);

              console.log("[DB] Instagram message saved:", msgMid);
              instagramRoute.clearCache();

              // If we resolved a real name (different from placeholder), emit an
              // update so the client can patch the sender name in-place.
              if (igDisplayName !== placeholderName && io) {
                io.emit("newMessage", {
                  platform: "instagram",
                  message: {
                    id: msgMid,
                    text: msgText,
                    from: igDisplayName,
                    fromId: senderId,
                    time: msgTime,
                    attachments: igAttachments,
                    context: igContext,
                  },
                  conversationId: senderId,
                  senderId: senderId,
                  senderName: igDisplayName,
                  senderAvatar: igProfile.avatar,
                });
                console.log("[Socket] IG newMessage name-update emitted:", msgMid, igDisplayName);
              }
            } else {
              console.log("[DB] Instagram message already exists (duplicate webhook):", msgMid);
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
  } catch (error) {
    console.error("Instagram webhook error:", error);
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
    return res.status(200).type("text/plain").send(String(challenge).replace(/[^0-9]/g, ''));
  }
  return res.sendStatus(403);
});

// POST - Receive Facebook Messenger messages
router.post("/facebook", verifyMetaSignature, async (req, res) => {
  logWebhook(
    "facebook",
    "POST",
    `object=${req.body?.object}, entries=${req.body?.entry?.length}`,
  );
  res.sendStatus(200); // Acknowledge immediately — prevents Meta retries on slow processing
  const body = req.body;
  const io = req.app.get("io");
  try {
    if (body.object === "page") {
      for (const entry of body.entry || []) {
        const messaging = entry.messaging || [];

        for (const event of messaging) {
          const senderId = event.sender?.id;
          const recipientId = event.recipient?.id;

          // Skip messages sent by the page itself
          if (senderId === process.env.FACEBOOK_PAGE_ID) continue;

          // Skip Instagram messages arriving via Page subscription —
          // these are already handled by the dedicated /instagram webhook.
          const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
          const isInstagramMsg = igAccountId && recipientId === igAccountId;
          if (isInstagramMsg) {
            console.log(
              "INFO: Skipping Instagram message in Facebook webhook (handled by /instagram route)",
            );
            continue;
          }
          const detectedPlatform = "facebook";

          // Standalone messaging_referrals event: user tapped a
          // Click-to-Messenger ad on an existing thread. Cache it so the
          // message that follows gets attributed to the ad.
          if (event.referral && !event.message) {
            const standalone = parseMetaReferral(event.referral);
            if (standalone && senderId) {
              rememberReferral("facebook", senderId, standalone);
              console.log(
                `[Webhook:FB] Ad referral cached for ${senderId}:`,
                standalone.title || standalone.adId,
              );
            }
          }
          // Get-Started postbacks from ads carry the referral inside postback
          if (event.postback?.referral && senderId) {
            const pbReferral = parseMetaReferral(event.postback.referral);
            if (pbReferral) rememberReferral("facebook", senderId, pbReferral);
          }

          // Handle incoming messages
          if (event.message) {
            const message = event.message;
            const fbAttachments = parseMetaAttachments(message);
            const fbContext =
              parseMessageContext(message) ||
              takeReferral("facebook", senderId);
            console.log(
              `New ${detectedPlatform} message from ${senderId}: ${message.text}`,
            );

            // Look up sender profile (name + picture)
            const fbProfile = await getSenderProfile(
              senderId,
              detectedPlatform,
            );
            const fbSenderName =
              fbProfile.name || `User ${senderId.slice(-4)}`;

            // Resolve Conversation document (creates Channel + Contact if needed)
            const { conversation: fbConv } = await getOrCreateConversation({
              platform: detectedPlatform,
              externalSenderId: senderId,
              senderName: fbSenderName,
              senderAvatar: fbProfile.avatar,
            });

            const safeFbMid = sanitizeId(message.mid);
            const fbSavedMsg = await Message.findOneAndUpdate(
              { externalId: safeFbMid },
              {
                $setOnInsert: {
                  platform: detectedPlatform,
                  conversationId: senderId,
                  senderId: senderId,
                  senderName: fbSenderName,
                  recipientId: recipientId,
                  content: message.text || "",
                  messageType: messageTypeFor(fbAttachments),
                  attachments: fbAttachments,
                  context: fbContext,
                  direction: "incoming",
                  status: "delivered",
                  externalId: message.mid,
                  timestamp: new Date(),
                },
              },
              { upsert: true, new: true, includeResultMetadata: true },
            );

            // Only emit socket event if this was a NEW insert (not a duplicate upsert)
            const fbWasInserted = fbSavedMsg.lastErrorObject?.updatedExisting === false;
            if (fbWasInserted) {
              const savedDoc = fbSavedMsg.value;
              // Update Conversation lastMessage/counters
              await updateConversationAfterMessage(fbConv._id, savedDoc);

              console.log(`[DB] ${detectedPlatform} message saved:`, message.mid);
              facebookRoute.clearCache();

              // Emit exactly once with the resolved name
              if (io) {
                io.emit("newMessage", {
                  platform: detectedPlatform,
                  message: {
                    id: message.mid,
                    text: message.text || "",
                    from: fbSenderName,
                    fromId: senderId,
                    time: new Date().toISOString(),
                    attachments: fbAttachments,
                    context: fbContext,
                  },
                  conversationId: senderId,
                  senderId: senderId,
                  senderName: fbSenderName,
                  senderAvatar: fbProfile.avatar,
                });
                console.log(`[Socket] ${detectedPlatform} newMessage emitted:`, message.mid);
              }
            } else {
              console.log(`[DB] ${detectedPlatform} message already exists, skipping emit:`, message.mid);
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
  } catch (error) {
    console.error("Facebook webhook error:", error);
  }
});

module.exports = router;
