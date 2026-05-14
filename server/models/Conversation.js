/**
 * Conversation.js
 *
 * Central collection for multi-platform conversations.
 *
 * Design decisions:
 *  - lastMessage is EMBEDDED (denormalized) so the inbox list never needs a
 *    $lookup into messages — O(1) inbox rendering.
 *  - unreadCount is an atomic counter maintained via $inc so reads are free.
 *  - classification + lock are embedded to eliminate join collections for the
 *    hot inbox path.  The legacy Classification / ConversationLock collections
 *    can remain for audit history.
 *  - contactId references a Contact document that unifies the same person
 *    across Facebook, Instagram, WhatsApp, and Email.
 *  - channelId references which connected account/page received the thread.
 */

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Embedded sub-schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of the most recent message.
 * Updated atomically on every new message via $set inside a findOneAndUpdate.
 * This makes inbox list sorting and preview rendering a single-collection scan.
 */
const lastMessageSchema = new mongoose.Schema(
  {
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
    content: { type: String, default: "" },
    type: {
      type: String,
      enum: [
        "text",
        "image",
        "video",
        "audio",
        "document",
        "reaction",
        "sticker",
        "location",
        "template",
        "unsupported",
      ],
      default: "text",
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      default: "inbound",
    },
    senderName: { type: String, default: "" },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * Per-agent unread counter.
 * Allows each agent in a multi-agent workspace to track their own read state
 * independently from the global unreadCount.
 */
const agentUnreadSchema = new mongoose.Schema(
  {
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    count: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Main schema
// ─────────────────────────────────────────────────────────────────────────────

const conversationSchema = new mongoose.Schema(
  {
    // ── Platform & external identity ────────────────────────────────────────
    platform: {
      type: String,
      enum: ["facebook", "instagram", "whatsapp", "email", "tiktok"],
      required: true,
    },
    /**
     * The ID issued by the external platform (e.g. Meta thread key, IMAP
     * Message-ID thread root, WhatsApp chat ID).
     * Combined with `platform` this is globally unique per conversation.
     */
    externalId: {
      type: String,
      required: true,
    },

    // ── Channel reference ───────────────────────────────────────────────────
    /**
     * Which connected account/page/inbox this conversation belongs to.
     * E.g. "Acme Facebook Page", "Support WhatsApp number", etc.
     */
    channelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Channel",
      required: true,
    },

    // ── Unified contact ─────────────────────────────────────────────────────
    /**
     * Reference to the Contact document that may consolidate the same person
     * across multiple platforms.  Null until the contact is resolved/merged.
     */
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
    },

    // ── Participant snapshot (cached from Contact, avoids $lookup on hot path)
    participantName: { type: String, default: "Unknown" },
    participantAvatar: { type: String, default: null },
    participantExternalId: { type: String }, // platform-native sender ID

    // ── Denormalized last message ───────────────────────────────────────────
    lastMessage: { type: lastMessageSchema, default: () => ({}) },

    // ── Read/unread counters ────────────────────────────────────────────────
    /** Global unread count — incremented on every inbound message. */
    unreadCount: { type: Number, default: 0, min: 0 },
    /** Per-agent unread counters for multi-agent workspaces. */
    agentUnread: { type: [agentUnreadSchema], default: [] },
    /** Running total messages (maintained via $inc). */
    messageCount: { type: Number, default: 0, min: 0 },

    // ── Workflow ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["open", "resolved", "snoozed", "pending", "spam"],
      default: "open",
    },
    /** Agent currently handling this conversation. */
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    snoozedUntil: { type: Date, default: null },

    // ── Embedded classification (replaces separate Classification join) ─────
    classification: {
      type: String,
      enum: ["cible", "hors_cible", "non_classifie", "suivi", "priorite"],
      default: "non_classifie",
    },
    classifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    classifiedAt: { type: Date },

    // ── Embedded lock (replaces ConversationLock join on inbox path) ────────
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lockedAt: { type: Date, default: null },

    // ── Tagging ─────────────────────────────────────────────────────────────
    tags: { type: [String], default: [] },

    // ── AI enrichment ───────────────────────────────────────────────────────
    aiSummary: { type: String, default: null },
    aiSentiment: {
      type: String,
      enum: ["positive", "neutral", "negative", null],
      default: null,
    },
    aiTopics: { type: [String], default: [] },

    // ── Platform-specific extras ────────────────────────────────────────────
    platformMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Soft delete ─────────────────────────────────────────────────────────
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────────────────────

// Uniqueness: exactly one conversation per platform+externalId
conversationSchema.index(
  { platform: 1, externalId: 1 },
  { unique: true, name: "uniq_platform_externalId" },
);

// Primary inbox query: filter by channel+status, sort newest-last-message first
conversationSchema.index(
  { channelId: 1, status: 1, "lastMessage.sentAt": -1 },
  { name: "inbox_channel" },
);

// Global inbox sorted by recency (no channel filter)
conversationSchema.index(
  { status: 1, "lastMessage.sentAt": -1 },
  { name: "inbox_global" },
);

// Agent assignment queue
conversationSchema.index(
  { assignedTo: 1, status: 1, "lastMessage.sentAt": -1 },
  { name: "inbox_agent" },
);

// Unread-only filter
conversationSchema.index(
  { unreadCount: 1, status: 1 },
  { name: "filter_unread" },
);

// All conversations for a contact (contact history)
conversationSchema.index(
  { contactId: 1, "lastMessage.sentAt": -1 },
  { name: "contact_history" },
);

// Tag filtering
conversationSchema.index({ tags: 1 }, { name: "filter_tags" });

// Soft-delete exclusion
conversationSchema.index({ deletedAt: 1 }, { name: "soft_delete" });

// Full-text search on participant name
conversationSchema.index(
  { participantName: "text" },
  { name: "text_participantName" },
);

// ─────────────────────────────────────────────────────────────────────────────
// Virtuals
// ─────────────────────────────────────────────────────────────────────────────

conversationSchema.virtual("isLocked").get(function () {
  return this.lockedBy != null;
});

conversationSchema.virtual("isSnoozed").get(function () {
  return this.snoozedUntil != null && this.snoozedUntil > new Date();
});

// ─────────────────────────────────────────────────────────────────────────────
// Instance methods
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically push a new-message update onto the conversation.
 * Call this inside the same transaction/operation as Message.create().
 *
 * @param {object} message - Saved Message document
 */
conversationSchema.methods.applyNewMessage = function (message) {
  const inc = { messageCount: 1 };
  if (message.direction === "inbound") inc.unreadCount = 1;

  return mongoose.model("Conversation").findByIdAndUpdate(
    this._id,
    {
      $set: {
        lastMessage: {
          messageId: message._id,
          content: message.text || "",
          type: message.type,
          direction: message.direction,
          senderName: message.sender?.name || "",
          sentAt: message.createdAt || new Date(),
        },
      },
      $inc: inc,
    },
    { new: true },
  );
};

/**
 * Mark all messages as read for an agent.
 */
conversationSchema.methods.markReadBy = function (agentId) {
  return mongoose.model("Conversation").findByIdAndUpdate(
    this._id,
    {
      $set: { unreadCount: 0 },
      $pull: { agentUnread: { agentId } },
    },
    { new: true },
  );
};

module.exports = mongoose.model("Conversation", conversationSchema);
