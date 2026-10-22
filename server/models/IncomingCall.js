const mongoose = require("mongoose");

/**
 * IncomingCall — a prospect who reached the agency by phone ("Appel
 * entrant"), recorded by an agent from the Leads page.
 *
 * A call has no message thread, so this is the only place the prospect's
 * name lives. Everything else a lead carries is stored where it is for the
 * other channels, keyed by `customerId` ("appel-<digits>") on the platform
 * "telephone": the dossier (Classification: stage, typologie, PAX, comment,
 * RDV…), the agent in charge (ConversationLock) and the frein (Contact).
 * So corrections, reassignment and "Mes leads" work on it unchanged.
 *
 * One record per phone number: a second call from the same number updates
 * `lastCallAt` and `callCount` instead of creating a duplicate lead.
 */
const incomingCallSchema = new mongoose.Schema(
  {
    customerId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** As shown: "+216 98 123 456". The digits are in customerId. */
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    email: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },
    firstCallAt: { type: Date, default: Date.now },
    lastCallAt: { type: Date, default: Date.now },
    callCount: { type: Number, default: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

incomingCallSchema.index({ lastCallAt: -1 });

module.exports = mongoose.model("IncomingCall", incomingCallSchema);
