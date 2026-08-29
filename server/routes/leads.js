/**
 * leads.js — the prospect sheet as data, for the in-app Leads page.
 *
 * Same rows the Excel/CSV export produces (server/routes/exports.js), served
 * as JSON so the table can be read, sorted and filtered without downloading
 * a file. Filtering happens in the browser: the whole set is a few hundred
 * rows, and every keystroke re-querying twenty thousand messages would be
 * absurd.
 *
 * A short cache keeps repeated visits cheap — the underlying scan is the
 * expensive part, not the serialization.
 */

"use strict";

const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth");
const { sanitizePlatform } = require("../utils/sanitize");
const { buildProspectRows } = require("./exports");

const CACHE_TTL_MS = 30 * 1000;
const _cache = new Map(); // "<platform>:<range>" -> { at, rows }

// GET /api/leads?platform=all|<platform>&range=<days|all>
router.get("/", protect, authorize("admin", "manager"), async (req, res) => {
  try {
    const platform =
      req.query.platform && req.query.platform !== "all"
        ? sanitizePlatform(req.query.platform)
        : null;
    if (req.query.platform && req.query.platform !== "all" && !platform) {
      return res.status(400).json({ message: "Plateforme invalide" });
    }

    let rangeDays = null;
    if (req.query.range !== undefined && req.query.range !== "all") {
      if (typeof req.query.range !== "string") {
        return res.status(400).json({ message: "Période invalide" });
      }
      rangeDays = Number.parseInt(req.query.range, 10);
      if (!Number.isInteger(rangeDays) || rangeDays <= 0 || rangeDays > 3650) {
        return res.status(400).json({ message: "Période invalide" });
      }
    }

    const key = `${platform || "all"}:${rangeDays || "all"}`;
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json({ rows: hit.rows, truncated: hit.truncated, cached: true });
    }

    const since = rangeDays
      ? new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000)
      : null;
    const rows = await buildProspectRows({ platform, since });
    const payload = { rows: [...rows], truncated: Boolean(rows.truncated) };
    _cache.set(key, { at: Date.now(), ...payload });
    // Keep the cache from growing without bound across filter combinations
    if (_cache.size > 20) _cache.delete(_cache.keys().next().value);

    return res.json({ ...payload, cached: false });
  } catch (err) {
    console.error("[Leads] failed:", err.message);
    return res.status(500).json({ message: "Impossible de charger les leads" });
  }
});

module.exports = router;
