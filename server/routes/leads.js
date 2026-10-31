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
const rateLimit = require("express-rate-limit");
const { buildProspectRows, sendSheet, rangeLabelOf } = require("./exports");
const IncomingCall = require("../models/IncomingCall");
const Classification = require("../models/Classification");
const ConversationLock = require("../models/ConversationLock");
const { isTypology, TYPOLOGY_KEYS } = require("../constants/pipeline");

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
  // A build already running read the data BEFORE this change. Forget it, so
  // the next request starts a fresh build instead of joining the old one —
  // joining it used to hand back (and cache for 30 s) the sheet without the
  // edit just saved, which looked like the edit had been undone.
  _inFlight.clear();
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
  // Only remove our own entry: after a clear, a newer build may hold the key
  const tracked = run.finally(() => {
    if (_inFlight.get(key) === tracked) _inFlight.delete(key);
  });
  _inFlight.set(key, tracked);
  return tracked;
}

/**
 * What a user may see of a built sheet. Admins and managers get every row;
 * an agent (`marketing`) gets HIS leads only — the rows whose "Commercial en
 * charge" he is (he holds the conversation, or sent its latest CRM reply).
 * Enforced here, not in the page: the cache holds the whole sheet, so the
 * cut is made per request and nothing else leaves the server.
 */
function scopedFor(user, payload) {
  if (user.role !== "marketing") return { ...payload, scope: "all" };
  const me = String(user._id);
  return {
    ...payload,
    rows: payload.rows.filter((row) => row.agentId === me),
    scope: "mine",
  };
}

/**
 * The period of a request: a positive number of days, or null for the whole
 * history ("all" or absent). `undefined` means invalid. Must arrive as a
 * plain string or number: Express's extended parser turns ?range[$gt]=1 into
 * an object, whose parseInt is NaN.
 */
function parseRange(raw) {
  if (raw === undefined || raw === "all") return null;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const days = Number.parseInt(raw, 10);
  return Number.isInteger(days) && days > 0 && days <= 3650 ? days : undefined;
}

/** The whole sheet for a period, from the cache or a (shared) build. */
async function sheetFor(platform, rangeDays) {
  const key = `${platform || "all"}:${rangeDays || "all"}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { rows: hit.rows, truncated: hit.truncated, cached: true };
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
  return { ...payload, cached: false };
}

// GET /api/leads?platform=all|<platform>&range=<days|all>
// Every role reads the sheet, each within its scope (see scopedFor): agents
// come here after the inbox to find the prospects they follow and their
// numbers. The full-sheet export (routes/exports.js) stays with admins and
// managers; everyone can export the rows on screen (POST /export below).
router.get("/", protect, authorize("admin", "manager", "marketing"), async (req, res) => {
  try {
    const platform =
      req.query.platform && req.query.platform !== "all"
        ? sanitizePlatform(req.query.platform)
        : null;
    if (req.query.platform && req.query.platform !== "all" && !platform) {
      return res.status(400).json({ message: "Plateforme invalide" });
    }

    const rangeDays = parseRange(req.query.range);
    if (rangeDays === undefined) {
      return res.status(400).json({ message: "Période invalide" });
    }

    const { cached, ...payload } = await sheetFor(platform, rangeDays);
    return res.json({ ...scopedFor(req.user, payload), cached });
  } catch (err) {
    console.error("[Leads] failed:", err.message);
    return res.status(500).json({ message: "Impossible de charger les leads" });
  }
});

// The Leads page's export: exactly the rows on screen, filtered and sorted
// as the user left them. The page sends the keys of those rows in display
// order; the server rebuilds them from the same sheet, within the user's
// scope, so an agent can only ever export his own leads whatever he sends.
// The route has its own 1 MB body limit (server/index.js): ~30 bytes a key,
// so the whole sheet of any period fits — 90 days or "Tout" is several
// thousand rows, which the first limit (3000 rows / 100 KB) refused.
const EXPORT_MAX_ROWS = 25000;
// A workbook of thousands of rows is memory-hungry in the 512 MB backend:
// one big export at a time, like the full export (routes/exports.js).
const BIG_EXPORT_ROWS = 2000;
let _bigExportInFlight = false;
// Its own budget, apart from the full export's: the file is small (built
// from the cached sheet), and agents behind one office IP share the count.
const viewExportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { message: "Trop d'exports demandés. Réessayez dans quelques minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/leads/export {format: xlsx|csv, range, keys: ["<platform>:<customerId>", …], note?}
router.post(
  "/export",
  viewExportLimiter,
  protect,
  authorize("admin", "manager", "marketing"),
  async (req, res) => {
    try {
      const body = req.body || {};
      const format = body.format === "csv" ? "csv" : "xlsx";
      const rangeDays = parseRange(body.range);
      if (rangeDays === undefined) {
        return res.status(400).json({ message: "Période invalide" });
      }
      const keys = Array.isArray(body.keys)
        ? body.keys.filter((k) => typeof k === "string" && k.length <= 200)
        : null;
      if (!keys || keys.length === 0) {
        return res.status(400).json({ message: "Aucun prospect à exporter." });
      }
      if (keys.length > EXPORT_MAX_ROWS) {
        return res.status(400).json({
          message: `Trop de lignes (${keys.length}) : affinez les filtres, maximum ${EXPORT_MAX_ROWS}.`,
        });
      }
      const big = keys.length > BIG_EXPORT_ROWS;
      if (big && _bigExportInFlight) {
        return res.status(429).json({
          message: "Un export est déjà en cours. Patientez quelques secondes et réessayez.",
        });
      }
      if (big) _bigExportInFlight = true;
      try {
        const { rows: all, truncated } = await sheetFor(null, rangeDays);
        const byKey = new Map(
          scopedFor(req.user, { rows: all }).rows.map((r) => [
            `${r.platform}:${r.customerId}`,
            r,
          ]),
        );
        const seen = new Set();
        const rows = [];
        for (const k of keys) {
          const row = byKey.get(k);
          if (row && !seen.has(k)) {
            seen.add(k);
            rows.push(row);
          }
        }
        if (rows.length === 0) {
          return res.status(404).json({
            message: "Ces prospects ne sont plus dans la liste. Rafraîchissez la page.",
          });
        }
        rows.truncated = truncated;

        const note = oneLine(body.note, 300);
        const dateTag = new Date().toISOString().slice(0, 10);
        const who = req.user.role === "marketing" ? "mes-leads" : "selection";
        return await sendSheet(res, rows, {
          format,
          fileName: `leads-medtour-${who}-${dateTag}`,
          meta: {
            platformLabel: req.user.role === "marketing" ? "Mes leads" : "Sélection",
            rangeLabel: rangeLabelOf(rangeDays),
            note: `${rows.length} prospect${rows.length > 1 ? "s" : ""}${note ? ` · ${note}` : ""}`,
          },
        });
      } finally {
        if (big) _bigExportInFlight = false;
      }
    } catch (err) {
      console.error("[Leads] export failed:", err.message);
      return res.status(500).json({ message: "L'export a échoué" });
    }
  },
);

const oneLine = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * Digits of a phone number as dialled. A Tunisian local number (8 digits)
 * gets the 216 country code, so "98 123 456" and "+216 98 123 456" are the
 * same caller.
 */
function phoneDigits(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 8) digits = `216${digits}`;
  return digits;
}

/** "+216 98 123 456" for a Tunisian number, "+<digits>" otherwise. */
function phoneDisplay(digits) {
  const m = /^216(\d{2})(\d{3})(\d{3})$/.exec(digits);
  return m ? `+216 ${m[1]} ${m[2]} ${m[3]}` : `+${digits}`;
}

// POST /api/leads/incoming-call
// { name, phone, email?, typologie?, pax?, comment? }
// Records a prospect who called the agency, so phone leads are followed in
// the same sheet as the others. Every role may record one; the agent who
// records it is put in charge (the conversation lock), so it lands in his
// "Mes leads". A number already recorded is the same lead: the call is
// counted on it, its fields are completed, and its agent is kept.
router.post("/incoming-call", protect, async (req, res) => {
  try {
    const body = req.body || {};
    const name = oneLine(body.name, 120);
    if (!name) {
      return res.status(400).json({ message: "Le nom du prospect est obligatoire." });
    }
    if (typeof body.phone !== "string") {
      return res.status(400).json({ message: "Le numéro de téléphone est obligatoire." });
    }
    const digits = phoneDigits(body.phone);
    if (digits.length < 8 || digits.length > 15) {
      return res.status(400).json({ message: "Numéro de téléphone invalide." });
    }
    const email = oneLine(body.email, 160).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Adresse email invalide." });
    }
    const typologie = body.typologie === undefined || body.typologie === null ? "" : body.typologie;
    if (typologie !== "" && !isTypology(typologie)) {
      return res.status(400).json({
        message: `Typologie invalide. Valeurs possibles : ${TYPOLOGY_KEYS.join(", ")}`,
      });
    }
    let pax = null;
    if (body.pax !== undefined && body.pax !== null && body.pax !== "") {
      pax = typeof body.pax === "string" ? Number(body.pax.trim()) : body.pax;
      if (!Number.isInteger(pax) || pax < 1 || pax > 999) {
        return res.status(400).json({ message: "Nombre de PAX invalide (un entier entre 1 et 999)." });
      }
    }
    if (body.comment !== undefined && body.comment !== null && typeof body.comment !== "string") {
      return res.status(400).json({ message: "Commentaire invalide." });
    }
    const comment = String(body.comment || "").replace(/\r\n?/g, "\n").trim().slice(0, 1000);

    const customerId = `appel-${digits}`;
    const now = new Date();
    const existing = await IncomingCall.findOne({ customerId }).lean();
    const call = await IncomingCall.findOneAndUpdate(
      { customerId },
      existing
        ? {
            $set: { name, lastCallAt: now, ...(email ? { email } : {}) },
            $inc: { callCount: 1 },
          }
        : {
            $setOnInsert: {
              customerId,
              name,
              phone: phoneDisplay(digits),
              email,
              firstCallAt: now,
              lastCallAt: now,
              callCount: 1,
              createdBy: req.user._id,
            },
          },
      { upsert: true, new: true },
    ).lean();

    // Dossier: a new lead starts at "Contact établi" — the agent has just
    // spoken to the customer. On a repeat call only the fields given are set.
    const set = { classifiedBy: req.user._id };
    if (typologie) set.typologie = typologie;
    if (pax !== null) set.pax = pax;
    if (comment) {
      set.comment = comment;
      set.commentBy = req.user._id;
      set.commentAt = now;
    }
    await Classification.updateOne(
      { conversationId: customerId, platform: "telephone" },
      { $set: set, $setOnInsert: { stage: "contact_etabli" } },
      { upsert: true, runValidators: true },
    );

    // In charge: the recording agent, unless someone already holds the lead
    const held = await ConversationLock.findOne({ conversationId: customerId, platform: "telephone" })
      .populate("lockedBy", "firstName lastName")
      .lean();
    if (!held) {
      await ConversationLock.updateOne(
        { conversationId: customerId, platform: "telephone" },
        { $setOnInsert: { lockedBy: req.user._id, lockedAt: now } },
        { upsert: true },
      );
    }

    clearLeadsCache();
    return res.status(existing ? 200 : 201).json({
      created: !existing,
      customerId,
      name: call.name,
      phone: call.phone,
      callCount: call.callCount,
      heldBy:
        held && held.lockedBy
          ? `${held.lockedBy.firstName || ""} ${held.lockedBy.lastName || ""}`.trim()
          : null,
    });
  } catch (err) {
    console.error("[Leads] incoming call failed:", err.message);
    return res.status(500).json({ message: "Impossible d'enregistrer l'appel." });
  }
});

module.exports = router;
module.exports.clearLeadsCache = clearLeadsCache;
