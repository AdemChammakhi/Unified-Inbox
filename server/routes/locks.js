const express = require("express");
const conversations = require("../db/conversations");
const users = require("../db/users");
const { protect, authorize } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");
const { assignConversation } = require("../utils/dispatching");

const router = express.Router();

// The lock is locked_by_user_id on the customer's conversation row
// (server/db/conversations.js). Maps list it under the customer id AND the
// thread id when one is recorded, so the client's lookup by conversation id
// or first participant finds it either way (CLAUDE.md §6).

const fullName = (u) => `${u.firstName || ""} ${u.lastName || ""}`.trim();

// GET /api/locks/agents — Admin: the accounts a discussion can be assigned
// to (active only), for the "Commercial" picker of the Leads page.
router.get("/agents", protect, authorize("admin"), async (req, res) => {
  try {
    const agents = await users.activeAgents();
    return res.json({ agents });
  } catch (error) {
    console.error("Failed to list agents:", error.message);
    return res.status(500).json({ message: "Impossible de charger les agents." });
  }
});

// PUT /api/locks/assign  { platform, customerId, agentId | null }
// Admin: give a discussion to another agent in one step — what removing the
// lock and letting the new agent reply would do, without waiting for a reply.
//
// One conversation row per customer carries every key the inbox may send
// (the customer id and the Meta thread id), so setting its lock holder covers
// whichever key the send routes check (CLAUDE.md §6). agentId null releases
// the discussion (no lock: the next agent to reply takes it, as before).
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
      if (
        (typeof body.agentId !== "string" && typeof body.agentId !== "number") ||
        !users.userIdOf(body.agentId)
      ) {
        return res.status(400).json({ message: "Agent invalide." });
      }
      agent = await users.findById(body.agentId);
      if (!agent || agent.isActive === false) {
        return res.status(400).json({ message: "Agent introuvable ou suspendu." });
      }
    }

    // The same move a dispatch makes (utils/dispatching.js): the customer's
    // conversation, created or reopened when needed, gets the agent
    await assignConversation({ platform, customerId, agentId: agent ? agent._id : null });

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
      `[Locks] ${platform}:${customerId} ${agent ? `assigned to ${fullName(agent)}` : "released"} by ${fullName(req.user)} (1 key(s))`,
    );
    return res.json({
      success: true,
      agentId: agent ? String(agent._id) : null,
      agent: agent ? fullName(agent) : null,
      keys: 1,
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
