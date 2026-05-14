const express = require("express");
const router = express.Router();
const Message = require("../models/Message");
const User = require("../models/User");
const ConversationLock = require("../models/ConversationLock");
const { protect, authorize } = require("../middleware/auth");

// GET /api/analytics/summary?range=7  (range: 1, 7, 30)
router.get(
  "/summary",
  protect,
  authorize("admin", "manager"),
  async (req, res) => {
    try {
      const range = parseInt(req.query.range) || 7;
      const now = new Date();
      const since = new Date(now - range * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);

      const [
        totalInRange,
        todayCount,
        weekCount,
        byPlatform,
        dailySeries,
        activeAgents,
      ] = await Promise.all([
        // Total messages in range
        Message.countDocuments({ createdAt: { $gte: since } }),
        // Today
        Message.countDocuments({ createdAt: { $gte: todayStart } }),
        // This week
        Message.countDocuments({ createdAt: { $gte: weekStart } }),
        // By platform
        Message.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: "$platform", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        // Daily series
        Message.aggregate([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: {
                date: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
                },
                platform: "$platform",
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.date": 1 } },
        ]),
        // Active agents (have locks)
        ConversationLock.distinct("lockedBy"),
      ]);

      // Reshape daily series into chart-friendly format
      const dateMap = {};
      for (const row of dailySeries) {
        const { date, platform } = row._id;
        if (!dateMap[date]) dateMap[date] = { date };
        dateMap[date][platform] = row.count;
      }
      const dailyData = Object.values(dateMap).sort((a, b) =>
        a.date.localeCompare(b.date),
      );

      return res.json({
        totalInRange,
        todayCount,
        weekCount,
        byPlatform,
        dailyData,
        activeAgentCount: activeAgents.length,
      });
    } catch (err) {
      console.error("Analytics error:", err.message);
      return res.status(500).json({ message: "Analytics failed" });
    }
  },
);

// GET /api/analytics/agents — agent performance (messages handled per agent via locks)
router.get(
  "/agents",
  protect,
  authorize("admin", "manager"),
  async (req, res) => {
    try {
      const locks = await ConversationLock.find({})
        .populate("lockedBy", "firstName lastName role")
        .lean();

      const agentMap = {};
      for (const lock of locks) {
        if (!lock.lockedBy) continue;
        const id = lock.lockedBy._id.toString();
        if (!agentMap[id]) {
          agentMap[id] = {
            name: `${lock.lockedBy.firstName} ${lock.lockedBy.lastName}`,
            role: lock.lockedBy.role,
            conversations: 0,
          };
        }
        agentMap[id].conversations += 1;
      }

      return res.json({ agents: Object.values(agentMap) });
    } catch (err) {
      console.error("Agents analytics error:", err.message);
      return res.status(500).json({ message: "Agent analytics failed" });
    }
  },
);

// GET /api/analytics/marketing-summary — for marketing agents
router.get("/marketing-summary", protect, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const token = req.user;
    const filter =
      req.user.role === "marketing"
        ? {} // marketing sees all platform data
        : {};

    const [todayCount, weekCount, totalCount, byPlatform, recentMessages] =
      await Promise.all([
        Message.countDocuments({ ...filter, createdAt: { $gte: todayStart } }),
        Message.countDocuments({ ...filter, createdAt: { $gte: weekStart } }),
        Message.countDocuments(filter),
        Message.aggregate([
          { $match: { createdAt: { $gte: weekStart } } },
          { $group: { _id: "$platform", count: { $sum: 1 } } },
        ]),
        Message.find({ direction: "incoming" })
          .sort({ createdAt: -1 })
          .limit(5)
          .select("platform senderName content createdAt"),
      ]);

    return res.json({
      todayCount,
      weekCount,
      totalCount,
      byPlatform,
      recentMessages,
    });
  } catch (err) {
    console.error("Marketing summary error:", err.message);
    return res.status(500).json({ message: "Marketing analytics failed" });
  }
});

module.exports = router;
