const express = require("express");
const router = express.Router();
const Message = require("../models/Message");
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
        totalInRangeRes,
        todayCountRes,
        weekCountRes,
        byPlatform,
        dailySeries,
        activeAgents,
      ] = await Promise.all([
        // Distinct clients in range (1 per sender, not per message)
        Message.aggregate([
          { $match: { direction: "incoming", createdAt: { $gte: since } } },
          { $group: { _id: "$senderId" } },
          { $count: "count" },
        ]),
        // Distinct clients today
        Message.aggregate([
          {
            $match: { direction: "incoming", createdAt: { $gte: todayStart } },
          },
          { $group: { _id: "$senderId" } },
          { $count: "count" },
        ]),
        // Distinct clients this week
        Message.aggregate([
          { $match: { direction: "incoming", createdAt: { $gte: weekStart } } },
          { $group: { _id: "$senderId" } },
          { $count: "count" },
        ]),
        // Distinct clients by platform
        Message.aggregate([
          { $match: { direction: "incoming", createdAt: { $gte: since } } },
          { $group: { _id: { platform: "$platform", senderId: "$senderId" } } },
          { $group: { _id: "$_id.platform", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        // Daily series — distinct clients per day per platform
        Message.aggregate([
          { $match: { direction: "incoming", createdAt: { $gte: since } } },
          {
            $group: {
              _id: {
                date: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
                },
                platform: "$platform",
                senderId: "$senderId",
              },
            },
          },
          {
            $group: {
              _id: { date: "$_id.date", platform: "$_id.platform" },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.date": 1 } },
        ]),
        // Active agents (have locks)
        ConversationLock.distinct("lockedBy"),
      ]);

      const totalInRange = totalInRangeRes[0]?.count || 0;
      const todayCount = todayCountRes[0]?.count || 0;
      const weekCount = weekCountRes[0]?.count || 0;

      // Reshape daily series into chart-friendly format
      const dateMap = {};
      for (const row of dailySeries) {
        const { date, platform } = row._id;
        if (!dateMap[date]) dateMap[date] = { date };
        dateMap[date][platform] = row.count;
      }
      const dailyData = Object.values(dateMap)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => {
          const total = Object.entries(day)
            .filter(([k]) => k !== "date")
            .reduce((sum, [, v]) => sum + v, 0);
          return { ...day, total };
        });

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

// GET /api/analytics/agents — agent reply leaderboard
router.get(
  "/agents",
  protect,
  authorize("admin", "manager"),
  async (req, res) => {
    try {
      // Count outgoing messages per agent (sentBy field, set when reply is sent)
      const replyCounts = await Message.aggregate([
        { $match: { direction: "outgoing", sentBy: { $ne: null } } },
        { $group: { _id: "$sentBy", replies: { $sum: 1 } } },
        { $sort: { replies: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            _id: 0,
            agentId: "$_id",
            name: { $concat: ["$user.firstName", " ", "$user.lastName"] },
            role: "$user.role",
            replies: 1,
          },
        },
      ]);

      return res.json({ agents: replyCounts });
    } catch (err) {
      console.error("Agents analytics error:", err.message);
      return res.status(500).json({ message: "Agent analytics failed" });
    }
  },
);

// GET /api/analytics/marketing-summary — for marketing agents
router.get("/marketing-summary", protect, async (req, res) => {
  try {
    const range = parseInt(req.query.range) || 7;
    const now = new Date();
    const since = new Date(now - range * 24 * 60 * 60 * 1000);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [
      rangeCountRes,
      todayCountRes,
      weekCountRes,
      byPlatform,
      recentMessages,
    ] = await Promise.all([
      // Distinct clients in selected range
      Message.aggregate([
        { $match: { direction: "incoming", createdAt: { $gte: since } } },
        { $group: { _id: "$senderId" } },
        { $count: "count" },
      ]),
      // Distinct clients today
      Message.aggregate([
        { $match: { direction: "incoming", createdAt: { $gte: todayStart } } },
        { $group: { _id: "$senderId" } },
        { $count: "count" },
      ]),
      // Distinct clients this week
      Message.aggregate([
        { $match: { direction: "incoming", createdAt: { $gte: weekStart } } },
        { $group: { _id: "$senderId" } },
        { $count: "count" },
      ]),
      // Distinct clients by platform in selected range
      Message.aggregate([
        { $match: { direction: "incoming", createdAt: { $gte: since } } },
        { $group: { _id: { platform: "$platform", senderId: "$senderId" } } },
        { $group: { _id: "$_id.platform", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Message.find({ direction: "incoming" })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("platform senderName content createdAt"),
    ]);

    const rangeCount = rangeCountRes[0]?.count || 0;
    const todayCount = todayCountRes[0]?.count || 0;
    const weekCount = weekCountRes[0]?.count || 0;

    return res.json({
      rangeCount,
      todayCount,
      weekCount,
      byPlatform,
      recentMessages,
    });
  } catch (err) {
    console.error("Marketing summary error:", err.message);
    return res.status(500).json({ message: "Marketing analytics failed" });
  }
});

module.exports = router;
