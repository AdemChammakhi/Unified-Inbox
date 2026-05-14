/**
 * Channel.js
 *
 * A connected platform account (Facebook Page, Instagram Professional Account,
 * WhatsApp Business number, Email inbox, etc.).
 *
 * Design decisions:
 *  - Credentials (access tokens) are never stored as plaintext here.
 *    accessTokenRef holds a key name pointing to a secret manager entry or
 *    environment variable.  The actual token is resolved at runtime.
 *  - Email configuration (IMAP/SMTP) is nested but never exposes passwords;
 *    those live in the environment.
 *  - Multiple Channel documents can exist for the same platform
 *    (e.g. two Facebook Pages for different brands).
 */

const mongoose = require("mongoose");

const channelSchema = new mongoose.Schema(
  {
    // ── Identity ───────────────────────────────────────────────────────────
    platform: {
      type: String,
      enum: ["facebook", "instagram", "whatsapp", "email", "tiktok"],
      required: true,
    },
    /** Human-readable label shown in the UI. */
    name: {
      type: String,
      required: true,
      trim: true,
    },
    /** Platform-issued account / page / WABA ID. */
    externalId: {
      type: String,
      required: true,
    },
    avatar: { type: String },

    // ── Credentials (references only — never store tokens directly) ────────
    /**
     * Key name used to retrieve the access token from the secret manager or
     * process.env at runtime.  E.g. "FACEBOOK_PAGE_ACCESS_TOKEN".
     */
    accessTokenRef: { type: String },
    webhookVerifyToken: { type: String },

    // ── Email-specific connection settings ─────────────────────────────────
    emailConfig: {
      imapHost: { type: String },
      imapPort: { type: Number, default: 993 },
      smtpHost: { type: String },
      smtpPort: { type: Number, default: 587 },
      /** Login username (not password — password lives in env). */
      username: { type: String },
    },

    // ── Status ─────────────────────────────────────────────────────────────
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },

    // ── Auto-reply ─────────────────────────────────────────────────────────
    autoReply: { type: Boolean, default: false },
    autoReplyMessage: { type: String },

    // ── Team assignment ────────────────────────────────────────────────────
    /** Agents that have access to this channel's inbox. */
    assignedAgents: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // ── Stats (maintained via $inc) ────────────────────────────────────────
    totalConversations: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────────────────────

// Uniqueness: one channel document per platform account
channelSchema.index(
  { platform: 1, externalId: 1 },
  { unique: true, name: "uniq_platform_account" },
);

module.exports = mongoose.model("Channel", channelSchema);
