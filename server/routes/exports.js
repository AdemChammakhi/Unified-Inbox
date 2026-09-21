/**
 * exports.js — the prospect sheet, generated instead of maintained by hand.
 *
 * The team tracks prospects in a color-coded spreadsheet: source, name,
 * phone, first contact, process stage, commercial in charge, comments
 * (ticket N°7995). This endpoint assembles that exact table from what the
 * inbox already knows — messages and who sent each reply, classifications,
 * RDV dates, agent locks, ad attribution — and serves it as styled Excel or
 * French-locale CSV. Sends the platform refused (status "failed") are ignored.
 *
 * Two columns are derived, never stored: "Maturité" (Chaud / Tiède / Froid,
 * from utils/leadMaturity) and "Motif / frein" (the obstacle the agent
 * recorded, read from Contact.customFields through utils/leadFrein).
 *
 * One row per PROSPECT (the person), not per conversation document: webhook
 * rows are keyed by the sender's numeric ID while Graph-synced rows use the
 * t_… thread id, so grouping happens on the person (incoming senderId /
 * outgoing recipientId) and classification/lock lookups accept ANY of the
 * person's conversation keys.
 *
 * Admin + manager only — this is the whole prospect base in one file.
 */

"use strict";

const express = require("express");
const router = express.Router();
const ExcelJS = require("exceljs");
const Message = require("../models/Message");
const Classification = require("../models/Classification");
const ConversationLock = require("../models/ConversationLock");
const User = require("../models/User");
const { protect, authorize } = require("../middleware/auth");
const { sanitizePlatform } = require("../utils/sanitize");
const { computeMaturity } = require("../utils/leadMaturity");
const { freinLabel, getFreins } = require("../utils/leadFrein");

const PLATFORM_LABELS = {
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  email: "Email",
  messenger: "Messenger",
  tiktok: "TikTok",
};

// Pipeline stages and typologies: labels from the shared constants
const {
  STAGE_LABEL,
  DEFAULT_STAGE,
  TYPOLOGY_LABEL,
} = require("../constants/pipeline");

// Same colors the app uses (client/src/constants/pipeline.js), as ARGB fills.
// "Nouveau lead" keeps the plain cell.
const STAGE_FILLS = {
  a_contacter: "FFE3A63C",
  contact_etabli: "FF5B9BD9",
  qualifie: "FF5FBF8A",
  offre_envoyee: "FF4EC3C3",
  en_reflexion: "FFA98BD6",
  relance: "FFD98CB3",
  reservation: "FF3FA37A",
  paiement: "FF2E8B57",
  dossier_confirme: "FF1F7A4F",
  depart: "FF16633F",
  perdu: "FFE2685F",
};

// Pale fills for the "Maturité" cell, read with the default dark text
const MATURITY_FILLS = {
  chaud: "FFF8D7D3",
  tiede: "FFFBEBC8",
  froid: "FFD6E6F5",
};

/** Shown when neither a lock nor a CRM reply names anyone. */
const UNASSIGNED = "Non attribué";

/** IDs that are US, not prospects (same list as routes/leadInsights.js). */
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

const fmtDate = (d) => {
  if (!d) return "";
  // toLocaleString does NOT throw on an unparseable value — it returns the
  // literal "Invalid Date", which would be written into a cell. Check first.
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleString("fr-FR", {
      timeZone: "Africa/Tunis",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
};

// Webhooks name unknown senders `User ${senderId.slice(-4)}` — the last four
// characters are not necessarily digits ("User 12ab"), so match on length.
const isPlaceholderName = (name) =>
  !name || name === "Unknown" || /^User .{1,4}$/.test(name) || /^\d{6,}$/.test(name);

/**
 * Graph thread ids (t_…) are conversations, never people. Email has no
 * threads, and an address may legitimately start with "t_" (same rule as
 * routes/leadInsights.js, so both views treat such a prospect alike).
 */
const looksLikeThreadId = (platform, id) =>
  platform !== "email" && typeof id === "string" && /^t_/.test(id);

/** A send the platform refused. It was never delivered, so it is not a reply. */
const isFailedOutgoing = (m) => m.direction !== "incoming" && m.status === "failed";

/** A stored User reference, as the 24-hex string a User query can cast. */
const userIdOf = (value) => {
  if (!value) return null;
  const id = String(value);
  return /^[a-f0-9]{24}$/i.test(id) ? id : null;
};

/**
 * True when the row carries media. The scan projects this as `hasMedia`
 * (see buildProspectRows); the array/URL checks cover a full document.
 */
const hasAttachment = (m) =>
  m.hasMedia === true ||
  (Array.isArray(m.attachments) && m.attachments.length > 0) ||
  Boolean(m.attachmentUrl);

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair. */
const cutText = (s, max) => {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
};

/** A readable fallback label when we never learned the prospect's name. */
function fallbackName(platform, personId) {
  const id = String(personId || "");
  if (platform === "email" && id.includes("@")) {
    return id.split("@")[0]; // "jean.dupont", not "Prospect .com"
  }
  return `Prospect ${id.slice(-4)}`;
}

/**
 * Build the prospect rows for a platform filter + date range.
 * @returns {Promise<Array<object>>} sorted by last contact, newest first
 */
async function buildProspectRows({ platform, since }) {
  const matchPlatform = platform
    ? { platform }
    : { platform: { $in: ["instagram", "facebook", "whatsapp", "email"] } };

  // NEWEST first, then capped: if the range holds more messages than the cap,
  // we must keep the RECENT ones. Sorting ascending here would hand back the
  // oldest slice and silently drop every current prospect from the sheet —
  // the opposite of what the team needs. Trade-off: for a prospect whose
  // thread predates the cap, "premier contact" shows the oldest message we
  // still hold, not the true first.
  const MESSAGE_CAP = 20000;
  // Only a short preview of the text is ever shown ("Dernier message" is cut
  // to 160 characters) and only WHETHER media exists — never the media. Both
  // are trimmed inside the database: loading every body in full made a
  // full-history build pull the whole collection's text into a 512 MB /
  // half-a-core container, where it ran for minutes and the browser gave up
  // (Nginx 499). The type guards keep a malformed legacy row from failing
  // the whole build.
  const PREVIEW_CHARS = 200;
  const isString = (field) => ({ $eq: [{ $type: field }, "string"] });
  const messages = await Message.aggregate([
    {
      $match: {
        ...matchPlatform,
        ...(since ? { timestamp: { $gte: since } } : {}),
      },
    },
    { $sort: { timestamp: -1 } },
    { $limit: MESSAGE_CAP },
    {
      $project: {
        platform: 1,
        conversationId: 1,
        senderId: 1,
        recipientId: 1,
        senderName: 1,
        direction: 1,
        status: 1,
        sentBy: 1,
        timestamp: 1,
        createdAt: 1,
        "context.title": 1,
        content: {
          $cond: [
            isString("$content"),
            { $substrCP: ["$content", 0, PREVIEW_CHARS] },
            "",
          ],
        },
        hasMedia: {
          $or: [
            {
              $and: [
                { $isArray: "$attachments" },
                { $gt: [{ $size: "$attachments" }, 0] },
              ],
            },
            {
              $and: [
                isString("$attachmentUrl"),
                { $ne: ["$attachmentUrl", ""] },
              ],
            },
          ],
        },
      },
    },
  ]).option({ maxTimeMS: 120000 });
  const truncated = messages.length === MESSAGE_CAP;
  if (truncated) {
    console.warn(
      `[Export] hit the ${MESSAGE_CAP}-message cap — "premier contact" and message counts are partial for old threads`,
    );
  }

  const own = ownIds();
  const ownList = [...own];

  // An "incoming" row sent by us is a Graph-sync mislabel (instagram.js heals
  // these lazily): it is our reply, and it is counted as one here exactly as
  // the inbox thread view and /api/lead-insights count it, so "Messages
  // reçus / envoyés" agree with the inbox.
  const isFromProspect = (m) =>
    m.direction === "incoming" &&
    !own.has(m.senderId) &&
    !OWN_SENDER_NAMES.includes(m.senderName);

  // Pass 1 — learn which PERSON each conversation key belongs to, from
  // inbound messages (whose senderId is always the real customer).
  // This is what lets us repair outbound rows: when the inbox had no
  // resolvable participant (Instagram under Standard Access returns an
  // empty participant list), the client sends the THREAD id as recipientId,
  // so the reply is stored against `t_…` instead of the customer. Without
  // this map that reply becomes a second, phantom prospect row.
  const convToPerson = new Map(); // "<platform>:<convId>" -> personId
  for (const m of messages) {
    if (!isFromProspect(m)) continue;
    if (!m.senderId || looksLikeThreadId(m.platform, m.senderId)) continue;
    if (m.conversationId) {
      convToPerson.set(`${m.platform}:${m.conversationId}`, m.senderId);
    }
    convToPerson.set(`${m.platform}:${m.senderId}`, m.senderId);
  }

  const personOf = (m) => {
    if (isFromProspect(m)) return m.senderId;
    // Outbound: recipientId may be a thread id — remap it to the person
    return (
      convToPerson.get(`${m.platform}:${m.recipientId}`) ||
      convToPerson.get(`${m.platform}:${m.conversationId}`) ||
      m.recipientId
    );
  };

  const prospects = new Map(); // "<platform>:<personId>" -> row accumulator

  for (const m of messages) {
    // A refused send was never delivered: it must not count as a reply, move
    // "Dernier contact", fill "Dernier message" or name an agent. Skipped
    // before the group is even created, so a failed attempt alone does not
    // make a prospect row.
    if (isFailedOutgoing(m)) continue;

    const personId = personOf(m);
    if (!personId || own.has(personId)) continue;

    const key = `${m.platform}:${personId}`;
    let p = prospects.get(key);
    if (!p) {
      p = {
        platform: m.platform,
        personId,
        name: "",
        nameAt: null, // keep the most RECENT non-placeholder name
        firstContact: null,
        lastContact: null,
        messagesIn: 0,
        messagesOut: 0,
        lastIncomingAt: null, // newest message FROM the prospect (maturity)
        lastOutgoingAt: null, // newest delivered reply TO the prospect
        // Full-history counterparts for maturity, filled by the widening pass
        // below; null means "not known", and the period figures stand in.
        allIn: null,
        allOut: null,
        allLastIncomingAt: null,
        allLastOutgoingAt: null,
        lastMessage: "",
        lastMessageAt: null,
        replierId: null, // sentBy of the newest CRM reply
        replierAt: null,
        adTitle: "",
        adTitleAt: null,
        convIds: new Set([personId]),
      };
      prospects.set(key, p);
    }

    const when = m.timestamp || m.createdAt;
    if (!p.firstContact || when < p.firstContact) p.firstContact = when;
    if (!p.lastContact || when > p.lastContact) p.lastContact = when;
    if (m.conversationId) p.convIds.add(m.conversationId);

    // These "latest wins" fields compare timestamps explicitly rather than
    // relying on scan order — the query sorts newest-first, and a plain
    // last-assignment-wins would record the OLDEST value.
    const incoming = isFromProspect(m);

    // "Dernier message": the newest row from EITHER side that has something
    // to show. A media-only row reads as "[pièce jointe]"; a row with neither
    // text nor media (a bare reaction, an unsupported type) is passed over.
    const text = typeof m.content === "string" ? m.content.trim() : "";
    const body = text || (hasAttachment(m) ? "[pièce jointe]" : "");
    if (body && (!p.lastMessageAt || when > p.lastMessageAt)) {
      p.lastMessage = `${incoming ? "Prospect" : "Commercial"} : ${body}`;
      p.lastMessageAt = when;
    }

    if (incoming) {
      p.messagesIn++;
      if (when && (!p.lastIncomingAt || when > p.lastIncomingAt)) {
        p.lastIncomingAt = when;
      }
      if (!isPlaceholderName(m.senderName) && (!p.nameAt || when > p.nameAt)) {
        p.name = m.senderName;
        p.nameAt = when;
      }
      // Attribution: keep the EARLIEST ad — the one that opened the thread
      if (m.context?.title && (!p.adTitleAt || when < p.adTitleAt)) {
        p.adTitle = m.context.title;
        p.adTitleAt = when;
      }
    } else {
      p.messagesOut++;
      if (when && (!p.lastOutgoingAt || when > p.lastOutgoingAt)) {
        p.lastOutgoingAt = when;
      }
      // The agent who actually answered. Only CRM sends carry sentBy; replies
      // stored from Meta's echoes (Business Suite, the apps) have none, so the
      // newest reply that DOES name a user wins. Strict ">" keeps the first
      // row seen on a tie, which is the newest under this query's sort.
      const replierId = userIdOf(m.sentBy);
      if (replierId && (!p.replierAt || when > p.replierAt)) {
        p.replierId = replierId;
        p.replierAt = when;
      }
    }
  }

  // Drop outbound-only groups still keyed by a thread id: those are the
  // unrepairable half of the case above (a reply with no inbound message in
  // range to link it to a person). Better absent than a phantom prospect.
  for (const [key, p] of prospects) {
    if (p.messagesIn === 0 && looksLikeThreadId(p.platform, p.personId)) {
      prospects.delete(key);
    }
  }

  if (prospects.size === 0) return [];

  // The UI stores a classification under whichever key the conversation was
  // listed as — the thread id for Graph-listed threads, the sender id for
  // DB-merged ones. A person's keys seen INSIDE the window are not
  // necessarily all of them, so widen the search with an unbounded lookup of
  // every conversation key these people have ever used. Without this, a
  // ranged export shows "Non classifié" for a prospect the inbox shows as
  // Cible, purely because the classified thread's messages fell out of range.
  //
  // The same pass collects each person's FULL-history activity for the
  // maturity rules. Maturity describes the lead, not the chosen period, and
  // the inbox computes it over all history — a 7-day sheet must not call a
  // lead "Froid, informations insuffisantes" that the inbox shows as "Tiède".
  // The "Messages reçus/envoyés" columns stay period-bounded.
  //
  // It also finds each person's newest delivered CRM reply over ALL history,
  // so "Commercial en charge" still names the last agent who answered when
  // that reply is older than the chosen period (and no lock names anyone).
  const personIds = [...prospects.values()].map((p) => p.personId);
  const whenOf = { $ifNull: ["$timestamp", "$createdAt"] };
  // Same test as isFromProspect above, in aggregation form
  const isIncoming = {
    $and: [
      { $eq: ["$direction", "incoming"] },
      { $not: [{ $in: ["$senderId", { $literal: ownList }] }] },
      { $not: [{ $in: ["$senderName", { $literal: OWN_SENDER_NAMES }] }] },
    ],
  };
  const isDeliveredReply = {
    $and: [{ $not: [isIncoming] }, { $ne: ["$status", "failed"] }],
  };
  const isCrmReply = {
    $and: [isDeliveredReply, { $eq: [{ $type: "$sentBy" }, "objectId"] }],
  };
  try {
    const keyDocs = await Message.aggregate([
      {
        $match: {
          ...matchPlatform,
          $or: [
            { senderId: { $in: personIds } },
            { recipientId: { $in: personIds } },
          ],
        },
      },
      {
        $group: {
          _id: {
            platform: "$platform",
            person: { $cond: [isIncoming, "$senderId", "$recipientId"] },
          },
          convIds: { $addToSet: "$conversationId" },
          // $max skips nulls, so non-matching rows do not move the dates
          allIn: { $sum: { $cond: [isIncoming, 1, 0] } },
          allOut: { $sum: { $cond: [isDeliveredReply, 1, 0] } },
          allLastIncomingAt: { $max: { $cond: [isIncoming, whenOf, null] } },
          allLastOutgoingAt: {
            $max: { $cond: [isDeliveredReply, whenOf, null] },
          },
          // Documents compare field by field, so the newest `at` wins
          // (works on every MongoDB version, unlike $top)
          lastReply: {
            $max: {
              $cond: [isCrmReply, { at: whenOf, by: "$sentBy" }, null],
            },
          },
        },
      },
    ]).option({ maxTimeMS: 15000 });
    const later = (a, b) => {
      if (!a) return b || null;
      if (!b) return a;
      return new Date(b) > new Date(a) ? b : a;
    };
    for (const d of keyDocs) {
      const p = prospects.get(`${d._id.platform}:${d._id.person}`);
      if (!p) continue;
      for (const id of d.convIds || []) if (id) p.convIds.add(id);
      // Merged, never replaced: in-range replies stored under a thread id
      // were attributed above but are not matched by this person query.
      p.allIn = Math.max(p.allIn ?? p.messagesIn, d.allIn || 0);
      p.allOut = Math.max(p.allOut ?? p.messagesOut, d.allOut || 0);
      p.allLastIncomingAt = later(
        p.allLastIncomingAt ?? p.lastIncomingAt,
        d.allLastIncomingAt,
      );
      p.allLastOutgoingAt = later(
        p.allLastOutgoingAt ?? p.lastOutgoingAt,
        d.allLastOutgoingAt,
      );
      // Newest CRM reply across all history; the period's own replier is
      // kept on a tie or when this one is older (replies stored under a
      // thread id are not matched by this person query).
      const replyBy = userIdOf(d.lastReply?.by);
      const replyAt = d.lastReply?.at ? new Date(d.lastReply.at) : null;
      if (
        replyBy &&
        replyAt &&
        !Number.isNaN(replyAt.getTime()) &&
        (!p.replierAt || replyAt > new Date(p.replierAt))
      ) {
        p.replierId = replyBy;
        p.replierAt = replyAt;
      }
    }
  } catch (err) {
    console.warn(
      "[Export] conversation-key widening skipped (non-fatal):",
      err.message,
    );
  }

  // Classification + lock, matched against ANY of the person's keys
  const allConvIds = [
    ...new Set([...prospects.values()].flatMap((p) => [...p.convIds])),
  ];
  // Every replier in the sheet, resolved in ONE query rather than per row
  const replierIds = [
    ...new Set(
      [...prospects.values()].map((p) => p.replierId).filter(Boolean),
    ),
  ];
  // The recorded frein, keyed by the customer id: ONE lookup per platform
  // present in the sheet. Non-fatal — a sheet without the "Motif / frein"
  // column filled beats no sheet at all.
  const personsByPlatform = new Map(); // platform -> [personId]
  for (const p of prospects.values()) {
    if (looksLikeThreadId(p.platform, p.personId)) continue;
    if (!personsByPlatform.has(p.platform)) personsByPlatform.set(p.platform, []);
    personsByPlatform.get(p.platform).push(String(p.personId));
  }
  const loadFreins = async () => {
    const byPerson = new Map(); // "<platform>:<personId>" -> frein
    await Promise.all(
      [...personsByPlatform].map(async ([plat, ids]) => {
        try {
          const found = await getFreins(plat, ids);
          for (const [id, frein] of found) byPerson.set(`${plat}:${id}`, frein);
        } catch (err) {
          console.warn(
            `[Export] frein lookup skipped for ${plat} (non-fatal):`,
            err.message,
          );
        }
      }),
    );
    return byPerson;
  };

  const [classifications, locks, repliers, freins] = await Promise.all([
    Classification.find({ conversationId: { $in: allConvIds } })
      .select(
        "conversationId platform stage typologie invoiceRef isPriority appointmentAt updatedAt",
      )
      .lean(),
    ConversationLock.find({ conversationId: { $in: allConvIds } })
      .populate("lockedBy", "firstName lastName")
      .lean(),
    replierIds.length > 0
      ? User.find({ _id: { $in: replierIds } })
          .select("firstName lastName")
          .lean()
      : [],
    loadFreins(),
  ]);
  const classByConv = new Map(
    classifications.map((c) => [`${c.platform}:${c.conversationId}`, c]),
  );
  const lockByConv = new Map(
    locks.map((l) => [`${l.platform}:${l.conversationId}`, l]),
  );
  const fullName = (u) =>
    u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() : "";
  const replierName = new Map(repliers.map((u) => [String(u._id), fullName(u)]));

  /** Newest wins: a person may carry a stale doc under an abandoned key. */
  const newestOf = (map, p, stamp) => {
    let best = null;
    for (const id of p.convIds) {
      const hit = map.get(`${p.platform}:${id}`);
      if (!hit) continue;
      if (!best || new Date(hit[stamp] || 0) > new Date(best[stamp] || 0)) {
        best = hit;
      }
    }
    return best;
  };

  // One clock for the whole sheet, so every row is judged at the same instant
  const now = new Date();

  const rows = [...prospects.values()].map((p) => {
    const cls = newestOf(classByConv, p, "updatedAt");
    const lock = newestOf(lockByConv, p, "lockedAt");
    const classification = cls?.stage || DEFAULT_STAGE;
    const typologie = cls?.typologie || "";
    const invoiceRef = cls?.invoiceRef || "";
    const isPriority = cls?.isPriority === true;
    // The RDV date is independent of the stage
    const rdvAt = cls?.appointmentAt || null;
    // "Commercial en charge": the agent CURRENTLY holding the lead — the
    // newest lock across the person's keys. A lock whose user was deleted
    // populates to null and does not count. Without a lock, whoever sent the
    // newest delivered CRM reply stands in; with neither, nobody is named.
    const agent =
      fullName(lock?.lockedBy) ||
      (p.replierId && replierName.get(p.replierId)) ||
      UNASSIGNED;

    const frein = freins.get(`${p.platform}:${p.personId}`) || null;
    // Full-history activity when the widening pass supplied it, else the
    // period's own figures
    const maturity = computeMaturity({
      messagesIn: p.allIn ?? p.messagesIn,
      messagesOut: p.allOut ?? p.messagesOut,
      lastIncomingAt: p.allLastIncomingAt ?? p.lastIncomingAt,
      lastOutgoingAt: p.allLastOutgoingAt ?? p.lastOutgoingAt,
      stage: classification,
      isPriority,
      appointmentAt: rdvAt,
      frein,
      now,
    });

    return {
      platform: p.platform,
      source: p.adTitle
        ? `${PLATFORM_LABELS[p.platform] || p.platform} — Pub: ${p.adTitle}`
        : PLATFORM_LABELS[p.platform] || p.platform,
      name: p.name || fallbackName(p.platform, p.personId),
      phone: p.platform === "whatsapp" ? `+${p.personId}` : "",
      email: p.platform === "email" ? p.personId : "",
      firstContact: p.firstContact,
      lastContact: p.lastContact,
      classification,
      classificationLabel: STAGE_LABEL[classification] || classification,
      typologie,
      typologieLabel: TYPOLOGY_LABEL[typologie] || "",
      invoiceRef,
      isPriority,
      maturity: maturity.label,
      maturityLevel: maturity.level,
      maturityReason: maturity.reason,
      frein: freinLabel(frein),
      freinCode: frein?.code || "",
      rdvAt,
      agent,
      messagesIn: p.messagesIn,
      messagesOut: p.messagesOut,
      lastMessage: cutText(p.lastMessage || "", 160),
    };
  });

  rows.sort((a, b) => new Date(b.lastContact) - new Date(a.lastContact));
  // Surfaced to the caller so the file itself can say so — a silently
  // truncated "Premier contact" is indistinguishable from a real one.
  rows.truncated = truncated;
  return rows;
}

const HEADERS = [
  "Plateforme",
  "Source",
  "Nom prospect",
  "Téléphone",
  "Email",
  "Premier contact",
  "Dernier contact",
  "Étape",
  "Typologie",
  "Prioritaire",
  "Maturité",
  "Motif / frein",
  "RDV le",
  "Réf. facture",
  "Commercial en charge",
  "Messages reçus",
  "Messages envoyés",
  "Dernier message",
];

// Column widths, in HEADERS order — keep the two arrays the same length
const COLUMN_WIDTHS = [11, 34, 24, 15, 26, 17, 17, 17, 18, 11, 10, 28, 17, 16, 20, 9, 9, 46];

// 1-based XLSX column numbers, derived so an inserted column cannot shift them
const CLASS_COL = HEADERS.indexOf("Étape") + 1;
const MATURITY_COL = HEADERS.indexOf("Maturité") + 1;

function rowValues(r) {
  return [
    PLATFORM_LABELS[r.platform] || r.platform,
    r.source,
    r.name,
    r.phone,
    r.email,
    fmtDate(r.firstContact),
    fmtDate(r.lastContact),
    r.classificationLabel,
    r.typologieLabel || "",
    r.isPriority ? "Oui" : "",
    r.maturity || "",
    r.frein || "",
    fmtDate(r.rdvAt),
    r.invoiceRef || "",
    r.agent,
    r.messagesIn,
    r.messagesOut,
    r.lastMessage,
  ];
}

/**
 * CSV for French Excel: UTF-8 BOM + semicolon separator.
 *
 * Cell values are neutralised against formula injection first. Prospect
 * names and message bodies are attacker-controlled — a customer can set
 * their Facebook name to `=cmd|'/c calc'!A0` or send it as a message — and
 * Excel executes a cell that starts with = + - @ (or a leading tab / CR).
 * The sheet is opened by our own staff, so this is a direct attack on them.
 * Prefixing with an apostrophe makes Excel treat the value as literal text.
 * (The .xlsx path needs no equivalent: ExcelJS writes these as typed string
 * cells, which Excel never evaluates.)
 */
function csvSafe(value) {
  const s = String(value ?? "");
  if (!s) return s;
  // Spreadsheets strip leading blanks BEFORE deciding a cell is a formula, so
  // " =1+1" executes just like "=1+1". Probe the value with every kind of
  // leading blank removed — \s already covers NBSP/vertical-tab/BOM, and the
  // zero-width family is added explicitly since \s does not match it.
  const probe = s.replace(/^[\s​-‍⁠]+/, "");
  return /^[=+\-@]/.test(probe) || /^[\t\r]/.test(s) ? `'${s}` : s;
}

function toCsv(rows) {
  const esc = (v) => {
    const s = csvSafe(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [HEADERS.map(esc).join(";")];
  for (const r of rows) lines.push(rowValues(r).map(esc).join(";"));
  if (rows.truncated) {
    lines.push(
      esc(
        "⚠ Export tronqué : limite de messages atteinte. « Premier contact » et les compteurs sont partiels pour les anciens échanges.",
      ),
    );
  }
  return "﻿" + lines.join("\r\n");
}

async function toXlsx(rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Medtour CRM";
  const ws = wb.addWorksheet("Prospects", {
    views: [{ state: "frozen", ySplit: 2 }],
  });

  // Title band
  ws.mergeCells(1, 1, 1, HEADERS.length);
  const title = ws.getCell(1, 1);
  title.value =
    `Prospects Medtour CRM — ${meta.platformLabel} — ${meta.rangeLabel} — exporté le ${fmtDate(new Date())}` +
    (rows.truncated
      ? "   ⚠ EXPORT TRONQUÉ : « Premier contact » et les compteurs sont partiels pour les anciens échanges."
      : "");
  title.font = {
    bold: true,
    size: 12,
    color: { argb: rows.truncated ? "FFE3A63C" : "FFE8833A" },
  };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B111E" } };
  title.alignment = { vertical: "middle" };
  ws.getRow(1).height = 22;

  // Header row
  const headerRow = ws.getRow(2);
  headerRow.values = HEADERS;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF131B2C" } };
    cell.alignment = { vertical: "middle" };
    cell.border = { bottom: { style: "medium", color: { argb: "FFE8833A" } } };
  });
  headerRow.height = 18;

  for (const r of rows) {
    const row = ws.addRow(rowValues(r));
    const fill = STAGE_FILLS[r.classification];
    if (fill) {
      const cell = row.getCell(CLASS_COL);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    }
    const maturityFill = MATURITY_FILLS[r.maturityLevel];
    if (maturityFill) {
      const cell = row.getCell(MATURITY_COL);
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: maturityFill },
      };
      cell.font = { bold: true, color: { argb: "FF1F2937" } };
    }
  }

  COLUMN_WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: HEADERS.length } };

  return wb.xlsx.writeBuffer();
}

// Single-flight guard. The rate limiter caps how OFTEN exports are asked for,
// not how many run AT ONCE — and concurrency is what actually kills us: each
// generation holds thousands of documents plus a whole workbook in a 512MB
// container. Ten simultaneous requests OOM the backend, and restart:
// unless-stopped turns that into a repeatable outage. One at a time.
let _exportInFlight = false;

// GET /api/exports/prospects?format=xlsx|csv&platform=all|<platform>&range=<days|all>
router.get(
  "/prospects",
  protect,
  authorize("admin", "manager"),
  async (req, res) => {
    try {
      const format = req.query.format === "csv" ? "csv" : "xlsx";
      const platform =
        req.query.platform && req.query.platform !== "all"
          ? sanitizePlatform(req.query.platform)
          : null;
      if (req.query.platform && req.query.platform !== "all" && !platform) {
        return res.status(400).json({ message: "Plateforme invalide" });
      }
      // Must be a plain string: Express's extended parser turns ?range[$gt]=1
      // into an object, whose parseInt is NaN — which would silently fall
      // through to a FULL-history export instead of the bounded one asked for.
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
      const since =
        rangeDays && rangeDays > 0
          ? new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000)
          : null;

      if (_exportInFlight) {
        return res.status(429).json({
          message:
            "Un export est déjà en cours. Patientez quelques secondes et réessayez.",
        });
      }
      _exportInFlight = true;

      try {
        // Held across BOTH the query and the serialization — the workbook
        // build is as memory-hungry as the fetch.
        const rows = await buildProspectRows({ platform, since });

        const dateTag = new Date().toISOString().slice(0, 10);
        const platTag = platform || "tous-canaux";
        const meta = {
          platformLabel: platform
            ? PLATFORM_LABELS[platform]
            : "Tous les canaux",
          rangeLabel: rangeDays
            ? `${rangeDays} derniers jours`
            : "tout l'historique",
        };

        if (format === "csv") {
          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="prospects-medtour-${platTag}-${dateTag}.csv"`,
          );
          return res.send(toCsv(rows));
        }

        const buffer = await toXlsx(rows, meta);
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="prospects-medtour-${platTag}-${dateTag}.xlsx"`,
        );
        return res.send(Buffer.from(buffer));
      } finally {
        _exportInFlight = false;
      }
    } catch (err) {
      console.error("[Export] prospects failed:", err.message);
      return res.status(500).json({ message: "L'export a échoué" });
    }
  },
);

module.exports = router;
module.exports.buildProspectRows = buildProspectRows;
