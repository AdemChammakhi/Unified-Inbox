const mongoose = require("mongoose");
const {
  STAGE_KEYS,
  DEFAULT_STAGE,
  TYPOLOGY_KEYS,
} = require("../constants/pipeline");

/**
 * Classification — the commercial record ("dossier") of one customer on one
 * platform, keyed by the CUSTOMER id (never the t_… thread id; see CLAUDE.md
 * §6). One row per (conversationId, platform).
 *
 * `stage` is the pipeline position (server/constants/pipeline.js).
 * `classification` is the pre-pipeline six-value field, kept only so the
 * one-shot migration (server/db/migrateStages.js) can derive `stage` from it
 * on installations that predate the pipeline; nothing writes it any more.
 */
const classificationSchema = new mongoose.Schema(
  {
    conversationId: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      enum: ["instagram", "facebook", "whatsapp", "messenger", "email", "tiktok"],
      required: true,
    },
    stage: {
      type: String,
      enum: STAGE_KEYS,
      default: DEFAULT_STAGE,
    },
    /** @deprecated legacy six-value classification, migrated into `stage`. */
    classification: {
      type: String,
      enum: ["cible", "hors_cible", "non_classifie", "suivi", "priorite", "rdv"],
      default: "non_classifie",
    },
    /** Nature of the request (Omra, Visa, …); "" until the agent sets it. */
    typologie: {
      type: String,
      enum: ["", ...TYPOLOGY_KEYS],
      default: "",
    },
    /** Invoice number of the customer's file, free text. */
    invoiceRef: {
      type: String,
      default: "",
      trim: true,
      maxlength: 60,
    },
    /**
     * The prospect's phone number as the agent recorded it from the
     * conversation. WhatsApp leads carry their number as their id; this is
     * for the Facebook, Instagram and email ones, so the follow-up can be
     * made by phone.
     */
    phone: {
      type: String,
      default: "",
      trim: true,
      maxlength: 30,
    },
    /** Urgency marker, independent of the stage. */
    isPriority: {
      type: Boolean,
      default: false,
    },
    /**
     * Free comment an agent keeps on the discussion, shown next to the
     * motif / frein. One per customer, overwritten on save.
     */
    comment: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },
    commentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    commentAt: {
      type: Date,
      default: null,
    },
    /**
     * When the appointment (RDV) is booked. Independent of the stage: it can
     * be set at any point of the pipeline and cleared with null. Feeds the
     * agenda and the "Chaud" maturity rule.
     */
    appointmentAt: {
      type: Date,
      default: null,
    },
    /**
     * Where the appointment takes place and who receives the customer.
     * Place is a gouvernorat, the agency an entry of the partners directory
     * (its name is kept beside the reference so the agenda still reads once
     * the entry is renamed or deactivated), the agent free text — not
     * necessarily a CRM user. All four are cleared with the date.
     */
    appointmentPlace: {
      type: String,
      default: "",
      trim: true,
      maxlength: 60,
    },
    appointmentAgency: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      default: null,
    },
    appointmentAgencyName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },
    appointmentAgent: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },
    classifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// One record per conversation+platform combo
classificationSchema.index(
  { conversationId: 1, platform: 1 },
  { unique: true },
);

// Agenda view: upcoming appointments across platforms, soonest first
classificationSchema.index({ appointmentAt: 1 }, { name: "appointments" });

// Funnel counts per stage
classificationSchema.index({ stage: 1 }, { name: "funnel_stage" });

module.exports = mongoose.model("Classification", classificationSchema);
