/**
 * dispatch.js — the admin hands discussions to agents; agents work them off.
 *
 *   POST   /api/dispatch                admin: give a discussion to an agent
 *   GET    /api/dispatch/mine           my open dispatches, every platform
 *   GET    /api/dispatch?status=&…      admin, manager: the board
 *   PUT    /api/dispatch/:id/done       the agent, admin or manager: done
 *   PUT    /api/dispatch/:id/reassign   admin: to another agent
 *   DELETE /api/dispatch/:id            admin: cancel
 *
 * A dispatch also moves the conversation lock to the agent (the same move
 * as PUT /api/locks/assign), so they alone can reply. Cancelling or
 * closing a dispatch leaves the lock where it is: the agent stays in charge
 * of the lead, only the task is over.
 */

"use strict";

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Dispatch = require("../models/Dispatch");
const User = require("../models/User");
const Message = require("../models/Message");
const IncomingCall = require("../models/IncomingCall");
const { protect, authorize } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");
const { assignConversation } = require("../utils/dispatching");

const NOTE_MAX = 300;
const STATUSES = new Set(["open", "done", "cancelled", "all"]);

const fullName = (u) =>
  u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : "";

const cleanNote = (v) =>
  String(v === null || v === undefined ? "" : v)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX);

/** The client-facing shape; `agent` and `dispatchedBy` are populated. */
function publicDispatch(d, names) {
  const agent = d.agent && typeof d.agent === "object" ? d.agent : null;
  const by = d.dispatchedBy && typeof d.dispatchedBy === "object" ? d.dispatchedBy : null;
  const agentId = agent ? String(agent._id) : d.agent ? String(d.agent) : null;
  const byId = by ? String(by._id) : d.dispatchedBy ? String(d.dispatchedBy) : null;
  return {
    id: String(d._id),
    platform: d.platform,
    customerId: d.customerId,
    customerName: (names && names.get(`${d.platform}:${d.customerId}`)) || "",
    agentId,
    agentName: fullName(agent),
    dispatchedById: byId,
    dispatchedByName: fullName(by),
    dispatchedAt: d.dispatchedAt,
    note: d.note || "",
    status: d.status,
    firstReplyAt: d.firstReplyAt || null,
    closedAt: d.closedAt || null,
  };
}

/**
 * Who the customers are, for the board: the sender name of their latest
 * incoming message, or the name recorded with the call. One query per
 * platform present, never per row.
 */
async function customerNames(dispatches) {
  const names = new Map();
  const byPlatform = new Map();
  for (const d of dispatches) {
    if (!byPlatform.has(d.platform)) byPlatform.set(d.platform, new Set());
    byPlatform.get(d.platform).add(d.customerId);
  }
  await Promise.all(
    [...byPlatform].map(async ([platform, ids]) => {
      try {
        if (platform === "telephone") {
          const calls = await IncomingCall.find({ customerId: { $in: [...ids] } })
            .select("customerId name")
            .lean();
          for (const c of calls) names.set(`${platform}:${c.customerId}`, c.name || "");
          return;
        }
        const rows = await Message.aggregate([
          { $match: { platform, direction: "incoming", senderId: { $in: [...ids] } } },
          { $sort: { createdAt: -1 } },
          { $group: { _id: "$senderId", name: { $first: "$senderName" } } },
        ]);
        for (const r of rows) names.set(`${platform}:${r._id}`, r.name || "");
      } catch (err) {
        console.error("[Dispatch] customer names skipped (non-fatal):", err.message);
      }
    }),
  );
  return names;
}

async function loadAgent(agentId) {
  if (typeof agentId !== "string" || !mongoose.Types.ObjectId.isValid(agentId)) {
    return { error: "Agent invalide." };
  }
  const agent = await User.findById(agentId).select("firstName lastName isActive role").lean();
  if (!agent || agent.isActive === false) {
    return { error: "Agent introuvable ou suspendu." };
  }
  return { agent };
}

function clearCaches() {
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
}

/** Tell the agent's browser and every admin board. */
function broadcast(req, event, dispatch) {
  const io = req.app.get("io");
  if (!io) return;
  const payload = { event, dispatch };
  if (dispatch.agentId) io.to(dispatch.agentId).emit("dispatch:new", payload);
  io.emit("dispatch:changed", payload);
}

async function populated(id) {
  return Dispatch.findById(id)
    .populate("agent", "firstName lastName")
    .populate("dispatchedBy", "firstName lastName")
    .lean();
}

/** Close the open dispatch of a customer, if any, as cancelled. */
async function cancelOpen(platform, customerId, userId) {
  return Dispatch.findOneAndUpdate(
    { platform, customerId, status: "open" },
    { $set: { status: "cancelled", closedAt: new Date(), closedBy: userId } },
    { new: true },
  ).lean();
}

// POST /api/dispatch  { platform, customerId, agentId, note? }
router.post("/", protect, authorize("admin"), async (req, res) => {
  try {
    const body = req.body || {};
    const platform = sanitizePlatform(body.platform);
    const customerId = sanitizeId(body.customerId);
    if (!platform || !customerId) {
      return res.status(400).json({ message: "Plateforme et client obligatoires." });
    }
    const { agent, error } = await loadAgent(body.agentId);
    if (error) return res.status(400).json({ message: error });

    // One open dispatch per customer: a new one replaces the current one
    await cancelOpen(platform, customerId, req.user._id);
    const created = await Dispatch.create({
      platform,
      customerId,
      agent: agent._id,
      dispatchedBy: req.user._id,
      note: cleanNote(body.note),
    });
    const keys = await assignConversation({ platform, customerId, agentId: agent._id });
    clearCaches();

    const dispatch = publicDispatch(await populated(created._id));
    broadcast(req, "created", dispatch);
    console.log(
      `[Dispatch] ${platform}:${customerId} → ${fullName(agent)} by ${fullName(req.user)} (${keys.length} key(s))`,
    );
    return res.json({ success: true, dispatch });
  } catch (error) {
    console.error("Dispatch create error:", error.message);
    return res.status(500).json({ message: "Impossible de dispatcher la discussion." });
  }
});

// GET /api/dispatch/mine — my open dispatches, oldest first, every platform
router.get("/mine", protect, async (req, res) => {
  try {
    const rows = await Dispatch.find({ agent: req.user._id, status: "open" })
      .sort({ dispatchedAt: 1 })
      .limit(500)
      .populate("agent", "firstName lastName")
      .populate("dispatchedBy", "firstName lastName")
      .lean();
    const items = rows.map((d) => publicDispatch(d));
    const counts = {};
    for (const d of items) counts[d.platform] = (counts[d.platform] || 0) + 1;
    return res.json({ items, counts });
  } catch (error) {
    console.error("Dispatch mine error:", error.message);
    return res.status(500).json({ message: "Impossible de charger vos dispatchs." });
  }
});

// GET /api/dispatch?status=open|done|cancelled|all&platform=&agentId=
router.get("/", protect, authorize("admin", "manager"), async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "open";
    if (!STATUSES.has(status)) {
      return res.status(400).json({ message: "Statut invalide." });
    }
    const filter = status === "all" ? {} : { status };
    if (req.query.platform) {
      const platform = sanitizePlatform(req.query.platform);
      if (!platform) return res.status(400).json({ message: "Plateforme invalide." });
      filter.platform = platform;
    }
    if (req.query.agentId) {
      if (
        typeof req.query.agentId !== "string" ||
        !mongoose.Types.ObjectId.isValid(req.query.agentId)
      ) {
        return res.status(400).json({ message: "Agent invalide." });
      }
      filter.agent = req.query.agentId;
    }
    const rows = await Dispatch.find(filter)
      .sort(status === "open" ? { dispatchedAt: 1 } : { closedAt: -1, dispatchedAt: -1 })
      .limit(1000)
      .populate("agent", "firstName lastName isActive")
      .populate("dispatchedBy", "firstName lastName")
      .lean();
    const names = await customerNames(rows);
    const items = rows.map((d) => ({
      ...publicDispatch(d, names),
      agentActive: !(d.agent && d.agent.isActive === false),
    }));
    return res.json({ items });
  } catch (error) {
    console.error("Dispatch list error:", error.message);
    return res.status(500).json({ message: "Impossible de charger les dispatchs." });
  }
});

async function findOpen(req, res) {
  const id = req.params.id;
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ message: "Dispatch invalide." });
    return null;
  }
  const d = await Dispatch.findById(id).lean();
  if (!d) {
    res.status(404).json({ message: "Dispatch introuvable." });
    return null;
  }
  if (d.status !== "open") {
    res.status(409).json({ message: "Ce dispatch est déjà clos." });
    return null;
  }
  return d;
}

// PUT /api/dispatch/:id/done — the assigned agent, an admin or a manager
router.put("/:id/done", protect, async (req, res) => {
  try {
    const d = await findOpen(req, res);
    if (!d) return undefined;
    const isStaff = req.user.role === "admin" || req.user.role === "manager";
    if (!isStaff && String(d.agent) !== String(req.user._id)) {
      return res.status(403).json({ message: "Ce dispatch est attribué à un autre agent." });
    }
    await Dispatch.updateOne(
      { _id: d._id, status: "open" },
      { $set: { status: "done", closedAt: new Date(), closedBy: req.user._id } },
    );
    clearCaches();
    const dispatch = publicDispatch(await populated(d._id));
    broadcast(req, "done", dispatch);
    console.log(`[Dispatch] ${d.platform}:${d.customerId} done by ${fullName(req.user)}`);
    return res.json({ success: true, dispatch });
  } catch (error) {
    console.error("Dispatch done error:", error.message);
    return res.status(500).json({ message: "Impossible de clore le dispatch." });
  }
});

// PUT /api/dispatch/:id/reassign  { agentId, note? } — admin
router.put("/:id/reassign", protect, authorize("admin"), async (req, res) => {
  try {
    const d = await findOpen(req, res);
    if (!d) return undefined;
    const body = req.body || {};
    const { agent, error } = await loadAgent(body.agentId);
    if (error) return res.status(400).json({ message: error });

    await Dispatch.updateOne(
      { _id: d._id, status: "open" },
      { $set: { status: "cancelled", closedAt: new Date(), closedBy: req.user._id } },
    );
    const created = await Dispatch.create({
      platform: d.platform,
      customerId: d.customerId,
      agent: agent._id,
      dispatchedBy: req.user._id,
      note: body.note === undefined ? d.note || "" : cleanNote(body.note),
    });
    await assignConversation({
      platform: d.platform,
      customerId: d.customerId,
      agentId: agent._id,
    });
    clearCaches();
    const dispatch = publicDispatch(await populated(created._id));
    broadcast(req, "reassigned", dispatch);
    console.log(
      `[Dispatch] ${d.platform}:${d.customerId} reassigned → ${fullName(agent)} by ${fullName(req.user)}`,
    );
    return res.json({ success: true, dispatch });
  } catch (error) {
    console.error("Dispatch reassign error:", error.message);
    return res.status(500).json({ message: "Impossible de réattribuer le dispatch." });
  }
});

// DELETE /api/dispatch/:id — admin: cancel (the lock stays with the agent)
router.delete("/:id", protect, authorize("admin"), async (req, res) => {
  try {
    const d = await findOpen(req, res);
    if (!d) return undefined;
    await Dispatch.updateOne(
      { _id: d._id, status: "open" },
      { $set: { status: "cancelled", closedAt: new Date(), closedBy: req.user._id } },
    );
    clearCaches();
    const dispatch = publicDispatch(await populated(d._id));
    broadcast(req, "cancelled", dispatch);
    console.log(`[Dispatch] ${d.platform}:${d.customerId} cancelled by ${fullName(req.user)}`);
    return res.json({ success: true, dispatch });
  } catch (error) {
    console.error("Dispatch cancel error:", error.message);
    return res.status(500).json({ message: "Impossible d’annuler le dispatch." });
  }
});

module.exports = router;
