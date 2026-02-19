const express = require("express");
const router = express.Router();
const Message = require("../models/Message");

// GET - Webhook verification (Facebook/Meta verifies your endpoint)
router.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("WhatsApp webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.error("WhatsApp webhook verification failed");
  return res.status(403).json({ message: "Verification failed" });
});

// POST - Receive incoming WhatsApp messages
router.post("/whatsapp", (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    body.entry?.forEach((entry) => {
      entry.changes?.forEach((change) => {
        if (change.field === "messages") {
          const value = change.value;

          // Handle incoming messages
          if (value.messages) {
            value.messages.forEach(async (message) => {
              const from = message.from; // sender phone number
              const timestamp = message.timestamp;
              const type = message.type;

              console.log(`New WhatsApp message from ${from} at ${timestamp}`);

              let content = "";
              let messageType = "text";
              let attachmentUrl = "";

              if (type === "text") {
                content = message.text.body;
              } else if (type === "image") {
                messageType = "image";
                attachmentUrl = message.image.id;
              } else if (type === "document") {
                messageType = "document";
                attachmentUrl = message.document.id;
              }

              // Save message to database
              try {
                await Message.create({
                  platform: "whatsapp",
                  conversationId: from,
                  senderId: from,
                  content,
                  messageType,
                  attachmentUrl,
                  direction: "incoming",
                  externalId: message.id,
                  timestamp: new Date(timestamp * 1000),
                });
              } catch (err) {
                console.error("Error saving WhatsApp message:", err.message);
              }
            });
          }

          // Handle message status updates (sent, delivered, read)
          if (value.statuses) {
            value.statuses.forEach((status) => {
              console.log(
                `Message ${status.id} status: ${status.status} for ${status.recipient_id}`,
              );
            });
          }
        }
      });
    });

    // Always respond with 200 to acknowledge receipt
    return res.status(200).json({ status: "ok" });
  }

  return res.status(404).json({ message: "Not a WhatsApp event" });
});

// GET - Instagram Webhook verification (reuses FACEBOOK_VERIFY_TOKEN)
router.get("/instagram", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.FACEBOOK_VERIFY_TOKEN) {
    console.log("Instagram webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.error("Instagram webhook verification failed");
  return res.status(403).json({ message: "Verification failed" });
});

// POST - Receive incoming Instagram messages and reactions
router.post("/instagram", async (req, res) => {
  const body = req.body;

  if (body.object === "instagram") {
    for (const entry of body.entry || []) {
      // Handle messaging events
      if (entry.messaging) {
        for (const event of entry.messaging) {
          const senderId = event.sender?.id;
          const timestamp = event.timestamp;

          // Handle incoming messages
          if (event.message) {
            const message = event.message;
            console.log(
              `New Instagram message from ${senderId} at ${timestamp}`,
            );

            let content = "";
            let messageType = "text";
            let attachmentUrl = "";

            if (message.text) {
              content = message.text;
            }
            if (message.attachments) {
              message.attachments.forEach((att) => {
                messageType = att.type || "other";
                attachmentUrl = att.payload?.url || "";
              });
            }

            // Save message to database
            try {
              await Message.create({
                platform: "instagram",
                conversationId: senderId,
                senderId: senderId,
                content,
                messageType,
                attachmentUrl,
                direction: "incoming",
                externalId: message.mid,
                timestamp: new Date(timestamp),
              });
            } catch (err) {
              console.error("Error saving Instagram message:", err.message);
            }
          }

          // Handle message reactions
          if (event.reaction) {
            console.log(
              `Reaction from ${senderId}: ${event.reaction.reaction} on message ${event.reaction.mid}`,
            );

            // Save reaction to database
            try {
              await Message.create({
                platform: "instagram",
                conversationId: senderId,
                senderId: senderId,
                content: event.reaction.reaction,
                messageType: "reaction",
                direction: "incoming",
                externalId: event.reaction.mid,
                timestamp: new Date(timestamp),
              });
            } catch (err) {
              console.error("Error saving Instagram reaction:", err.message);
            }
          }
        }
      }
    }

    return res.status(200).json({ status: "ok" });
  }

  return res.status(404).json({ message: "Not an Instagram event" });
});

module.exports = router;
