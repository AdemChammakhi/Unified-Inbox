const express = require("express");
const ConversationLock = require("../models/ConversationLock");
const { protect, authorize } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");

const router = express.Router();

// GET /api/locks — Get all locks for a platform (with agent name populated)
router.get("/", protect, async (req, res) => {
  try {
    const { platform } = req.query;
    const safePlatform = platform ? sanitizePlatform(platform) : null;
    const filter = safePlatform ? { platform: safePlatform } : {};
    const locks = await ConversationLock.find(filter).populate(
      "lockedBy",
      "firstName lastName email role",
    );

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
    const locks = await ConversationLock.find({}).populate(
      "lockedBy",
      "firstName lastName email role",
    );

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
