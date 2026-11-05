const mongoose = require("mongoose");

/**
 * Dispatch — a discussion handed to an agent by an admin, to be dealt with.
 *
 * The conversation lock says WHO may reply; a dispatch says WHAT is expected
 * of them and whether it has been done. Keyed by the CUSTOMER id (never a
 * t_… thread id, see CLAUDE.md §6) on one platform, like Classification.
 *
 * Lifecycle: `open` from the admin's action until the agent (or an admin or
 * manager) marks it done, or an admin cancels or reassigns it. Reassigning
 * cancels this row and opens a new one, so the history stays readable.
 * `firstReplyAt` is filled by the send routes the first time the agent
 * answers after the dispatch: the admin's board tells a started task from
 * an untouched one without opening the discussion.
 */
const dispatchSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: ["instagram", "facebook", "whatsapp", "messenger", "email", "tiktok", "telephone"],
      required: true,
    },
    customerId: {
      type: String,
      required: true,
      trim: true,
    },
    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    dispatchedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    dispatchedAt: {
      type: Date,
      default: Date.now,
    },
    /** The admin's instruction to the agent, shown with the badge. */
    note: {
      type: String,
      default: "",
      trim: true,
      maxlength: 300,
    },
    status: {
      type: String,
      enum: ["open", "done", "cancelled"],
      default: "open",
    },
    firstReplyAt: {
      type: Date,
      default: null,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

// One open dispatch per customer and platform; closed ones keep piling up
dispatchSchema.index(
  { platform: 1, customerId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "open" },
    name: "one_open_per_customer",
  },
);

// An agent's queue, oldest first
dispatchSchema.index({ agent: 1, status: 1, dispatchedAt: 1 }, { name: "agent_queue" });

// The admin's board
dispatchSchema.index({ status: 1, dispatchedAt: 1 }, { name: "board" });

module.exports = mongoose.model("Dispatch", dispatchSchema);
