/**
 * leadInsights.js — per-conversation lead indicators for the inbox views.
 *
 *   POST /api/lead-insights        counts, maturity and frein for a list page
 *   PUT  /api/lead-insights/frein  record the main need or obstacle
 *
 * Nothing here is stored except the frein (Contact.customFields, see
 * utils/leadFrein.js). Message counts, the maturity level and the
 * "needs qualification" flag are computed from Message and Classification
 * rows at read time; the data models are frozen.
 *
 * Ids: a conversation has no single stable id (CLAUDE.md §6). The client
 * sends each list row as { key: conv.id, customerId: first participant },
 * and everything is keyed by the CUSTOMER, the only id both list shapes
 * share. `keyToCustomer` in the response lets the client look a row up by
 * its conversation key when its participant id was missing.
 */

"use strict";

const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const Message = require("../models/Message");
const Classification = require("../models/Classification");
const { protect } = require("../middleware/auth");
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

/** Sender names the Graph sync used for the Page's own messages. */
const OWN_SENDER_NAMES = ["Page", "You"];

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

function toTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
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
 * Map each list row to its customer.
 * @returns {Promise<{ customers: string[], keyToCustomer: Map<string,string> }>}
 */
async function resolveCustomers(platform, items, own) {
  const customers = new Set();
  const keyToCustomer = new Map();
  const pendingKeys = new Set();

  const usable = (id) => id && !isThreadId(platform, id) && !own.has(id);

  for (const { key, customerId } of items) {
    let customer = null;
    if (usable(customerId)) customer = customerId;
    else if (usable(key)) customer = key;

    if (customer) {
      customers.add(customer);
      if (key) keyToCustomer.set(key, customer);
    } else if (key) {
      pendingKeys.add(key);
    }
  }

  // Thread-keyed rows with no participant: the customer is the sender of the
  // newest inbound message stored under that thread.
  if (pendingKeys.size > 0) {
    const senderFilter = { $nin: [...own] };
    if (platform !== "email") senderFilter.$not = /^t_/;
    const rows = await Message.aggregate([
      {
        $match: {
          platform,
          direction: "incoming",
          conversationId: { $in: [...pendingKeys] },
          senderId: senderFilter,
          senderName: { $nin: OWN_SENDER_NAMES },
        },
      },
      { $sort: { timestamp: -1 } },
      { $group: { _id: "$conversationId", senderId: { $first: "$senderId" } } },
    ]);
    for (const row of rows) {
      const customer =
        typeof row.senderId === "string" ? row.senderId.trim() : "";
      if (!usable(customer) || customer.startsWith("$")) continue;
      customers.add(customer);
      keyToCustomer.set(row._id, customer);
    }
  }

  return { customers: [...customers], keyToCustomer };
}

/** Build the full response for one platform and a list of rows. */
async function computeInsights(platform, items) {
  const own = ownIds();
  const ownList = [...own];
  const { customers, keyToCustomer } = await resolveCustomers(
    platform,
    items,
    own,
  );

  const insights = Object.create(null);
  const keyMap = Object.create(null);
  for (const [key, customer] of keyToCustomer) keyMap[key] = customer;
  if (customers.length === 0) {
    return { insights, keyToCustomer: keyMap, thresholds: THRESHOLDS };
  }

  const customerSet = new Set(customers);
  const keys = [...keyToCustomer.keys()];
  // Graph threads found through the customer's own messages (second pass
  // below): thread id -> { customer, last }
  const threadOwner = new Map();
  // A conversation id that IS a customer id belongs to that customer; any
  // other resolved key or found thread belongs to its customer.
  const customerOfConv = (conversationId) => {
    if (typeof conversationId !== "string") return null;
    if (customerSet.has(conversationId)) return conversationId;
    const owner = threadOwner.get(conversationId);
    return keyToCustomer.get(conversationId) || (owner && owner.customer) || null;
  };
  const convIds = [...new Set([...keys, ...customers])];

  // An "incoming" row sent by us is a Graph-sync mislabel (instagram.js heals
  // these lazily); it is our reply, not the prospect's message.
  const isIncoming = {
    $and: [
      { $eq: ["$direction", "incoming"] },
      { $not: [{ $in: ["$senderId", { $literal: ownList }] }] },
      { $not: [{ $in: ["$senderName", { $literal: OWN_SENDER_NAMES }] }] },
    ],
  };

  // One group per (direction, sender or recipient, conversation)
  const countStages = [
    {
      $project: {
        _id: 0,
        i: isIncoming,
        senderId: 1,
        recipientId: 1,
        conversationId: 1,
        at: { $ifNull: ["$timestamp", "$createdAt"] },
      },
    },
    {
      $group: {
        _id: {
          i: "$i",
          s: { $cond: ["$i", "$senderId", null] },
          r: { $cond: ["$i", null, "$recipientId"] },
          c: "$conversationId",
        },
        n: { $sum: 1 },
        last: { $max: "$at" },
      },
    },
  ];
  // The customer's own messages, anywhere
  const fromCustomers = {
    platform,
    direction: "incoming",
    senderId: { $in: customers },
  };

  // Both $or branches are backed by an index ({platform, senderId} and
  // {platform, conversationId}). Replies are matched through their
  // conversation, never through recipientId: Message has no recipientId
  // index (and none may be added), so such a clause would scan every
  // message of the platform on each request.
  const [groups, classRows, freins] = await Promise.all([
    Message.aggregate([
      {
        $match: {
          platform,
          status: { $ne: "failed" },
          $or: [fromCustomers, { platform, conversationId: { $in: convIds } }],
        },
      },
      ...countStages,
    ]),
    Classification.find({ platform, conversationId: { $in: convIds } })
      .select("conversationId classification appointmentAt updatedAt")
      .lean(),
    getFreins(platform, customers),
  ]);

  // Graph-synced history, and CRM replies sent while the list was built from
  // Graph, are stored under the t_… thread id. When this list is keyed by
  // customer ids (the DB-built list), those threads are found through the
  // customer's own messages under them, and their remaining rows (our
  // replies) are read in a second, index-backed pass. The first pass already
  // counted the customer's own messages there, hence the $nor.
  const listed = new Set(convIds);
  for (const g of groups) {
    const { i: incoming, s: senderId, c: conversationId } = g._id || {};
    if (
      !incoming ||
      !customerSet.has(senderId) ||
      listed.has(conversationId) ||
      !isThreadId(platform, conversationId)
    ) {
      continue;
    }
    const last = toTime(g.last);
    const current = threadOwner.get(conversationId);
    if (!current || last > current.last) {
      threadOwner.set(conversationId, { customer: senderId, last });
    }
  }
  if (threadOwner.size > 0) {
    const threadGroups = await Message.aggregate([
      {
        $match: {
          platform,
          status: { $ne: "failed" },
          conversationId: { $in: [...threadOwner.keys()] },
          $nor: [fromCustomers],
        },
      },
      ...countStages,
    ]);
    groups.push(...threadGroups);
  }

  const stats = new Map(); // customer -> counters
  for (const customer of customers) {
    stats.set(customer, {
      messagesIn: 0,
      messagesOut: 0,
      lastIncomingAt: null,
      lastOutgoingAt: null,
    });
  }

  for (const g of groups) {
    const { i: incoming, s: senderId, r: recipientId, c: conversationId } =
      g._id || {};
    const direct = incoming ? senderId : recipientId;
    const customer = customerSet.has(direct)
      ? direct
      : customerOfConv(conversationId);
    const st = customer && stats.get(customer);
    if (!st) continue;
    const last = g.last ? new Date(g.last) : null;
    const count = Number(g.n) || 0;
    if (incoming) {
      st.messagesIn += count;
      if (last && (!st.lastIncomingAt || last > st.lastIncomingAt)) {
        st.lastIncomingAt = last;
      }
    } else {
      st.messagesOut += count;
      if (last && (!st.lastOutgoingAt || last > st.lastOutgoingAt)) {
        st.lastOutgoingAt = last;
      }
    }
  }

  const classOf = new Map(); // customer -> newest Classification row
  for (const row of classRows) {
    const customer = customerOfConv(row.conversationId);
    if (!customer) continue;
    const current = classOf.get(customer);
    if (!current || toTime(row.updatedAt) > toTime(current.updatedAt)) {
      classOf.set(customer, row);
    }
  }

  const now = new Date();
  for (const customer of customers) {
    const st = stats.get(customer);
    const cls = classOf.get(customer);
    const frein = freins.get(customer) || null;
    insights[customer] = {
      messagesIn: st.messagesIn,
      messagesOut: st.messagesOut,
      lastIncomingAt: st.lastIncomingAt,
      lastOutgoingAt: st.lastOutgoingAt,
      maturity: computeMaturity({
        messagesIn: st.messagesIn,
        messagesOut: st.messagesOut,
        lastIncomingAt: st.lastIncomingAt,
        lastOutgoingAt: st.lastOutgoingAt,
        classification: cls ? cls.classification : null,
        appointmentAt: cls ? cls.appointmentAt : null,
        frein,
        now,
      }),
      frein: publicFrein(frein),
      needsQualification: st.messagesOut >= 1 && !frein,
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
    // different conversation keys can match different message rows.
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
