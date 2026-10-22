/**
 * MessageTemplate.js — canned replies agents reuse from the inbox.
 *
 * A template is a case title ("Demande de devis Omra") and the full message
 * to send. Agents pick one next to the discussion and insert or copy it;
 * admins and managers maintain the list on the "Modèles de messages" page.
 *
 * The body may carry placeholders filled on the client at insert time:
 * {{prenom}}, {{nom}} (the customer) and {{agent}} (the signed-in user).
 */

const mongoose = require("mongoose");

const PLATFORMS = ["instagram", "facebook", "whatsapp", "email"];

const messageTemplateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 4096 },
    /** Free grouping label shown as a filter chip ("Omra", "Visa", "Relance"…). */
    category: { type: String, default: "", trim: true, maxlength: 60 },
    /** Empty means every platform; otherwise the platforms it is offered on. */
    platforms: {
      type: [{ type: String, enum: PLATFORMS }],
      default: [],
    },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    usageCount: { type: Number, default: 0 },
    /**
     * Present only on templates loaded from MEDTOURS' official library
     * (server/data/messageTemplates.seed.json, db/seedMessageTemplates.js).
     * No default on purpose: the unique index is sparse, and a stored null
     * would make the second hand-made template collide.
     */
    seedKey: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

messageTemplateSchema.index({ isActive: 1, category: 1, sortOrder: 1, title: 1 });
messageTemplateSchema.index({ seedKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("MessageTemplate", messageTemplateSchema);
module.exports.PLATFORMS = PLATFORMS;
