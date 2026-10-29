/**
 * leadInsights.js — per-conversation lead indicators for the inbox views.
 *
 *   POST /api/lead-insights        counts, maturity and frein for a list page
 *   PUT  /api/lead-insights/frein  record the main need or obstacle
 *
 * Nothing here is stored except the frein (contact custom fields, see
 * utils/leadFrein.js). Message counts, the maturity level and the "needs
 * qualification" flag are computed from the customer's conversation and its
 * messages at read time.
 *
 * Ids: a conversation has no single stable id (CLAUDE.md §6). The client
 * sends each list row as { key: conv.id, customerId: first participant },
 * and everything is keyed by the CUSTOMER, the only id both list shapes
 * share. Either id finds the customer's conversation (the thread id is
 * recorded on it once known); `keyToCustomer` in the response lets the
 * client look a row up by its conversation key when its participant id was
 * missing.
 */

"use strict";

const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { db } = require("../db/sql");
const conversations = require("../db/conversations");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");
const { resolveRecipientId } = require("../utils/resolveRecipient");
const {
  isValidFreinCode,
  freinLabel,
  setFrein,
  getFreins,
} = require("../utils/leadFrein");
const { THRESHOLDS, computeMaturity } = require("../utils/leadMaturity");

const PLATFORMS = new Set(["instagram", "facebook", "whatsapp", "email"]);
const MAX_ITEMS = 200;
const MAX_ID_LENGTH = 512;

const CACHE_TTL_MS = 20 * 1000;
const CACHE_MAX = 50;
const _cache = new Map(); // cacheKey -> { at, payload }
const _inFlight = new Map(); // cacheKey -> Promise<payload>
// Bumped by clearInsightsCache so a computation that started before a write
// cannot put its (now stale) result back into the cache.
let _generation = 0;

/** Drop every cached insight (after a frein or classification change). */
function clearInsightsCache() {
  _cache.clear();
  _inFlight.clear();
  _generation += 1;
}

/** Ids that are us, never a prospect (same list as exports.js). */
function ownIds() {
  return new Set(
    [
      process.env.FACEBOOK_PAGE_ID,
      process.env.INSTAGRAM_ACCOUNT_ID,
      process.env.WHATSAPP_PHONE_NUMBER_ID,
      process.env.EMAIL_USER,
      "agent",
      "unknown",
      "Page",
    ].filter(Boolean),
  );
}

/**
 * Graph thread ids (t_…) are conversations, never people. Email has no
 * threads, and an address may legitimately start with "t_".
 */
function isThreadId(platform, id) {
  return platform !== "email" && typeof id === "string" && id.startsWith("t_");
}

/** sanitizeId plus the checks a list id needs: non-empty and bounded. */
function cleanId(value) {
  const id = sanitizeId(value);
  if (!id || id.length > MAX_ID_LENGTH) return null;
  return id;
}

function checkPlatform(value) {
  const platform = sanitizePlatform(value);
  return platform && PLATFORMS.has(platform) ? platform : null;
}

function userName(user) {
  if (!user) return "";
  return `${user.firstName || ""} ${user.lastName || ""}`.trim();
}

/** The client-facing frein (setBy stays server-side). */
function publicFrein(frein) {
  if (!frein) return null;
  return {
    code: frein.code,
    label: frein.label,
    note: frein.note || "",
    setAt: frein.setAt || null,
    setByName: frein.setByName || "",
  };
}

/** Lazily clear the leads sheet cache; leads.js may not export it. */
function clearLeadsCacheSafely() {
  try {
    const leads = require("./leads");
    if (leads && typeof leads.clearLeadsCache === "function") {
      leads.clearLeadsCache();
    }
  } catch (err) {
    console.error("[LeadInsights] leads cache clear failed:", err.message);
  }
}

/**
 * Map each list row to its customer, and each customer to its stored
 * conversation (null when nothing is stored for it yet).
 * @returns {Promise<{ customers: Map<string, object|null>, keyToCustomer: Map<string,string> }>}
 */
async function resolveCustomers(platform, items, own) {
  const usable = (id) => id && !isThreadId(platform, id) && !own.has(id);
  const keys = [
    ...new Set(items.flatMap((it) => [it.key, it.customerId].filter(Boolean))),
  ];
  const stored = await conversations.findByKeys(platform, keys);
  const byKey = new Map();
  for (const conv of stored) {
    if (conv.customerId && !byKey.has(conv.customerId)) byKey.set(conv.customerId, conv);
    if (!byKey.has(conv.externalId)) byKey.set(conv.externalId, conv);
  }

  const customers = new Map();
  const keyToCustomer = new Map();
  for (const { key, customerId } of items) {
    const conv =
      (customerId && byKey.get(customerId)) || (key && byKey.get(key)) || null;
    let customer = conv && usable(conv.customerId) ? conv.customerId : null;
    if (!customer) customer = usable(customerId) ? customerId : usable(key) ? key : null;
    if (!customer) continue;
    if (!customers.get(customer)) {
      customers.set(customer, conv && conv.customerId === customer ? conv : null);
    }
    if (key) keyToCustomer.set(key, customer);
  }
  return { customers, keyToCustomer };
}

/** Message counts and latest times per conversation, over all history. */
async function messageStats(conversationIds) {
  const stats = new Map();
  if (conversationIds.length === 0) return stats;
  const rows = (
    await db.query(
      `SELECT m.conversation_id,
              messages_in = SUM(CASE WHEN m.sender_type = N'contact' THEN 1 ELSE 0 END),
              messages_out = SUM(CASE WHEN m.sender_type <> N'contact' THEN 1 ELSE 0 END),
              last_in = MAX(CASE WHEN m.sender_type = N'contact' THEN dbo.fn_DateTimeCombine(m.sent_date, m.sent_time) END),
              last_out = MAX(CASE WHEN m.sender_type <> N'contact' THEN dbo.fn_DateTimeCombine(m.sent_date, m.sent_time) END)
       FROM dbo.message m
       WHERE m.conversation_id IN (SELECT CONVERT(int, value) FROM OPENJSON(@ids))
       GROUP BY m.conversation_id`,
      { ids: JSON.stringify(conversationIds) },
    )
  ).rows;
  for (const r of rows) stats.set(r.conversation_id, r);
  return stats;
}

/** Build the full response for one platform and a list of rows. */
async function computeInsights(platform, items) {
  const own = ownIds();
  const { customers, keyToCustomer } = await resolveCustomers(
    platform,
    items,
    own,
  );

  const insights = Object.create(null);
  const keyMap = Object.create(null);
  for (const [key, customer] of keyToCustomer) keyMap[key] = customer;
  if (customers.size === 0) {
    return { insights, keyToCustomer: keyMap, thresholds: THRESHOLDS };
  }

  const convIds = [...customers.values()].filter(Boolean).map((c) => c.id);
  const [stats, freins] = await Promise.all([
    messageStats(convIds),
    getFreins(platform, [...customers.keys()]),
  ]);

  const now = new Date();
  for (const [customer, conv] of customers) {
    const st = (conv && stats.get(conv.id)) || {};
    const messagesIn = Number(st.messages_in) || 0;
    const messagesOut = Number(st.messages_out) || 0;
    const lastIncomingAt = st.last_in || null;
    const lastOutgoingAt = st.last_out || null;
    const frein = freins.get(customer) || null;
    insights[customer] = {
      messagesIn,
      messagesOut,
      lastIncomingAt,
      lastOutgoingAt,
      maturity: computeMaturity({
        messagesIn,
        messagesOut,
        lastIncomingAt,
        lastOutgoingAt,
        stage: conv ? conv.stage : null,
        qualification: conv ? conv.qualification : null,
        appointmentAt: conv ? conv.appointmentAt : null,
        frein,
        now,
      }),
      frein: publicFrein(frein),
      needsQualification: messagesOut >= 1 && !frein,
    };
  }

  return { insights, keyToCustomer: keyMap, thresholds: THRESHOLDS };
}

// POST /api/lead-insights  { platform, items: [{ key, customerId }] }
router.post("/", protect, async (req, res) => {
  try {
    const body = req.body || {};
    const platform = checkPlatform(body.platform);
    if (!platform) {
      return res.status(400).json({ message: "Plateforme invalide." });
    }
    const rawItems = body.items;
    if (
      !Array.isArray(rawItems) ||
      rawItems.length < 1 ||
      rawItems.length > MAX_ITEMS
    ) {
      return res.status(400).json({
        message: `La liste doit contenir entre 1 et ${MAX_ITEMS} conversations.`,
      });
    }

    const items = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const key = cleanId(raw.key);
      const customerId = cleanId(raw.customerId);
      if (!key && !customerId) continue;
      items.push({ key, customerId });
    }
    if (items.length === 0) {
      return res.json({
        insights: {},
        keyToCustomer: {},
        thresholds: THRESHOLDS,
      });
    }

    // Keyed on the exact (key, customer) pairs: the same customers under
    // different conversation keys can resolve differently.
    // JSON.stringify quotes and escapes every id, so no two different lists
    // can produce the same signature, whatever characters the ids hold.
    const signature = JSON.stringify(
      [
        ...new Set(
          items.map((it) =>
            JSON.stringify([it.key || "", it.customerId || ""]),
          ),
        ),
      ].sort(),
    );
    const cacheKey = `${platform}:${crypto
      .createHash("sha1")
      .update(signature)
      .digest("hex")}`;

    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json(hit.payload);
    }

    let pending = _inFlight.get(cacheKey);
    if (!pending) {
      const generation = _generation;
      pending = computeInsights(platform, items)
        .then((payload) => {
          if (generation === _generation) {
            _cache.delete(cacheKey);
            _cache.set(cacheKey, { at: Date.now(), payload });
            while (_cache.size > CACHE_MAX) {
              _cache.delete(_cache.keys().next().value);
            }
          }
          return payload;
        })
        .finally(() => {
          if (_inFlight.get(cacheKey) === pending) _inFlight.delete(cacheKey);
        });
      _inFlight.set(cacheKey, pending);
    }

    const payload = await pending;
    return res.json(payload);
  } catch (err) {
    console.error("[LeadInsights] failed:", err.message);
    return res
      .status(500)
      .json({ message: "Impossible de charger les indicateurs des leads." });
  }
});

// PUT /api/lead-insights/frein  { platform, customerId, conversationId, code, note }
router.put("/frein", protect, async (req, res) => {
  try {
    const body = req.body || {};
    const platform = checkPlatform(body.platform);
    if (!platform) {
      return res.status(400).json({ message: "Plateforme invalide." });
    }
    if (!isValidFreinCode(body.code)) {
      return res.status(400).json({ message: "Motif / frein invalide." });
    }
    if (
      body.note !== undefined &&
      body.note !== null &&
      typeof body.note !== "string"
    ) {
      return res.status(400).json({ message: "Note invalide." });
    }

    const own = ownIds();
    const conversationId = cleanId(body.conversationId);
    let customerId = cleanId(body.customerId);

    if (!customerId || isThreadId(platform, customerId)) {
      const given = customerId || conversationId;
      if (given) {
        const resolved = await resolveRecipientId(
          platform,
          given,
          conversationId || undefined,
        );
        customerId =
          resolved && typeof resolved.id === "string" ? resolved.id : null;
      } else {
        customerId = null;
      }
    }
    if (!customerId || isThreadId(platform, customerId) || own.has(customerId)) {
      return res
        .status(400)
        .json({ message: "Client introuvable pour cette conversation." });
    }

    const frein = await setFrein({
      platform,
      customerId,
      code: body.code,
      note: typeof body.note === "string" ? body.note : "",
      userId: req.user._id,
    });

    clearInsightsCache();
    clearLeadsCacheSafely();

    return res.json({
      frein: {
        code: frein.code,
        label: freinLabel(frein),
        note: frein.note,
        setAt: frein.setAt,
        setByName: userName(req.user),
      },
    });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ message: err.message });
    }
    console.error("[LeadInsights] frein save failed:", err.message);
    return res
      .status(500)
      .json({ message: "Impossible d'enregistrer le motif / frein." });
  }
});

module.exports = router;
module.exports.clearInsightsCache = clearInsightsCache;
