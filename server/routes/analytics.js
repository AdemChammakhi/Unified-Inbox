const express = require("express");
const router = express.Router();
const { db, at } = require("../db/sql");
const { isPlaceholderName } = require("../db/contacts");
const { protect, authorize } = require("../middleware/auth");

// Counts of "clients" are distinct customers who wrote: one conversation per
// customer per platform (server/db/conversations.js), over incoming messages
// by the time they were stored (created_*), as the MongoDB version counted
// by createdAt.

/** WHERE fragment: a message stored at or after the @<prefix>_date/_time pair. */
const storedSince = (prefix) =>
  `(m.created_date > @${prefix}_date OR (m.created_date = @${prefix}_date AND m.created_time >= @${prefix}_time))`;

async function distinctClientsSince(prefix, params) {
  return db.scalar(
    `SELECT COUNT(DISTINCT m.conversation_id) FROM dbo.message m
     WHERE m.sender_type = N'contact' AND ${storedSince(prefix)}`,
    params,
  );
}

async function clientsByPlatform(params) {
  return (
    await db.query(
      `SELECT _id = c.platform, count = COUNT(DISTINCT m.conversation_id)
       FROM dbo.message m JOIN dbo.conversations c ON c.conversation_id = m.conversation_id
       WHERE m.sender_type = N'contact' AND ${storedSince("since")}
       GROUP BY c.platform
       ORDER BY count DESC`,
      params,
    )
  ).rows;
}

function windows(range) {
  const now = new Date();
  const since = new Date(now - range * 24 * 60 * 60 * 1000);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);
  return {
    ...at("since", since),
    ...at("today", todayStart),
    ...at("week", weekStart),
  };
}

// GET /api/analytics/summary?range=7  (range: 1, 7, 30)
router.get(
  "/summary",
  protect,
  authorize("admin", "manager"),
  async (req, res) => {
    try {
      const range = parseInt(req.query.range) || 7;
      const params = windows(range);

      const [
        totalInRange,
        todayCount,
        weekCount,
        byPlatform,
        dailySeries,
        activeAgentCount,
      ] = await Promise.all([
        // Distinct clients in range (1 per customer, not per message)
        distinctClientsSince("since", params),
        // Distinct clients today
        distinctClientsSince("today", params),
        // Distinct clients this week
        distinctClientsSince("week", params),
        // Distinct clients by platform
        clientsByPlatform(params),
        // Daily series — distinct clients per day per platform
        db
          .query(
            `SELECT date = CONVERT(char(10), m.created_date, 23), c.platform,
                    count = COUNT(DISTINCT m.conversation_id)
             FROM dbo.message m JOIN dbo.conversations c ON c.conversation_id = m.conversation_id
             WHERE m.sender_type = N'contact' AND ${storedSince("since")}
             GROUP BY m.created_date, c.platform
             ORDER BY m.created_date`,
            params,
          )
          .then((r) => r.rows),
        // Active agents (have locks)
        db.scalar(
          `SELECT COUNT(DISTINCT locked_by_user_id) FROM dbo.conversations
           WHERE locked_by_user_id IS NOT NULL AND deleted_date IS NULL`,
        ),
      ]);

      // Reshape daily series into chart-friendly format
      const dateMap = {};
      for (const row of dailySeries) {
        const { date, platform } = row;
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
        totalInRange: totalInRange || 0,
        todayCount: todayCount || 0,
        weekCount: weekCount || 0,
        byPlatform,
        dailyData,
        activeAgentCount: activeAgentCount || 0,
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
      // Count outgoing messages per agent (sender_user_id, set when a reply
      // is sent from the CRM)
      const rows = (
        await db.query(
          `SELECT u.user_id, u.first_name, u.last_name, u.role, replies = COUNT(*)
           FROM dbo.message m JOIN dbo.users u ON u.user_id = m.sender_user_id
           WHERE m.sender_type <> N'contact'
           GROUP BY u.user_id, u.first_name, u.last_name, u.role
           ORDER BY replies DESC`,
        )
      ).rows;

      return res.json({
        agents: rows.map((r) => ({
          agentId: String(r.user_id),
          name: `${r.first_name} ${r.last_name}`,
          role: r.role,
          replies: r.replies,
        })),
      });
    } catch (err) {
      console.error("Agents analytics error:", err.message);
      return res.status(500).json({ message: "Agent analytics failed" });
    }
  },
);

// GET /api/analytics/appointments?range=30
// The RDV agenda: how many appointments were booked, how they are split
// between still-upcoming and already-past, and the next ones in order.
// `range` scopes the *booked in* count (when the dossier was last edited);
// the upcoming list is not range-bound — an appointment three months out
// still matters today.
router.get("/appointments", protect, async (req, res) => {
  try {
    const range = parseInt(req.query.range) || 30;
    const since = new Date(Date.now() - range * 24 * 60 * 60 * 1000);
    const now = new Date();
    const params = { ...at("since", since), ...at("now", now) };
    const rdv = "dbo.fn_DateTimeCombine(c.appointment_date, c.appointment_time)";

    // The RDV date is independent of the Étape and the Qualification: an appointment
    // exists whenever it is set.
    const [counts, upcomingRows] = await Promise.all([
      db.one(
        `SELECT
           total = COUNT(*),
           bookedInRange = SUM(CASE WHEN c.classified_date > @since_date
                                      OR (c.classified_date = @since_date AND c.classified_time >= @since_time)
                                    THEN 1 ELSE 0 END),
           pastCount = SUM(CASE WHEN ${rdv} < dbo.fn_DateTimeCombine(@now_date, @now_time) THEN 1 ELSE 0 END)
         FROM dbo.conversations c
         WHERE c.appointment_date IS NOT NULL AND c.deleted_date IS NULL`,
        params,
      ),
      db
        .query(
          `SELECT TOP (50) c.platform, c.external_id, c.participant_external_id, c.participant_name,
                  appointment_at = ${rdv}, u.first_name, u.last_name
           FROM dbo.conversations c
           LEFT JOIN dbo.users u ON u.user_id = c.classified_by_user_id
           WHERE c.appointment_date IS NOT NULL AND c.deleted_date IS NULL
             AND ${rdv} >= dbo.fn_DateTimeCombine(@now_date, @now_time)
           ORDER BY c.appointment_date, c.appointment_time`,
          params,
        )
        .then((r) => r.rows),
    ]);

    // "Today" in the server's local timezone — the agency books in its own
    // working day, not UTC.
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // The agenda is useless without a name: the customer's, from their
    // conversation, else a readable fallback.
    const upcoming = upcomingRows.map((d) => {
      const key = d.participant_external_id || d.external_id;
      return {
        conversationId: key,
        platform: d.platform,
        name: !isPlaceholderName(d.participant_name, key)
          ? d.participant_name
          : d.platform === "whatsapp"
            ? `+${key}`
            : `Client ${String(key).slice(-4)}`,
        appointmentAt: d.appointment_at,
        bookedBy: d.first_name
          ? `${d.first_name || ""} ${d.last_name || ""}`.trim()
          : null,
      };
    });

    return res.json({
      range,
      total: counts?.total || 0,
      bookedInRange: counts?.bookedInRange || 0,
      upcomingCount: upcoming.length,
      todayCount: upcoming.filter(
        (a) => new Date(a.appointmentAt) <= endOfToday,
      ).length,
      next7DaysCount: upcoming.filter(
        (a) => new Date(a.appointmentAt) <= endOfWeek,
      ).length,
      pastCount: counts?.pastCount || 0,
      upcoming,
    });
  } catch (err) {
    console.error("Appointments analytics error:", err.message);
    return res.status(500).json({ message: "Failed to load appointments" });
  }
});

// GET /api/analytics/marketing-summary — for agents
router.get("/marketing-summary", protect, async (req, res) => {
  try {
    const range = parseInt(req.query.range) || 7;
    const params = windows(range);

    const [rangeCount, todayCount, weekCount, byPlatform, recentRows] =
      await Promise.all([
        // Distinct clients in selected range
        distinctClientsSince("since", params),
        // Distinct clients today
        distinctClientsSince("today", params),
        // Distinct clients this week
        distinctClientsSince("week", params),
        // Distinct clients by platform in selected range
        clientsByPlatform(params),
        db
          .query(
            `SELECT TOP (5) m.message_id, c.platform, c.participant_name, m.content,
                    customer_key = COALESCE(c.participant_external_id, c.external_id),
                    created_at = dbo.fn_DateTimeCombine(m.created_date, m.created_time)
             FROM dbo.message m JOIN dbo.conversations c ON c.conversation_id = m.conversation_id
             WHERE m.sender_type = N'contact'
             ORDER BY m.created_date DESC, m.created_time DESC, m.message_id DESC`,
          )
          .then((r) => r.rows),
      ]);

    // An unresolved name reads "User 1234", as in the inbox lists
    const recentMessages = recentRows.map((m) => ({
      _id: String(m.message_id),
      platform: m.platform,
      senderName: isPlaceholderName(m.participant_name, m.customer_key)
        ? `User ${String(m.customer_key).slice(-4)}`
        : m.participant_name,
      content: m.content || "",
      createdAt: m.created_at,
    }));

    return res.json({
      rangeCount: rangeCount || 0,
      todayCount: todayCount || 0,
      weekCount: weekCount || 0,
      byPlatform,
      recentMessages,
    });
  } catch (err) {
    console.error("Marketing summary error:", err.message);
    return res.status(500).json({ message: "Marketing analytics failed" });
  }
});

module.exports = router;
