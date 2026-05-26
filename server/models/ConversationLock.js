const mongoose = require("mongoose");

const conversationLockSchema = new mongoose.Schema(
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
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lockedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// One lock per conversation+platform combo
conversationLockSchema.index(
  { conversationId: 1, platform: 1 },
  { unique: true },
);

module.exports = mongoose.model("ConversationLock", conversationLockSchema);
