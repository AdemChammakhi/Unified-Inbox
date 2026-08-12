const mongoose = require("mongoose");

/**
 * One media attachment on a message, normalized across platforms.
 * For WhatsApp, `url` is our authenticated proxy path
 * (/api/whatsapp/media/:mediaId) because Meta's media URLs require the
 * access token and expire after ~5 minutes.
 */
const attachmentSchema = new mongoose.Schema(
  {
    type: { type: String }, // image | video | audio | file | sticker | share | story_mention | ...
    url: { type: String },
    name: { type: String },
    mimeType: { type: String },
    /** WhatsApp media ID (fetched through the proxy at display time). */
    mediaId: { type: String },
  },
  { _id: false },
);

/**
 * The ad / post / story a message is replying to.
 * Populated from Meta referral objects (Click-to-Messenger / Click-to-WhatsApp
 * ads), Instagram story replies (reply_to.story) and media shares.
 */
const contextSchema = new mongoose.Schema(
  {
    kind: { type: String }, // ad | post | story_reply | share | story_mention | referral
    source: { type: String }, // ADS | SHORTLINK | ad | post ...
    adId: { type: String },
    title: { type: String },
    body: { type: String },
    photoUrl: { type: String },
    videoUrl: { type: String },
    /** Link to the ad / post / story itself. */
    url: { type: String },
    postId: { type: String },
    productId: { type: String },
    /** Click-to-WhatsApp click ID for ad attribution. */
    ctwaClid: { type: String },
    ref: { type: String },
  },
  { _id: false },
);

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
        "attachment",
        "reaction",
        "other",
      ],
      default: "text",
    },
    /** @deprecated single-URL field kept for old rows — use `attachments`. */
    attachmentUrl: {
      type: String,
    },
    attachments: { type: [attachmentSchema], default: [] },
    context: { type: contextSchema, default: null },
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
