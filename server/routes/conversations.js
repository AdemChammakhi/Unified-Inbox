const express = require("express");
const router = express.Router();
const conversations = require("../db/conversations");
const { protect } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");

// DELETE /api/conversations — delete a conversation and all its data
router.delete("/", protect, async (req, res) => {
  try {
    const conversationId = sanitizeId(req.body.conversationId);
    const platform = sanitizePlatform(req.body.platform);

    if (!conversationId || !platform) {
      return res
        .status(400)
        .json({ message: "conversationId and platform are required" });
    }

    // Only admins and managers can delete conversations
    if (req.user.role !== "admin" && req.user.role !== "manager") {
      return res
        .status(403)
        .json({ message: "Only admins and managers can delete conversations" });
    }

    // The key may be the thread id or the customer id; both lead to the
    // customer's conversation. Its messages and qualification history are deleted,
    // its dossier and lock reset; the row itself stays, marked deleted (the
    // warehouse flags it), and reopens if the customer writes again.
    const found = await conversations.findByKeys(platform, [conversationId]);
    const deleted = { messages: 0, classifications: 0, locks: 0 };
    for (const conv of found) {
      const r = await conversations.softDelete(conv.id);
      deleted.messages += r.messages;
      deleted.classifications += r.classifications;
      deleted.locks += r.locks;
    }

    console.log(
      `Deleted conversation ${conversationId} (${platform}): ${deleted.messages} messages, ${deleted.classifications} classifications, ${deleted.locks} locks`,
    );

    return res.json({ success: true, deleted });
  } catch (error) {
    console.error("Delete conversation error:", error.message);
    return res.status(500).json({
      message: "Failed to delete conversation",
      error: error.message,
    });
  }
});

module.exports = router;
