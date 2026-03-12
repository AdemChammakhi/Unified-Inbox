const express = require("express");
const router = express.Router();
const Message = require("../models/Message");
const Classification = require("../models/Classification");
const ConversationLock = require("../models/ConversationLock");
const { protect } = require("../middleware/auth");

// DELETE /api/conversations — delete a conversation and all its data
router.delete("/", protect, async (req, res) => {
  try {
    const { conversationId, platform } = req.body;

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

    // Delete all messages for this conversation
    // Messages may be keyed by conversationId OR senderId (webhook stores senderId as conversationId)
    const msgResult = await Message.deleteMany({
      platform,
      $or: [{ conversationId }, { senderId: conversationId }],
    });

    // Delete classification
    const clsResult = await Classification.deleteMany({
      platform,
      conversationId,
    });

    // Delete conversation lock
    const lockResult = await ConversationLock.deleteMany({
      platform,
      conversationId,
    });

    console.log(
      `Deleted conversation ${conversationId} (${platform}): ${msgResult.deletedCount} messages, ${clsResult.deletedCount} classifications, ${lockResult.deletedCount} locks`,
    );

    return res.json({
      success: true,
      deleted: {
        messages: msgResult.deletedCount,
        classifications: clsResult.deletedCount,
        locks: lockResult.deletedCount,
      },
    });
  } catch (error) {
    console.error("Delete conversation error:", error.message);
    return res.status(500).json({
      message: "Failed to delete conversation",
      error: error.message,
    });
  }
});

module.exports = router;
