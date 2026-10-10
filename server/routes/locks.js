const express = require("express");
const mongoose = require("mongoose");
const ConversationLock = require("../models/ConversationLock");
const Message = require("../models/Message");
const User = require("../models/User");
const { protect, authorize } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");

const router = express.Router();

const fullName = (u) => `${u.firstName || ""} ${u.lastName || ""}`.trim();

// GET /api/locks/agents — Admin: the accounts a discussion can be assigned
// to (active only), for the "Commercial" picker of the Leads page.
router.get("/agents", protect, authorize("admin"), async (req, res) => {
  try {
    const users = await User.find({ isActive: { $ne: false } })
      .select("firstName lastName role")
      .sort({ firstName: 1, lastName: 1 })
      .lean();
    return res.json({
      agents: users.map((u) => ({ _id: String(u._id), name: fullName(u), role: u.role })),
    });
  } catch (error) {
    console.error("Failed to list agents:", error.message);
    return res.status(500).json({ message: "Impossible de charger les agents." });
  }
});

// PUT /api/locks/assign  { platform, customerId, agentId | null }
// Admin: give a discussion to another agent in one step — what removing the
// lock and letting the new agent reply would do, without waiting for a reply.
//
// A conversation has no single id (CLAUDE.md §6): the inbox may list it under
// the customer id or a Meta thread id, and the send routes check the lock
// under whichever one the inbox sent. So the lock is set on EVERY key the
// customer's messages live under: the new agent passes the check whatever
// the list shape, the previous one no longer does. agentId null releases the
// discussion (no lock: the next agent to reply takes it, as before).
router.put("/assign", protect, authorize("admin"), async (req, res) => {
  try {
    const body = req.body || {};
    const platform = sanitizePlatform(body.platform);
    const customerId = sanitizeId(body.customerId);
    if (!platform || !customerId) {
      return res.status(400).json({ message: "Plateforme et client obligatoires." });
    }

    let agent = null;
    if (body.agentId !== null && body.agentId !== undefined && body.agentId !== "") {
      if (typeof body.agentId !== "string" || !mongoose.Types.ObjectId.isValid(body.agentId)) {
        return res.status(400).json({ message: "Agent invalide." });
      }
      agent = await User.findById(body.agentId).select("firstName lastName isActive").lean();
      if (!agent || agent.isActive === false) {
        return res.status(400).json({ message: "Agent introuvable ou suspendu." });
      }
    }

    // Every key this customer's discussion is stored under (both $or
    // branches are index-backed: platform+senderId, platform+recipientId)
    const threadKeys = await Message.distinct("conversationId", {
      platform,
      $or: [{ senderId: customerId }, { recipientId: customerId }],
    });
    const keys = [...new Set([customerId, ...threadKeys.filter(Boolean).map(String)])];

    if (!agent) {
      await ConversationLock.deleteMany({ platform, conversationId: { $in: keys } });
    } else {
      const now = new Date();
      await ConversationLock.bulkWrite(
        keys.map((conversationId) => ({
          updateOne: {
            filter: { conversationId, platform },
            update: {
              $set: { lockedBy: agent._id, lockedAt: now },
              $setOnInsert: { conversationId, platform },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }

    // The sheet and the insights name the agent in charge from the locks
    try {
      require("./leads").clearLeadsCache();
    } catch (err) {
      console.error("Leads cache clear failed:", err.message);
    }
    try {
      const { clearInsightsCache } = require("./leadInsights");
      if (typeof clearInsightsCache === "function") clearInsightsCache();
    } catch (err) {
      console.error("Lead insights cache clear failed:", err.message);
    }

    console.log(
      `[Locks] ${platform}:${customerId} ${agent ? `assigned to ${fullName(agent)}` : "released"} by ${fullName(req.user)} (${keys.length} key(s))`,
    );
    return res.json({
      success: true,
      agentId: agent ? String(agent._id) : null,
      agent: agent ? fullName(agent) : null,
      keys: keys.length,
    });
  } catch (error) {
    console.error("Failed to assign conversation:", error.message);
    return res.status(500).json({ message: "Impossible de réattribuer la discussion." });
  }
});

// GET /api/locks — Get all locks for a platform (with agent name populated)
router.get("/", protect, async (req, res) => {
  try {
    const { platform } = req.query;
    const safePlatform = platform ? sanitizePlatform(platform) : null;
    const filter = safePlatform ? { platform: safePlatform } : {};
    const locks = await ConversationLock.find(filter)
      .populate("lockedBy", "firstName lastName email role")
      .lean();

    // Build a map: { conversationId: { agentId, agentName, lockedAt } }
    const lockMap = {};
    locks.forEach((lock) => {
      lockMap[lock.conversationId] = {
        agentId: lock.lockedBy?._id,
        agentName: lock.lockedBy
          ? `${lock.lockedBy.firstName} ${lock.lockedBy.lastName}`
          : "Unknown",
        agentEmail: lock.lockedBy?.email,
        lockedAt: lock.lockedAt,
      };
    });

    return res.json({ locks: lockMap });
  } catch (error) {
    console.error("Failed to fetch locks:", error.message);
    return res.status(500).json({ message: "Failed to fetch locks" });
  }
});

// GET /api/locks/all — Admin/Manager: get all locks across all platforms with agent info
router.get("/all", protect, authorize("admin", "manager"), async (req, res) => {
  try {
    const locks = await ConversationLock.find({})
      .populate("lockedBy", "firstName lastName email role")
      .lean();

    const result = locks.map((lock) => ({
      conversationId: lock.conversationId,
      platform: lock.platform,
      agentId: lock.lockedBy?._id,
      agentName: lock.lockedBy
        ? `${lock.lockedBy.firstName} ${lock.lockedBy.lastName}`
        : "Unknown",
      agentEmail: lock.lockedBy?.email,
      lockedAt: lock.lockedAt,
    }));

    return res.json({ locks: result });
  } catch (error) {
    console.error("Failed to fetch all locks:", error.message);
    return res.status(500).json({ message: "Failed to fetch all locks" });
  }
});

// DELETE /api/locks/:conversationId — Admin/Manager: unlock a conversation
router.delete(
  "/:conversationId",
  protect,
  authorize("admin", "manager"),
  async (req, res) => {
    try {
      const conversationId = sanitizeId(req.params.conversationId);
      const platform = req.query.platform ? sanitizePlatform(req.query.platform) : null;
      if (!conversationId) {
        return res.status(400).json({ message: "Invalid conversationId" });
      }
      await ConversationLock.findOneAndDelete({
        conversationId,
        ...(platform ? { platform } : {}),
      });
      return res.json({ success: true, message: "Conversation unlocked" });
    } catch (error) {
      console.error("Failed to unlock conversation:", error.message);
      return res.status(500).json({ message: "Failed to unlock conversation" });
    }
  },
);

module.exports = router;
