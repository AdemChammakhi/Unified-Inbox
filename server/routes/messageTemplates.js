/**
 * messageTemplates.js — canned replies for the inbox, served as a READ-ONLY
 * library.
 *
 * The SQL Server schema (database/sqlserver/schema/dbunifedbox.sql) has no
 * table for message templates and is never extended (decisions D5, D6 and
 * D11: rows only, never schema). The library is therefore MEDTOURS' official
 * quick-reply document, server/data/messageTemplates.seed.json, loaded once
 * with the module. The HTTP API keeps main's paths, filters and response
 * shapes so the inbox panel and the Modèles page work unchanged; the writes
 * answer 405, and `readOnly: true` on the list tells the page to hide its
 * editors. Usage is not counted: there is no table to count it in.
 *
 *   GET    /api/message-templates          any role  the library (filters: platform, q)
 *   POST   /api/message-templates/:id/use  any role  acknowledged, nothing stored
 *   POST   /api/message-templates          405
 *   PUT    /api/message-templates/:id      405
 *   DELETE /api/message-templates/:id      405
 *
 * Responses carry `categories`, the distinct category labels of the returned
 * rows, so the client can draw filter chips without a second call.
 */

"use strict";

const express = require("express");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

const READ_ONLY_MESSAGE =
  "Les modèles sont une bibliothèque en lecture seule (fichier server/data/messageTemplates.seed.json).";

const oneLine = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The body keeps its line breaks; only surrounding blank lines are trimmed. */
const multiLine = (v, max) =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";

/** The library, in main's template shape; the seed key stands in for the id. */
function loadLibrary() {
  let rows;
  try {
    rows = require("../data/messageTemplates.seed.json");
  } catch (err) {
    console.error("[templates] seed file unreadable:", err.message);
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.seedKey === "string" && r.seedKey && r.title && r.body)
    .map((r) => ({
      _id: r.seedKey,
      title: oneLine(r.title, 120),
      body: multiLine(r.body, 4096),
      category: oneLine(r.category, 60),
      // Empty: a library template applies to every platform
      platforms: [],
      sortOrder: Number.isFinite(Number(r.sortOrder)) ? Number(r.sortOrder) : 0,
      isActive: true,
      usageCount: 0,
      seedKey: r.seedKey,
    }));
}

// Main sorted on MongoDB's default (binary) string order
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const TEMPLATES = Object.freeze(
  loadLibrary().sort(
    (a, b) => a.sortOrder - b.sortOrder || cmp(a.category, b.category) || cmp(a.title, b.title),
  ),
);
const BY_ID = new Map(TEMPLATES.map((t) => [t._id, t]));

// In the order the templates come (sortOrder first), so the official
// library's categories read ACC, TEL, QUAL, OFF… as in the document
const categoriesOf = (rows) => [...new Set(rows.map((t) => t.category).filter(Boolean))];

const readOnly = (req, res) => res.status(405).json({ message: READ_ONLY_MESSAGE });
const write = [protect, authorize("admin", "manager")];

// ── List ────────────────────────────────────────────────────────────────────
router.get("/", protect, (req, res) => {
  try {
    // `platform`: every library template has an empty platform list, so it
    // applies to all of them; `includeInactive`: nothing is ever inactive.
    let templates = TEMPLATES;
    const q = oneLine(req.query.q, 80).toLowerCase();
    if (q) {
      templates = templates.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.body.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      );
    }
    templates = templates.slice(0, 500);
    res.json({ templates, categories: categoriesOf(templates), readOnly: true });
  } catch (err) {
    console.error("[templates] list failed:", err.message);
    res.status(500).json({ message: "Impossible de charger les modèles." });
  }
});

// ── Writes: refused, the library is a file ──────────────────────────────────
router.post("/", ...write, readOnly);
router.put("/:id", ...write, readOnly);
router.delete("/:id", ...write, readOnly);

// ── Usage counter ───────────────────────────────────────────────────────────
// Acknowledged for the client's sake; no counter exists (decision D11).
router.post("/:id/use", protect, (req, res) => {
  if (!BY_ID.has(req.params.id)) return res.status(404).json({ message: "Modèle introuvable." });
  res.json({ success: true });
});

module.exports = router;
