const mongoose = require("mongoose");

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
    classification: {
      type: String,
      enum: ["cible", "hors_cible", "non_classifie", "suivi", "priorite", "rdv"],
      default: "non_classifie",
    },
    /**
     * When the appointment is booked. Only meaningful for classification
     * "rdv" — an RDV without a date would be invisible to the agenda, so the
     * route requires one and clears it when the class changes to anything
     * else.
     */
    appointmentAt: {
      type: Date,
      default: null,
    },
    classifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// One classification per conversation+platform combo
classificationSchema.index(
  { conversationId: 1, platform: 1 },
  { unique: true },
);

// Agenda view: upcoming appointments across platforms, soonest first
classificationSchema.index(
  { classification: 1, appointmentAt: 1 },
  { name: "rdv_agenda" },
);

module.exports = mongoose.model("Classification", classificationSchema);
