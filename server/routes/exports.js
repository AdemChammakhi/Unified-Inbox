/**
 * exports.js — the prospect sheet, generated instead of maintained by hand.
 *
 * The team tracks prospects in a color-coded spreadsheet: source, name,
 * phone, first contact, process stage, commercial in charge, comments
 * (ticket N°7995). This endpoint assembles that exact table from what the
 * inbox already knows — messages, classifications, RDV dates, agent locks,
 * ad attribution — and serves it as styled Excel or French-locale CSV.
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
const { protect, authorize } = require("../middleware/auth");
const { sanitizePlatform } = require("../utils/sanitize");

const PLATFORM_LABELS = {
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  email: "Email",
  messenger: "Messenger",
  tiktok: "TikTok",
};

const CLASSIFICATION_LABELS = {
  non_classifie: "Non classifié",
  cible: "Cible",
  hors_cible: "Hors cible",
  suivi: "Suivi",
  priorite: "Priorité",
  rdv: "RDV",
};

// Same colors the app uses, as ARGB for Excel cell fills
const CLASSIFICATION_FILLS = {
  cible: "FF5FBF8A",
  hors_cible: "FFE2685F",
  suivi: "FF5B9BD9",
  priorite: "FFE3A63C",
  rdv: "FFA98BD6",
};

/** IDs that are US, not prospects. */
function ownIds() {
  return new Set(
    [
      process.env.FACEBOOK_PAGE_ID,
      process.env.INSTAGRAM_ACCOUNT_ID,
      process.env.WHATSAPP_PHONE_NUMBER_ID,
      process.env.EMAIL_USER,
      "agent",
      "unknown",
    ].filter(Boolean),
  );
}

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

/** Graph thread ids (t_…) are conversations, never people. */
const looksLikeThreadId = (id) => typeof id === "string" && /^t_/.test(id);

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
  const messages = await Message.find({
    ...matchPlatform,
    ...(since ? { timestamp: { $gte: since } } : {}),
  })
    .select(
      "platform conversationId senderId recipientId senderName content direction timestamp createdAt context",
    )
    .sort({ timestamp: -1 })
    .limit(MESSAGE_CAP)
    .lean();
  const truncated = messages.length === MESSAGE_CAP;
  if (truncated) {
    console.warn(
      `[Export] hit the ${MESSAGE_CAP}-message cap — "premier contact" and message counts are partial for old threads`,
    );
  }

  const own = ownIds();

  // Pass 1 — learn which PERSON each conversation key belongs to, from
  // inbound messages (whose senderId is always the real customer).
  // This is what lets us repair outbound rows: when the inbox had no
  // resolvable participant (Instagram under Standard Access returns an
  // empty participant list), the client sends the THREAD id as recipientId,
  // so the reply is stored against `t_…` instead of the customer. Without
  // this map that reply becomes a second, phantom prospect row.
  const convToPerson = new Map(); // "<platform>:<convId>" -> personId
  for (const m of messages) {
    if (m.direction !== "incoming") continue;
    if (!m.senderId || own.has(m.senderId) || looksLikeThreadId(m.senderId)) continue;
    if (m.conversationId) {
      convToPerson.set(`${m.platform}:${m.conversationId}`, m.senderId);
    }
    convToPerson.set(`${m.platform}:${m.senderId}`, m.senderId);
  }

  const personOf = (m) => {
    if (m.direction === "incoming") return m.senderId;
    // Outbound: recipientId may be a thread id — remap it to the person
    return (
      convToPerson.get(`${m.platform}:${m.recipientId}`) ||
      convToPerson.get(`${m.platform}:${m.conversationId}`) ||
      m.recipientId
    );
  };

  const prospects = new Map(); // "<platform>:<personId>" -> row accumulator

  for (const m of messages) {
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
        lastIncomingText: "",
        lastIncomingAt: null,
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
    if (m.direction === "incoming") {
      p.messagesIn++;
      if (!isPlaceholderName(m.senderName) && (!p.nameAt || when > p.nameAt)) {
        p.name = m.senderName;
        p.nameAt = when;
      }
      if (m.content && (!p.lastIncomingAt || when > p.lastIncomingAt)) {
        p.lastIncomingText = m.content;
        p.lastIncomingAt = when;
      }
      // Attribution: keep the EARLIEST ad — the one that opened the thread
      if (m.context?.title && (!p.adTitleAt || when < p.adTitleAt)) {
        p.adTitle = m.context.title;
        p.adTitleAt = when;
      }
    } else {
      p.messagesOut++;
    }
  }

  // Drop outbound-only groups still keyed by a thread id: those are the
  // unrepairable half of the case above (a reply with no inbound message in
  // range to link it to a person). Better absent than a phantom prospect.
  for (const [key, p] of prospects) {
    if (p.messagesIn === 0 && looksLikeThreadId(p.personId)) prospects.delete(key);
  }

  if (prospects.size === 0) return [];

  // The UI stores a classification under whichever key the conversation was
  // listed as — the thread id for Graph-listed threads, the sender id for
  // DB-merged ones. A person's keys seen INSIDE the window are not
  // necessarily all of them, so widen the search with an unbounded lookup of
  // every conversation key these people have ever used. Without this, a
  // ranged export shows "Non classifié" for a prospect the inbox shows as
  // Cible, purely because the classified thread's messages fell out of range.
  const personIds = [...prospects.values()].map((p) => p.personId);
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
            person: {
              $cond: [
                { $eq: ["$direction", "incoming"] },
                "$senderId",
                "$recipientId",
              ],
            },
          },
          convIds: { $addToSet: "$conversationId" },
        },
      },
    ]).option({ maxTimeMS: 15000 });
    for (const d of keyDocs) {
      const p = prospects.get(`${d._id.platform}:${d._id.person}`);
      if (p) for (const id of d.convIds || []) if (id) p.convIds.add(id);
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
  const [classifications, locks] = await Promise.all([
    Classification.find({ conversationId: { $in: allConvIds } })
      .select("conversationId platform classification appointmentAt updatedAt")
      .lean(),
    ConversationLock.find({ conversationId: { $in: allConvIds } })
      .populate("lockedBy", "firstName lastName")
      .lean(),
  ]);
  const classByConv = new Map(
    classifications.map((c) => [`${c.platform}:${c.conversationId}`, c]),
  );
  const lockByConv = new Map(
    locks.map((l) => [`${l.platform}:${l.conversationId}`, l]),
  );

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

  const rows = [...prospects.values()].map((p) => {
    const cls = newestOf(classByConv, p, "updatedAt");
    const lock = newestOf(lockByConv, p, "lockedAt");
    const classification = cls?.classification || "non_classifie";
    const agent = lock?.lockedBy
      ? `${lock.lockedBy.firstName || ""} ${lock.lockedBy.lastName || ""}`.trim()
      : "";

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
      classificationLabel: CLASSIFICATION_LABELS[classification],
      rdvAt: classification === "rdv" ? cls?.appointmentAt || null : null,
      agent,
      messagesIn: p.messagesIn,
      messagesOut: p.messagesOut,
      lastIncomingText: (p.lastIncomingText || "").slice(0, 160),
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
  "RDV le",
  "Commercial en charge",
  "Messages reçus",
  "Messages envoyés",
  "Dernier message",
];

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
    fmtDate(r.rdvAt),
    r.agent,
    r.messagesIn,
    r.messagesOut,
    r.lastIncomingText,
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

  const CLASS_COL = 8; // "Étape"
  for (const r of rows) {
    const row = ws.addRow(rowValues(r));
    const fill = CLASSIFICATION_FILLS[r.classification];
    if (fill) {
      const cell = row.getCell(CLASS_COL);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    }
  }

  const widths = [11, 34, 24, 15, 26, 17, 17, 13, 17, 20, 9, 9, 46];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
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
