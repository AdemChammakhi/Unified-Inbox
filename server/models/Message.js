const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: [
        "instagram",
        "whatsapp",
        "messenger",
        "facebook",
        "email",
        "tiktok",
      ],
      required: true,
    },
    conversationId: {
      type: String,
      required: true,
    },
    senderId: {
      type: String,
      required: true,
    },
    senderName: {
      type: String,
      default: "Unknown",
    },
    recipientId: {
      type: String,
    },
    content: {
      type: String,
      default: "",
    },
    messageType: {
      type: String,
      enum: [
        "text",
        "image",
        "video",
        "audio",
        "document",
        "reaction",
        "other",
      ],
      default: "text",
    },
    attachmentUrl: {
      type: String,
    },
    direction: {
      type: String,
      enum: ["incoming", "outgoing"],
      default: "incoming",
    },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed"],
      default: "delivered",
    },
    externalId: {
      type: String,
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// Index for fast lookup
messageSchema.index({ platform: 1, conversationId: 1 });
messageSchema.index({ platform: 1, senderId: 1 });

// Compound index for paginated message fetch sorted by time (most common query pattern)
messageSchema.index(
  { platform: 1, conversationId: 1, timestamp: -1 },
  { name: "messages_paged" },
);
// For recent-messages scan used by the DB-merge pass in instagram/facebook routes
messageSchema.index(
  { platform: 1, timestamp: -1 },
  { name: "messages_recent" },
);
// For webhook upsert lookups by external platform message ID
messageSchema.index(
  { externalId: 1 },
  { sparse: true, name: "messages_extId" },
);

module.exports = mongoose.model("Message", messageSchema);
