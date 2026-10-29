const express = require("express");
const conversations = require("../db/conversations");
const { protect, authorize } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");

const router = express.Router();

// The lock is locked_by_user_id on the customer's conversation row
// (server/db/conversations.js). Maps list it under the customer id AND the
// thread id when one is recorded, so the client's lookup by conversation id
// or first participant finds it either way (CLAUDE.md §6).

// GET /api/locks — Get all locks for a platform (with agent name populated)
router.get("/", protect, async (req, res) => {
  try {
    const { platform } = req.query;
    const safePlatform = platform ? sanitizePlatform(platform) : null;
    const locks = await conversations.lockedConversations(safePlatform);

    // Build a map: { conversationId: { agentId, agentName, lockedAt } }
    const lockMap = {};
    locks.forEach((lock) => {
      const entry = {
        agentId: lock.agentId,
        agentName: lock.agentName,
        agentEmail: lock.agentEmail,
        lockedAt: lock.lockedAt,
      };
      for (const key of new Set([lock.customerId, lock.externalId].filter(Boolean))) {
        lockMap[key] = entry;
      }
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
    const locks = await conversations.lockedConversations();

    const result = locks.map((lock) => ({
      conversationId: lock.customerId || lock.externalId,
      platform: lock.platform,
      agentId: lock.agentId,
      agentName: lock.agentName,
      agentEmail: lock.agentEmail,
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
      await conversations.unlockByKey(conversationId, platform);
      return res.json({ success: true, message: "Conversation unlocked" });
    } catch (error) {
      console.error("Failed to unlock conversation:", error.message);
      return res.status(500).json({ message: "Failed to unlock conversation" });
    }
  },
);

module.exports = router;
