const express = require("express");
const router = express.Router();

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
            value.messages.forEach((message) => {
              const from = message.from; // sender phone number
              const timestamp = message.timestamp;
              const type = message.type;

              console.log(`New WhatsApp message from ${from} at ${timestamp}`);

              if (type === "text") {
                console.log(`Text: ${message.text.body}`);
              } else if (type === "image") {
                console.log(`Image received: ${message.image.id}`);
              } else if (type === "document") {
                console.log(`Document received: ${message.document.id}`);
              }

              // TODO: Save message to database
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
router.post("/instagram", (req, res) => {
  const body = req.body;

  if (body.object === "instagram") {
    body.entry?.forEach((entry) => {
      // Handle messaging events
      if (entry.messaging) {
        entry.messaging.forEach((event) => {
          const senderId = event.sender?.id;
          const timestamp = event.timestamp;

          // Handle incoming messages
          if (event.message) {
            const message = event.message;
            console.log(
              `New Instagram message from ${senderId} at ${timestamp}`,
            );

            if (message.text) {
              console.log(`Text: ${message.text}`);
            }
            if (message.attachments) {
              message.attachments.forEach((att) => {
                console.log(
                  `Attachment type: ${att.type}, URL: ${att.payload?.url}`,
                );
              });
            }

            // TODO: Save message to database
          }

          // Handle message reactions
          if (event.reaction) {
            console.log(
              `Reaction from ${senderId}: ${event.reaction.reaction} on message ${event.reaction.mid}`,
            );

            // TODO: Save reaction to database
          }
        });
      }
    });

    return res.status(200).json({ status: "ok" });
  }

  return res.status(404).json({ message: "Not an Instagram event" });
});

module.exports = router;
