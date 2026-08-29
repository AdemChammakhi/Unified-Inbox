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
  try {
    return new Date(d).toLocaleString("fr-FR", {
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

const isPlaceholderName = (name) =>
  !name || name === "Unknown" || /^User \d{4}$/.test(name) || /^\d{6,}$/.test(name);

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
  if (messages.length === MESSAGE_CAP) {
    console.warn(
      `[Export] hit the ${MESSAGE_CAP}-message cap — "premier contact" may be truncated for old threads`,
    );
  }

  const own = ownIds();
  const prospects = new Map(); // "<platform>:<personId>" -> row accumulator

  for (const m of messages) {
    const personId = m.direction === "incoming" ? m.senderId : m.recipientId;
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

  if (prospects.size === 0) return [];

  // Classification + lock, matched against ANY of the person's keys
  const allConvIds = [
    ...new Set([...prospects.values()].flatMap((p) => [...p.convIds])),
  ];
  const [classifications, locks] = await Promise.all([
    Classification.find({ conversationId: { $in: allConvIds } })
      .select("conversationId platform classification appointmentAt")
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

  const rows = [...prospects.values()].map((p) => {
    let cls = null;
    let lock = null;
    for (const id of p.convIds) {
      cls = cls || classByConv.get(`${p.platform}:${id}`);
      lock = lock || lockByConv.get(`${p.platform}:${id}`);
    }
    const classification = cls?.classification || "non_classifie";
    const agent = lock?.lockedBy
      ? `${lock.lockedBy.firstName || ""} ${lock.lockedBy.lastName || ""}`.trim()
      : "";

    return {
      platform: p.platform,
      source: p.adTitle
        ? `${PLATFORM_LABELS[p.platform] || p.platform} — Pub: ${p.adTitle}`
        : PLATFORM_LABELS[p.platform] || p.platform,
      name: p.name || `Prospect ${String(p.personId).slice(-4)}`,
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
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function toCsv(rows) {
  const esc = (v) => {
    const s = csvSafe(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [HEADERS.map(esc).join(";")];
  for (const r of rows) lines.push(rowValues(r).map(esc).join(";"));
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
  title.value = `Prospects Medtour CRM — ${meta.platformLabel} — ${meta.rangeLabel} — exporté le ${fmtDate(new Date())}`;
  title.font = { bold: true, size: 12, color: { argb: "FFE8833A" } };
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
      const rangeDays =
        req.query.range && req.query.range !== "all"
          ? parseInt(req.query.range)
          : null;
      const since =
        rangeDays && rangeDays > 0
          ? new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000)
          : null;

      const rows = await buildProspectRows({ platform, since });

      const dateTag = new Date().toISOString().slice(0, 10);
      const platTag = platform || "tous-canaux";
      const meta = {
        platformLabel: platform ? PLATFORM_LABELS[platform] : "Tous les canaux",
        rangeLabel: rangeDays ? `${rangeDays} derniers jours` : "tout l'historique",
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
    } catch (err) {
      console.error("[Export] prospects failed:", err.message);
      return res.status(500).json({ message: "L'export a échoué" });
    }
  },
);

module.exports = router;
module.exports.buildProspectRows = buildProspectRows;
