/**
 * Partner.js — the directory of MEDTOUR agencies and B2B partner agencies in
 * Tunisia, used by agents to orient a customer to the nearest office.
 *
 * Seeded once from server/data/partners.seed.json (the spreadsheet management
 * provided), then maintained from the "Agences & partenaires" page. Seeding is
 * idempotent on `seedKey` and never overwrites a row that was edited by hand.
 */

const mongoose = require("mongoose");

const partnerSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["agence", "partenaire"], // Agence MEDTOUR | Partenaire BtoB
      required: true,
    },
    name: { type: String, required: true, trim: true },
    contactName: { type: String, default: "", trim: true },
    phones: { type: [String], default: [] },
    city: { type: String, default: "", trim: true },
    governorate: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true },
    /**
     * Present only on rows that came from the embedded spreadsheet. No
     * default on purpose: the unique index below is sparse, and a stored
     * `null` would still be indexed, so a second hand-made row would collide.
     */
    seedKey: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

partnerSchema.index({ seedKey: 1 }, { unique: true, sparse: true });
partnerSchema.index({ kind: 1, governorate: 1, name: 1 });
partnerSchema.index({ isActive: 1 });

module.exports = mongoose.model("Partner", partnerSchema);
