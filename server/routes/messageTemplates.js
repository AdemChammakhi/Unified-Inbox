/**
 * messageTemplates.js — canned replies for the inbox.
 *
 *   GET    /api/message-templates          any role      active templates (filters: platform, q;
 *                                                        includeInactive=1 for admin/manager)
 *   POST   /api/message-templates          admin/manager create
 *   PUT    /api/message-templates/:id      admin/manager update
 *   DELETE /api/message-templates/:id      admin/manager deactivate (hard delete with ?hard=1)
 *   POST   /api/message-templates/:id/use  any role      count one use (insert or copy)
 *
 * Responses carry `categories`, the distinct category labels of the returned
 * rows, so the client can draw filter chips without a second call.
 */

"use strict";

const express = require("express");
const mongoose = require("mongoose");
const MessageTemplate = require("../models/MessageTemplate");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
const write = [protect, authorize("admin", "manager")];

const PLATFORMS = new Set(MessageTemplate.PLATFORMS);
const MAX = { title: 120, category: 60, body: 4096 };

const oneLine = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The body keeps its line breaks; only surrounding blank lines are trimmed. */
const multiLine = (v, max) =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const isManager = (req) => req.user && ["admin", "manager"].includes(req.user.role);

function sanitize(body) {
  const out = {};
  if (body.title !== undefined) out.title = oneLine(body.title, MAX.title);
  if (body.category !== undefined) out.category = oneLine(body.category, MAX.category);
  if (body.body !== undefined) out.body = multiLine(body.body, MAX.body);
  if (body.platforms !== undefined) {
    const list = Array.isArray(body.platforms) ? body.platforms : [];
    out.platforms = [...new Set(list.filter((p) => PLATFORMS.has(p)))];
  }
  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    out.sortOrder = Number.isFinite(n) ? Math.max(-9999, Math.min(9999, Math.round(n))) : 0;
  }
  if (body.isActive !== undefined) {
    out.isActive = body.isActive === true || body.isActive === "true";
  }
  return out;
}

const categoriesOf = (rows) =>
  [...new Set(rows.map((t) => t.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "fr", { sensitivity: "base" }),
  );

// ── List ────────────────────────────────────────────────────────────────────
router.get("/", protect, async (req, res) => {
  try {
    const filter = {};
    if (!(req.query.includeInactive === "1" && isManager(req))) filter.isActive = true;
    const platform = oneLine(req.query.platform, 20);
    if (PLATFORMS.has(platform)) {
      filter.$or = [{ platforms: { $size: 0 } }, { platforms: platform }];
    }
    const q = oneLine(req.query.q, 80);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$and = [{ $or: [{ title: rx }, { body: rx }, { category: rx }] }];
    }
    const templates = await MessageTemplate.find(filter)
      .sort({ sortOrder: 1, category: 1, title: 1 })
      .limit(500)
      .lean();
    res.json({ templates, categories: categoriesOf(templates) });
  } catch (err) {
    console.error("[templates] list failed:", err.message);
    res.status(500).json({ message: "Impossible de charger les modèles." });
  }
});

// ── Create ──────────────────────────────────────────────────────────────────
router.post("/", ...write, async (req, res) => {
  try {
    const data = sanitize(req.body || {});
    if (!data.title) return res.status(400).json({ message: "Le titre est obligatoire." });
    if (!data.body) return res.status(400).json({ message: "Le message est obligatoire." });
    const template = await MessageTemplate.create({
      ...data,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    res.status(201).json({ template });
  } catch (err) {
    console.error("[templates] create failed:", err.message);
    res.status(500).json({ message: "Impossible d'enregistrer le modèle." });
  }
});

// ── Update ──────────────────────────────────────────────────────────────────
router.put("/:id", ...write, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ message: "Modèle introuvable." });
    const data = sanitize(req.body || {});
    if (data.title === "") return res.status(400).json({ message: "Le titre est obligatoire." });
    if (data.body === "") return res.status(400).json({ message: "Le message est obligatoire." });
    const template = await MessageTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: { ...data, updatedBy: req.user._id } },
      { new: true, runValidators: true },
    ).lean();
    if (!template) return res.status(404).json({ message: "Modèle introuvable." });
    res.json({ template });
  } catch (err) {
    console.error("[templates] update failed:", err.message);
    res.status(500).json({ message: "Impossible d'enregistrer le modèle." });
  }
});

// ── Deactivate / delete ─────────────────────────────────────────────────────
router.delete("/:id", ...write, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ message: "Modèle introuvable." });
    if (req.query.hard === "1") {
      const gone = await MessageTemplate.findByIdAndDelete(req.params.id).lean();
      if (!gone) return res.status(404).json({ message: "Modèle introuvable." });
      return res.json({ success: true, deleted: true });
    }
    const template = await MessageTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false, updatedBy: req.user._id } },
      { new: true },
    ).lean();
    if (!template) return res.status(404).json({ message: "Modèle introuvable." });
    res.json({ success: true, template });
  } catch (err) {
    console.error("[templates] delete failed:", err.message);
    res.status(500).json({ message: "Impossible de supprimer le modèle." });
  }
});

// ── Usage counter ───────────────────────────────────────────────────────────
router.post("/:id/use", protect, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ message: "Modèle introuvable." });
    await MessageTemplate.updateOne({ _id: req.params.id }, { $inc: { usageCount: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Erreur serveur." });
  }
});

module.exports = router;
