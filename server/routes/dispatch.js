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
 *
 * SQL Server storage: server/db/dispatches.js (decision D13, rows only).
 */

"use strict";

const express = require("express");
const router = express.Router();
const dispatches = require("../db/dispatches");
const users = require("../db/users");
const { protect, authorize } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");
const { conversationFor, assignConversation } = require("../utils/dispatching");

const NOTE_MAX = 300;
const STATUSES = new Set(["open", "done", "cancelled", "all"]);

const fullName = (u) =>
  u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : "";

const cleanNote = (v) =>
  String(v === null || v === undefined ? "" : v)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX);

async function loadAgent(agentId) {
  if ((typeof agentId !== "string" && typeof agentId !== "number") || !users.userIdOf(agentId)) {
    return { error: "Agent invalide." };
  }
  const agent = await users.findById(agentId);
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
  if (!io || !dispatch) return;
  const payload = { event, dispatch };
  if (dispatch.agentId) io.to(String(dispatch.agentId)).emit("dispatch:new", payload);
  io.emit("dispatch:changed", payload);
}

/** Answer a status error thrown by db/dispatches.js, or a 500. */
function fail(res, error, fallback, tag) {
  if (error && error.status && error.status < 500) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error(`Dispatch ${tag} error:`, error && error.message);
  return res.status(500).json({ message: fallback });
}

const validId = (req, res) => {
  if (!dispatches.isId(req.params.id)) {
    res.status(400).json({ message: "Dispatch invalide." });
    return false;
  }
  return true;
};

/**
 * The customer id a dispatch is stored under: the one the Leads sheet and
 * the send routes use. A Meta thread id is resolved to its customer when
 * the conversation knows one.
 */
async function canonicalCustomer(platform, customerId) {
  const conv = await conversationFor(platform, customerId);
  return conv.customerId || customerId;
}

// POST /api/dispatch  { platform, customerId, agentId, note? }
router.post("/", protect, authorize("admin"), async (req, res) => {
  try {
    const body = req.body || {};
    const platform = sanitizePlatform(body.platform);
    const rawCustomer = sanitizeId(body.customerId);
    if (!platform || !rawCustomer) {
      return res.status(400).json({ message: "Plateforme et client obligatoires." });
    }
    const { agent, error } = await loadAgent(body.agentId);
    if (error) return res.status(400).json({ message: error });

    const customerId = await canonicalCustomer(platform, rawCustomer);
    // One open dispatch per customer: a new one replaces the current one
    const id = await dispatches.create({
      platform,
      customerId,
      agentId: agent._id,
      byId: req.user._id,
      note: cleanNote(body.note),
    });
    await assignConversation({ platform, customerId, agentId: agent._id });
    clearCaches();

    const dispatch = await dispatches.byId(id);
    broadcast(req, "created", dispatch);
    console.log(`[Dispatch] ${platform}:${customerId} → ${fullName(agent)} by ${fullName(req.user)}`);
    return res.json({ success: true, dispatch });
  } catch (error) {
    return fail(res, error, "Impossible de dispatcher la discussion.", "create");
  }
});

// GET /api/dispatch/mine — my open dispatches, oldest first, every platform
router.get("/mine", protect, async (req, res) => {
  try {
    const items = await dispatches.list({ status: "open", agentId: req.user._id, limit: 500 });
    const counts = {};
    for (const d of items) counts[d.platform] = (counts[d.platform] || 0) + 1;
    return res.json({ items, counts });
  } catch (error) {
    return fail(res, error, "Impossible de charger vos dispatchs.", "mine");
  }
});

// GET /api/dispatch?status=open|done|cancelled|all&platform=&agentId=
router.get("/", protect, authorize("admin", "manager"), async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "open";
    if (!STATUSES.has(status)) {
      return res.status(400).json({ message: "Statut invalide." });
    }
    let platform = null;
    if (req.query.platform) {
      platform = sanitizePlatform(req.query.platform);
      if (!platform) return res.status(400).json({ message: "Plateforme invalide." });
    }
    let agentId = null;
    if (req.query.agentId) {
      if (typeof req.query.agentId !== "string" || !users.userIdOf(req.query.agentId)) {
        return res.status(400).json({ message: "Agent invalide." });
      }
      agentId = String(users.userIdOf(req.query.agentId));
    }
    const items = await dispatches.list({
      status: status === "all" ? null : status,
      platform,
      agentId,
      limit: 1000,
    });
    return res.json({ items });
  } catch (error) {
    return fail(res, error, "Impossible de charger les dispatchs.", "list");
  }
});

// PUT /api/dispatch/:id/done — the assigned agent, an admin or a manager
router.put("/:id/done", protect, async (req, res) => {
  try {
    if (!validId(req, res)) return undefined;
    const isStaff = req.user.role === "admin" || req.user.role === "manager";
    const before = await dispatches.close(req.params.id, {
      status: "done",
      byId: req.user._id,
      allow: (it) =>
        isStaff || String(it.agentId) === String(req.user._id)
          ? null
          : "Ce dispatch est attribué à un autre agent.",
    });
    clearCaches();
    const dispatch = await dispatches.byId(req.params.id);
    broadcast(req, "done", dispatch);
    console.log(`[Dispatch] ${before.platform}:${before.customerId} done by ${fullName(req.user)}`);
    return res.json({ success: true, dispatch });
  } catch (error) {
    return fail(res, error, "Impossible de clore le dispatch.", "done");
  }
});

// PUT /api/dispatch/:id/reassign  { agentId, note? } — admin
router.put("/:id/reassign", protect, authorize("admin"), async (req, res) => {
  try {
    if (!validId(req, res)) return undefined;
    const body = req.body || {};
    const current = await dispatches.openItem(req.params.id);
    const { agent, error } = await loadAgent(body.agentId);
    if (error) return res.status(400).json({ message: error });

    // Cancels the current one (one open per customer) and opens the new one
    const id = await dispatches.create({
      platform: current.platform,
      customerId: current.customerId,
      agentId: agent._id,
      byId: req.user._id,
      note: body.note === undefined ? current.note || "" : cleanNote(body.note),
    });
    await assignConversation({
      platform: current.platform,
      customerId: current.customerId,
      agentId: agent._id,
    });
    clearCaches();
    const dispatch = await dispatches.byId(id);
    broadcast(req, "reassigned", dispatch);
    console.log(
      `[Dispatch] ${current.platform}:${current.customerId} reassigned → ${fullName(agent)} by ${fullName(req.user)}`,
    );
    return res.json({ success: true, dispatch });
  } catch (error) {
    return fail(res, error, "Impossible de réattribuer le dispatch.", "reassign");
  }
});

// DELETE /api/dispatch/:id — admin: cancel (the lock stays with the agent)
router.delete("/:id", protect, authorize("admin"), async (req, res) => {
  try {
    if (!validId(req, res)) return undefined;
    const before = await dispatches.close(req.params.id, {
      status: "cancelled",
      byId: req.user._id,
    });
    clearCaches();
    const dispatch = await dispatches.byId(req.params.id);
    broadcast(req, "cancelled", dispatch);
    console.log(`[Dispatch] ${before.platform}:${before.customerId} cancelled by ${fullName(req.user)}`);
    return res.json({ success: true, dispatch });
  } catch (error) {
    return fail(res, error, "Impossible d’annuler le dispatch.", "cancel");
  }
});

module.exports = router;
