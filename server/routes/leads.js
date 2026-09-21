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
// Bumped by every clear, so a build that started before the clear does not
// put its now-stale rows back into the cache when it finishes.
let _generation = 0;

/**
 * Forget every cached sheet. Called when something the rows are derived from
 * changes outside a message (a frein recorded, for instance), so the next
 * visit shows it instead of a 30-second-old copy.
 */
function clearLeadsCache() {
  _generation++;
  _cache.clear();
}

// Builds run ONE at a time and concurrent requests for the same sheet share
// the build in flight. The backend container has 512 MB and half a core:
// an agent clicking 90j → 30j → Tout used to start three full scans at once,
// each slower for the others' sake, until the browser's timeout gave up on
// all of them.
const _inFlight = new Map(); // key -> Promise<payload>
let _queue = Promise.resolve();

function buildOnce(key, platform, since) {
  if (_inFlight.has(key)) return _inFlight.get(key);
  const run = _queue.then(async () => {
    const t0 = Date.now();
    const rows = await buildProspectRows({ platform, since });
    console.log(
      `[Leads] built ${key} in ${Date.now() - t0} ms — ${rows.length} rows` +
        (rows.truncated ? " (truncated)" : ""),
    );
    return { rows: [...rows], truncated: Boolean(rows.truncated) };
  });
  _queue = run.catch(() => {});
  const tracked = run.finally(() => _inFlight.delete(key));
  _inFlight.set(key, tracked);
  return tracked;
}

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
    const generation = _generation;
    const payload = await buildOnce(key, platform, since);
    if (generation === _generation) {
      _cache.set(key, { at: Date.now(), ...payload });
      // Keep the cache from growing without bound across filter combinations
      if (_cache.size > 20) _cache.delete(_cache.keys().next().value);
    }

    return res.json({ ...payload, cached: false });
  } catch (err) {
    console.error("[Leads] failed:", err.message);
    return res.status(500).json({ message: "Impossible de charger les leads" });
  }
});

module.exports = router;
module.exports.clearLeadsCache = clearLeadsCache;
