/**
 * DossierDocument — a file an agent attached to a customer's dossier
 * (invoice, passport / CIN copy, quote, voucher, ticket, administrative
 * paper, other).
 *
 * These are sensitive (passports), so unlike outbound media in
 * server/uploads/ they are NEVER served statically: the file sits under
 * server/uploads/dossiers/ (same persisted volume), server/index.js answers
 * 404 for /uploads/dossiers/*, and the only way to read one is the
 * authenticated download route in routes/dossierDocuments.js.
 *
 * Keyed by the CUSTOMER id, never a t_… thread id (CLAUDE.md §6).
 */

const mongoose = require("mongoose");

/** Mirrored in client/src/constants/dossier.js — keep both in step. */
const DOC_TYPES = [
  "facture",
  "passeport_cin",
  "devis",
  "voucher",
  "billet",
  "administratif",
  "autre",
];

const dossierDocumentSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: ["instagram", "facebook", "whatsapp", "email"],
      required: true,
    },
    /** The customer's own id (IGSID / PSID / phone / email address). */
    customerId: {
      type: String,
      required: true,
      trim: true,
    },
    docType: {
      type: String,
      enum: DOC_TYPES,
      required: true,
    },
    label: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    /** Name the agent's browser gave the file, for display and download. */
    originalName: {
      type: String,
      default: "",
    },
    /** Random name on disk: 32 hex chars plus a sanitized extension. */
    storedName: {
      type: String,
      required: true,
      unique: true,
    },
    mimeType: {
      type: String,
      default: "application/octet-stream",
    },
    size: {
      type: Number,
      default: 0,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// Dossier listing: one customer's documents, newest first
dossierDocumentSchema.index({ platform: 1, customerId: 1, createdAt: -1 });

module.exports = mongoose.model("DossierDocument", dossierDocumentSchema);
module.exports.DOC_TYPES = DOC_TYPES;
