/**
 * Contact.js
 *
 * A unified contact record that can consolidate the same real-world person
 * across multiple platforms (Facebook, Instagram, WhatsApp, Email).
 *
 * Design decisions:
 *  - platformIdentities is an embedded array.  Each entry holds the
 *    platform-native profile for one platform.  A single person with both a
 *    Facebook and an Instagram account will have two entries here.
 *  - De-duplication is done at the application layer via
 *    Contact.findOrCreateByPlatformId(), which performs an upsert on
 *    (platformIdentities.platform + platformIdentities.externalId).
 *  - email and phone carry sparse unique indexes so they act as merge keys when
 *    available without blocking contacts that lack them.
 *  - Stats (totalConversations, totalMessages) are maintained via atomic $inc
 *    from the service layer, avoiding expensive COUNT aggregations on hot reads.
 */

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Embedded sub-schema: one entry per platform identity
// ─────────────────────────────────────────────────────────────────────────────

const platformIdentitySchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: ["facebook", "instagram", "whatsapp", "email", "tiktok"],
      required: true,
    },
    /** Platform-native user/sender ID (PSID, IGSID, phone number, email, …). */
    externalId: { type: String, required: true },
    username: { type: String },
    name: { type: String },
    avatar: { type: String },
    profileUrl: { type: String },
    /** Raw profile object from the platform Graph API — kept for future use. */
    raw: { type: mongoose.Schema.Types.Mixed },
    lastSeenAt: { type: Date },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Main schema
// ─────────────────────────────────────────────────────────────────────────────

const contactSchema = new mongoose.Schema(
  {
    // ── Resolved (merged) identity ─────────────────────────────────────────
    displayName: { type: String, default: "Unknown" },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    avatar: { type: String },
    timezone: { type: String },
    locale: { type: String },

    // ── Platform identities ────────────────────────────────────────────────
    platformIdentities: { type: [platformIdentitySchema], default: [] },

    // ── CRM / enrichment ──────────────────────────────────────────────────
    companyName: { type: String },
    jobTitle: { type: String },
    tags: { type: [String], default: [] },
    notes: { type: String },
    /** Arbitrary key-value pairs for custom fields. */
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Aggregated stats (maintained via $inc — never recomputed) ──────────
    totalConversations: { type: Number, default: 0, min: 0 },
    totalMessages: { type: Number, default: 0, min: 0 },
    firstContactAt: { type: Date },
    lastContactAt: { type: Date },

    // ── Flags ──────────────────────────────────────────────────────────────
    isBlocked: { type: Boolean, default: false },
    isSpam: { type: Boolean, default: false },
    isVIP: { type: Boolean, default: false },
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

// Primary lookup: find by platform + externalId (webhook entry point)
contactSchema.index(
  { "platformIdentities.platform": 1, "platformIdentities.externalId": 1 },
  { name: "platform_identity_lookup" },
);

// Merge-key uniqueness (sparse so NULL values are not considered duplicates)
contactSchema.index(
  { email: 1 },
  { unique: true, sparse: true, name: "uniq_email" },
);
contactSchema.index(
  { phone: 1 },
  { unique: true, sparse: true, name: "uniq_phone" },
);

// Recent contacts list
contactSchema.index({ lastContactAt: -1 }, { name: "recent_contacts" });

// Tag filter
contactSchema.index({ tags: 1 }, { name: "filter_tags" });

// Full-text search (displayName, email, companyName)
contactSchema.index(
  { displayName: "text", email: "text", companyName: "text" },
  { name: "text_contact" },
);

// ─────────────────────────────────────────────────────────────────────────────
// Static helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an existing contact by platform identity, or create a new one.
 *
 * This is the single entry-point used by all webhook handlers.  It ensures
 * we never create duplicate contacts for the same platform user.
 *
 * @param {string} platform
 * @param {string} externalId   - Platform-native user ID
 * @param {object} profileData  - { name, username, avatar, profileUrl, raw }
 * @returns {Promise<Document>}  The Contact document (new or existing)
 */
contactSchema.statics.findOrCreateByPlatformId = async function (
  platform,
  externalId,
  profileData = {},
) {
  const identityPatch = {
    platform,
    externalId,
    name: profileData.name || profileData.username || "Unknown",
    username: profileData.username || null,
    avatar: profileData.avatar || null,
    profileUrl: profileData.profileUrl || null,
    raw: profileData.raw || null,
    lastSeenAt: new Date(),
  };

  // Try to locate an existing contact for this platform identity
  const existing = await this.findOne({
    "platformIdentities.platform": platform,
    "platformIdentities.externalId": externalId,
  });

  if (existing) {
    // Refresh the identity snapshot without changing the top-level document
    await this.findOneAndUpdate(
      {
        _id: existing._id,
        "platformIdentities.platform": platform,
        "platformIdentities.externalId": externalId,
      },
      {
        $set: {
          "platformIdentities.$": identityPatch,
          lastContactAt: new Date(),
        },
      },
    );
    return existing;
  }

  // Create a brand-new contact with this single identity
  return this.create({
    displayName: identityPatch.name,
    avatar: identityPatch.avatar,
    platformIdentities: [identityPatch],
    firstContactAt: new Date(),
    lastContactAt: new Date(),
  });
};

/**
 * Merge two contacts into one (e.g. when we discover that a Facebook user and
 * an email address belong to the same person).
 *
 * Copies platformIdentities from `sourceId` into `targetId`, then deletes the
 * source.  All Conversation.contactId references must be updated by the caller.
 *
 * @param {ObjectId} targetId   - Contact to keep
 * @param {ObjectId} sourceId   - Contact to absorb and delete
 */
contactSchema.statics.mergeContacts = async function (targetId, sourceId) {
  const source = await this.findById(sourceId);
  if (!source) throw new Error(`Source contact ${sourceId} not found`);

  await this.findByIdAndUpdate(targetId, {
    $push: { platformIdentities: { $each: source.platformIdentities } },
    $inc: {
      totalConversations: source.totalConversations,
      totalMessages: source.totalMessages,
    },
    $set: { lastContactAt: new Date() },
  });

  await this.findByIdAndDelete(sourceId);
};

module.exports = mongoose.model("Contact", contactSchema);
