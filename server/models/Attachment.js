/**
 * Attachment.js
 *
 * Metadata record for every file/media attachment across all platforms.
 *
 * Design decisions:
 *  - Kept separate from Message to prevent message documents from growing
 *    unboundedly when attachments carry rich metadata (dimensions, duration,
 *    virus-scan results, CDN URLs).
 *  - conversationId is denormalized here so a "media gallery" query for a
 *    conversation can be served without joining through Message first.
 *  - Binary data is NEVER stored in MongoDB.  Only metadata + CDN/storage URLs.
 *  - storageKey carries a sparse unique index to prevent double-uploads.
 *  - platformUrl (the original URL from the social platform) may expire; once
 *    re-hosted under our CDN the permanent `url` field is used instead.
 */

const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    // ── References ─────────────────────────────────────────────────────────
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
    /** Denormalized for conversation-level gallery queries. */
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },

    // ── File metadata ──────────────────────────────────────────────────────
    originalName: { type: String, default: "attachment" },
    mimeType: { type: String },
    /** File size in bytes. */
    size: { type: Number },

    // ── Storage ────────────────────────────────────────────────────────────
    storageProvider: {
      type: String,
      enum: ["s3", "gcs", "azure", "local", "platform"],
      default: "platform",
    },
    /** Unique key within the storage bucket (e.g. S3 object key). */
    storageKey: { type: String },
    /** Permanent public CDN URL (preferred for display). */
    url: { type: String },
    /** Thumbnail CDN URL for images and videos. */
    thumbnailUrl: { type: String },
    /** Original URL from the platform API — may expire. */
    platformUrl: { type: String },
    /** Platform-issued attachment/media ID. */
    externalId: { type: String },

    // ── Media dimensions ───────────────────────────────────────────────────
    width: { type: Number },
    height: { type: Number },
    /** Duration in seconds for audio and video. */
    duration: { type: Number },

    // ── Security / lifecycle ───────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "uploading", "ready", "failed", "virus_detected"],
      default: "pending",
    },
    virusScanAt: { type: Date },
    virusScanResult: { type: String },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────────────────────

// All attachments for a specific message
attachmentSchema.index({ messageId: 1 }, { name: "by_message" });

// Media gallery for a conversation, newest first
attachmentSchema.index(
  { conversationId: 1, createdAt: -1 },
  { name: "gallery_by_conversation" },
);

// Prevent duplicate uploads (sparse = allows NULL storageKey for platform-only)
attachmentSchema.index(
  { storageKey: 1 },
  { unique: true, sparse: true, name: "uniq_storageKey" },
);

module.exports = mongoose.model("Attachment", attachmentSchema);
