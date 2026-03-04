const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const router = express.Router();
const Message = require("../models/Message");

const GRAPH_API = "https://graph.facebook.com/v24.0";

// Helper: look up a user's name/username from the Graph API
async function getSenderName(senderId, platform) {
  try {
    const token =
      platform === "facebook"
        ? process.env.FACEBOOK_PAGE_ACCESS_TOKEN
        : process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!token) return senderId;
    const fields =
      platform === "instagram" ? "username,name" : "first_name,last_name,name";
    const res = await axios.get(`${GRAPH_API}/${senderId}`, {
      params: { fields, access_token: token },
    });
    return (
      res.data.username ||
      res.data.name ||
      [res.data.first_name, res.data.last_name].filter(Boolean).join(" ") ||
      senderId
    );
  } catch {
    return senderId;
  }
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
  try {
    const body = req.body;
    const io = req.app.get("io");

    if (body.object === "instagram") {
      for (const entry of body.entry) {
        const messaging = entry.messaging || [];

        for (const event of messaging) {
          if (event.message) {
            // Look up Instagram sender name
            const igSenderName = await getSenderName(
              event.sender.id,
              "instagram",
            );

            const newMessage = await Message.create({
              platform: "instagram",
              conversationId: event.sender.id,
              senderId: event.sender.id,
              senderName: igSenderName,
              recipientId: event.recipient.id,
              content: event.message.text || "",
              messageType: event.message.attachments ? "attachment" : "text",
              direction: "incoming",
              status: "delivered",
              externalId: event.message.mid,
            });

            console.log("Instagram message saved:", newMessage._id);

            // Emit real-time event with formatted data for instant UI update
            if (io) {
              io.emit("newMessage", {
                platform: "instagram",
                message: {
                  id: event.message.mid,
                  text: event.message.text || "",
                  from: igSenderName,
                  fromId: event.sender.id,
                  time: new Date().toISOString(),
                },
                conversationId: event.sender.id,
                senderId: event.sender.id,
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

          // Handle incoming messages
          if (event.message) {
            const message = event.message;
            console.log(
              `New Facebook message from ${senderId}: ${message.text}`,
            );

            // Look up Facebook sender name
            const fbSenderName = await getSenderName(senderId, "facebook");

            const newMessage = await Message.create({
              platform: "facebook",
              conversationId: senderId,
              senderId: senderId,
              senderName: fbSenderName,
              recipientId: recipientId,
              content: message.text || "",
              messageType: message.attachments ? "attachment" : "text",
              direction: "incoming",
              status: "delivered",
              externalId: message.mid,
            });

            console.log("Facebook message saved:", newMessage._id);

            // Emit real-time event with formatted data for instant UI update
            if (io) {
              io.emit("newMessage", {
                platform: "facebook",
                message: {
                  id: message.mid,
                  text: message.text || "",
                  from: senderId,
                  fromId: senderId,
                  time: new Date().toISOString(),
                },
                conversationId: senderId,
                senderId: senderId,
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
