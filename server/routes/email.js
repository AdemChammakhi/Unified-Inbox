const express = require("express");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const router = express.Router();
const Message = require("../models/Message");
const ConversationLock = require("../models/ConversationLock");
const { protect } = require("../middleware/auth");

// Helper: connect to IMAP and fetch emails
function fetchEmails(limit = 50) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.EMAIL_USER,
      password: process.env.EMAIL_PASSWORD,
      host: process.env.EMAIL_IMAP_HOST,
      port: parseInt(process.env.EMAIL_IMAP_PORT || "993"),
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 8000,
    });

    const timer = setTimeout(() => {
      imap.destroy();
      reject(new Error("IMAP connection timed out after 10s"));
    }, 12000);

    const emails = [];

    imap.once("ready", () => {
      imap.openBox("INBOX", true, (err, box) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        const total = box.messages.total;
        if (total === 0) {
          imap.end();
          return resolve([]);
        }

        const start = Math.max(1, total - limit + 1);
        const fetch = imap.seq.fetch(`${start}:${total}`, {
          bodies: "",
          struct: true,
        });

        fetch.on("message", (msg) => {
          msg.on("body", (stream) => {
            simpleParser(stream, (err, parsed) => {
              if (err) return;
              // Convert inline CID attachments to base64 data URIs
              let htmlContent = parsed.html || "";
              const inlineAttachments = [];
              if (parsed.attachments && parsed.attachments.length > 0) {
                for (const att of parsed.attachments) {
                  if (att.contentId && att.content) {
                    const cid = att.contentId.replace(/[<>]/g, "");
                    const base64 = att.content.toString("base64");
                    const dataUri = `data:${att.contentType};base64,${base64}`;
                    htmlContent = htmlContent.replace(
                      new RegExp(
                        `cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
                        "gi",
                      ),
                      dataUri,
                    );
                  }
                  // Also expose non-inline attachments with base64 data
                  if (att.content && att.contentType) {
                    inlineAttachments.push({
                      filename: att.filename || "attachment",
                      contentType: att.contentType,
                      size: att.size,
                      url: `data:${att.contentType};base64,${att.content.toString("base64")}`,
                    });
                  }
                }
              }

              emails.push({
                id: parsed.messageId || `email_${Date.now()}_${Math.random()}`,
                from: parsed.from?.text || "Unknown",
                fromAddress: parsed.from?.value?.[0]?.address || "",
                to: parsed.to?.text || "",
                toAddress: parsed.to?.value?.[0]?.address || "",
                subject: parsed.subject || "(No Subject)",
                text: parsed.text || "",
                html: htmlContent,
                date: parsed.date || new Date(),
                attachments: inlineAttachments,
              });
            });
          });
        });

        fetch.once("error", (err) => {
          clearTimeout(timer);
          imap.end();
          reject(err);
        });

        fetch.once("end", () => {
          imap.end();
          // Wait a bit for all parsers to finish
          setTimeout(() => {
            clearTimeout(timer);
            resolve(emails);
          }, 500);
        });
      });
    });

    imap.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    imap.connect();
  });
}

// GET /api/email/conversations — Fetch emails grouped by sender
router.get("/conversations", protect, async (req, res) => {
  try {
    if (
      !process.env.EMAIL_USER ||
      !process.env.EMAIL_PASSWORD ||
      !process.env.EMAIL_IMAP_HOST
    ) {
      // Email not configured — return empty list instead of erroring
      return res.json({ conversations: [] });
    }

    let emails = [];
    try {
      emails = await fetchEmails(100);
    } catch (imapErr) {
      console.error("IMAP connection error:", imapErr.message);
      return res.json({ conversations: [], error: imapErr.message });
    }

    // Group by sender address into "conversations"
    const convMap = {};
    emails.forEach((email) => {
      const senderAddr = email.fromAddress || email.from;
      if (!convMap[senderAddr]) {
        convMap[senderAddr] = {
          id: senderAddr,
          email: senderAddr,
          subject: email.subject,
          participants: [
            { id: senderAddr, name: email.from, email: senderAddr },
          ],
          messages: [],
          lastMessage: null,
        };
      }
      convMap[senderAddr].messages.push({
        id: email.id,
        text: email.text,
        html: email.html,
        from: email.from,
        fromId: email.fromAddress,
        time: email.date,
        subject: email.subject,
        attachments: email.attachments || [],
      });
    });

    // Sort messages within each conversation and set lastMessage
    const conversations = Object.values(convMap).map((conv) => {
      conv.messages.sort((a, b) => new Date(a.time) - new Date(b.time));
      conv.lastMessage = conv.messages[conv.messages.length - 1]
        ? {
            text: conv.messages[conv.messages.length - 1].text?.substring(
              0,
              100,
            ),
            from: conv.messages[conv.messages.length - 1].from,
            time: conv.messages[conv.messages.length - 1].time,
          }
        : null;

      // Sync messages to DB (non-blocking)
      for (const m of conv.messages) {
        Message.findOneAndUpdate(
          { externalId: m.id },
          {
            $setOnInsert: {
              platform: "email",
              conversationId: conv.id,
              senderId: m.fromId || "unknown",
              senderName: m.from || "Unknown",
              recipientId: process.env.EMAIL_USER,
              content: m.text || "",
              messageType: "text",
              direction:
                m.fromId === process.env.EMAIL_USER ? "outgoing" : "incoming",
              status: "delivered",
              externalId: m.id,
              timestamp: m.time,
            },
          },
          { upsert: true },
        ).catch((err) =>
          console.error("Email message sync error (non-fatal):", err.message),
        );
      }

      return conv;
    });

    // Sort conversations by latest message
    conversations.sort((a, b) => {
      const timeA = a.lastMessage?.time ? new Date(a.lastMessage.time) : 0;
      const timeB = b.lastMessage?.time ? new Date(b.lastMessage.time) : 0;
      return timeB - timeA;
    });

    return res.json({ conversations });
  } catch (error) {
    console.error("Email fetch error:", error.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch emails: " + error.message });
  }
});

// POST /api/email/send — Send an email reply
router.post("/send", protect, async (req, res) => {
  try {
    const { to, subject, text, conversationId } = req.body;

    if (!to || !text) {
      return res.status(400).json({ message: "to and text are required" });
    }

    // --- Conversation Lock Check ---
    const lockConvId = conversationId || to;
    const existingLock = await ConversationLock.findOne({
      conversationId: lockConvId,
      platform: "email",
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
        platform: "email",
        lockedBy: req.user._id,
      });
    }

    if (
      !process.env.EMAIL_USER ||
      !process.env.EMAIL_PASSWORD ||
      !process.env.EMAIL_SMTP_HOST
    ) {
      return res.status(400).json({
        message: "Email SMTP configuration missing in .env",
      });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SMTP_HOST,
      port: parseInt(process.env.EMAIL_SMTP_PORT || "587"),
      secure: process.env.EMAIL_SMTP_PORT === "465",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    const info = await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || "Unified Inbox"}" <${process.env.EMAIL_USER}>`,
      to,
      subject: subject || "Message from Unified Inbox",
      text,
    });

    // Sync sent email to DB
    await Message.create({
      platform: "email",
      conversationId: to,
      senderId: process.env.EMAIL_USER,
      senderName: process.env.EMAIL_FROM_NAME || "Unified Inbox",
      recipientId: to,
      content: text,
      messageType: "text",
      direction: "outgoing",
      status: "sent",
      externalId: info.messageId,
      timestamp: new Date(),
    });

    // Emit via Socket.IO
    const io = req.app.get("io");
    if (io) {
      io.emit("messageSent", {
        platform: "email",
        recipientId: to,
        message: {
          id: info.messageId,
          text,
          from: process.env.EMAIL_FROM_NAME || "Unified Inbox",
          fromId: process.env.EMAIL_USER,
          time: new Date().toISOString(),
        },
      });
    }

    return res.json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error("Email send error:", error.message);
    return res
      .status(500)
      .json({ message: "Failed to send email: " + error.message });
  }
});

module.exports = router;
