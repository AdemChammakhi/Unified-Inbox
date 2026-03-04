const mongoose = require("mongoose");

const classificationSchema = new mongoose.Schema(
  {
    conversationId: {
      type: String,
      required: true,
    },
    platform: {
      type: String,
      enum: ["instagram", "facebook", "whatsapp", "messenger", "email"],
      required: true,
    },
    classification: {
      type: String,
      enum: ["cible", "hors_cible", "non_classifie", "suivi", "priorite"],
      default: "non_classifie",
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

module.exports = mongoose.model("Classification", classificationSchema);
