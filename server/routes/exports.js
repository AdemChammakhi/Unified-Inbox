/**
 * exports.js — the prospect sheet, generated instead of maintained by hand.
 *
 * The team tracks prospects in a color-coded spreadsheet: source, name,
 * phone, first contact, process stage, commercial in charge, comments
 * (ticket N°7995). This endpoint assembles that exact table from what the
 * inbox already knows — each customer's conversation (dossier, lock, the ad
 * that brought them), its messages and who sent each reply — and serves it as
 * styled Excel or French-locale CSV.
 *
 * Two columns are derived, never stored: "Maturité" (Chaud / Tiède / Froid,
 * from utils/leadMaturity) and "Motif / frein" (the obstacle the agent
 * recorded, read from the contact's custom fields through utils/leadFrein).
 *
 * One row per PROSPECT (the person): there is one conversation per customer
 * and platform (server/db/conversations.js), whichever key — thread id or
 * customer id — its messages arrived under.
 *
 * Admin + manager only — this is the whole prospect base in one file.
 */

"use strict";

const express = require("express");
const router = express.Router();
const ExcelJS = require("exceljs");
const { db, at } = require("../db/sql");
const { stageOf, qualificationOf, typologyOf } = require("../db/reference");
const { isPlaceholderName } = require("../db/contacts");
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

// Funnel steps, qualifications and typologies: labels from the shared constants
const {
  STAGE_LABEL,
  QUALIFICATION_LABEL,
  TYPOLOGY_LABEL,
} = require("../constants/pipeline");

// Same colors the app uses (client/src/constants/pipeline.js), as ARGB fills.
// "Nouveau lead" keeps the plain cell in both columns.
const STAGE_FILLS = {
  contact_etabli: "FF5B9BD9",
  offre_presentee: "FF4EC3C3",
  devis_envoye: "FFA98BD6",
  reservation_passee: "FF3FA37A",
  paiement_en_cours: "FF2E8B57",
  dossier_confirme: "FF1F7A4F",
};

const QUALIFICATION_FILLS = {
  en_attente_reponse: "FFE3A63C",
  en_cours: "FF5B9BD9",
  en_reflexion: "FFA98BD6",
  dossier_confirme: "FF1F7A4F",
  injoignable: "FFD98CB3",
  non_interesse: "FFE2685F",
  prix_trop_eleve: "FFE07B39",
  offre_concurrente: "FFC0504D",
  reservation_annulee: "FFB03A48",
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
 *
 * The database does the work: one row per conversation active in the
 * range, with the period's counts and first/last message, the full-history
 * figures the maturity rules read, the current lock holder, the newest CRM
 * reply's author, the newest message and the campaign. Only a 200-character
 * preview of that message leaves the database, so a full-history sheet stays
 * within the backend container's 512 MB / half a core (CLAUDE.md §11, §14).
 *
 * @returns {Promise<Array<object>>} sorted by last contact, newest first
 */
async function buildProspectRows({ platform, since }) {
  const platforms = platform
    ? [platform]
    : ["instagram", "facebook", "whatsapp", "email"];

  const found = (
    await db.query(
      `WITH period AS (
         SELECT m.conversation_id,
                first_at = MIN(dbo.fn_DateTimeCombine(m.sent_date, m.sent_time)),
                last_at = MAX(dbo.fn_DateTimeCombine(m.sent_date, m.sent_time)),
                msgs_in = SUM(CASE WHEN m.sender_type = N'contact' THEN 1 ELSE 0 END),
                msgs_out = SUM(CASE WHEN m.sender_type <> N'contact' THEN 1 ELSE 0 END)
         FROM dbo.message m
         JOIN dbo.conversations c ON c.conversation_id = m.conversation_id
         WHERE c.platform IN (SELECT value FROM OPENJSON(@platforms)) AND c.deleted_date IS NULL
           AND (@s_date IS NULL OR m.sent_date > @s_date OR (m.sent_date = @s_date AND m.sent_time >= @s_time))
         GROUP BY m.conversation_id
       ),
       history AS (
         SELECT m.conversation_id,
                all_in = SUM(CASE WHEN m.sender_type = N'contact' THEN 1 ELSE 0 END),
                all_out = SUM(CASE WHEN m.sender_type <> N'contact' THEN 1 ELSE 0 END),
                all_last_in = MAX(CASE WHEN m.sender_type = N'contact' THEN dbo.fn_DateTimeCombine(m.sent_date, m.sent_time) END),
                all_last_out = MAX(CASE WHEN m.sender_type <> N'contact' THEN dbo.fn_DateTimeCombine(m.sent_date, m.sent_time) END)
         FROM dbo.message m
         WHERE m.conversation_id IN (SELECT conversation_id FROM period)
         GROUP BY m.conversation_id
       )
       SELECT c.conversation_id, c.platform, c.external_id, c.participant_external_id, c.participant_name,
              c.classification_id, c.qualification_id, c.motif_id,
              appointment_at = dbo.fn_DateTimeCombine(c.appointment_date, c.appointment_time),
              p.first_at, p.last_at, p.msgs_in, p.msgs_out,
              h.all_in, h.all_out, h.all_last_in, h.all_last_out,
              lock_name = LTRIM(RTRIM(CONCAT(lu.first_name, N' ', lu.last_name))),
              replier_name = LTRIM(RTRIM(CONCAT(ru.first_name, N' ', ru.last_name))),
              last_text = lm.preview, last_sender_type = lm.sender_type, last_has_media = lm.has_media,
              campaign_title = k.title, contact_phone = ct.phone, contact_email = ct.email
       FROM period p
       JOIN dbo.conversations c ON c.conversation_id = p.conversation_id
       JOIN history h ON h.conversation_id = p.conversation_id
       LEFT JOIN dbo.users lu ON lu.user_id = c.locked_by_user_id
       OUTER APPLY (
         SELECT TOP 1 m.sender_user_id FROM dbo.message m
         WHERE m.conversation_id = c.conversation_id AND m.sender_type <> N'contact' AND m.sender_user_id IS NOT NULL
         ORDER BY m.sent_date DESC, m.sent_time DESC, m.message_id DESC
       ) rr
       LEFT JOIN dbo.users ru ON ru.user_id = rr.sender_user_id
       OUTER APPLY (
         SELECT TOP 1 preview = LEFT(m.content, 200), m.sender_type,
                has_media = CASE WHEN m.attachment_url IS NULL THEN 0 ELSE 1 END
         FROM dbo.message m
         WHERE m.conversation_id = c.conversation_id
           AND (@s_date IS NULL OR m.sent_date > @s_date OR (m.sent_date = @s_date AND m.sent_time >= @s_time))
           AND (NULLIF(LTRIM(RTRIM(m.content)), N'') IS NOT NULL OR m.attachment_url IS NOT NULL)
         ORDER BY m.sent_date DESC, m.sent_time DESC, m.message_id DESC
       ) lm
       LEFT JOIN dbo.campaigns k ON k.campaign_id = c.campaign_id
       LEFT JOIN dbo.contacts ct ON ct.contact_id = c.contact_id`,
      { platforms: JSON.stringify(platforms), ...at("s", since || null) },
    )
  ).rows;

  const own = ownIds();
  const prospects = [];
  for (const r of found) {
    const personId = r.participant_external_id || r.external_id;
    if (!personId || own.has(personId)) continue;
    // A thread whose customer was never identified and who never wrote:
    // better absent than a phantom prospect
    if (!r.participant_external_id && !r.msgs_in) continue;
    prospects.push({ ...r, personId });
  }
  if (prospects.length === 0) return [];

  // The recorded frein, keyed by the customer id: ONE lookup per platform
  // present in the sheet. Non-fatal — a sheet without the "Motif / frein"
  // column filled beats no sheet at all.
  const personsByPlatform = new Map(); // platform -> [personId]
  for (const p of prospects) {
    if (!p.participant_external_id) continue;
    if (!personsByPlatform.has(p.platform)) personsByPlatform.set(p.platform, []);
    personsByPlatform.get(p.platform).push(String(p.personId));
  }
  const freins = new Map(); // "<platform>:<personId>" -> frein
  await Promise.all(
    [...personsByPlatform].map(async ([plat, ids]) => {
      try {
        const got = await getFreins(plat, ids);
        for (const [id, frein] of got) freins.set(`${plat}:${id}`, frein);
      } catch (err) {
        console.warn(
          `[Export] frein lookup skipped for ${plat} (non-fatal):`,
          err.message,
        );
      }
    }),
  );

  // One clock for the whole sheet, so every row is judged at the same instant
  const now = new Date();

  const rows = prospects.map((p) => {
    const classification = stageOf(p.classification_id);
    const qualification = qualificationOf(p.qualification_id);
    const typologie = typologyOf(p.motif_id);
    // The RDV date is independent of the stage
    const rdvAt = p.appointment_at || null;
    // "Commercial en charge": the agent CURRENTLY holding the lead (the
    // lock). Without a lock, whoever sent the newest CRM reply stands in;
    // replies from Business Suite or the apps have no sender and never name
    // anyone.
    const agent = p.lock_name || p.replier_name || UNASSIGNED;

    const frein = freins.get(`${p.platform}:${p.personId}`) || null;
    // Maturity describes the lead, not the chosen period: full history
    const maturity = computeMaturity({
      messagesIn: p.all_in,
      messagesOut: p.all_out,
      lastIncomingAt: p.all_last_in,
      lastOutgoingAt: p.all_last_out,
      stage: classification,
      qualification,
      appointmentAt: rdvAt,
      frein,
      now,
    });

    // "Dernier message": the newest message of the period from EITHER side
    // that has something to show; a media-only one reads "[pièce jointe]"
    const text = typeof p.last_text === "string" ? p.last_text.trim() : "";
    const body = text || (p.last_has_media ? "[pièce jointe]" : "");
    const lastMessage = body
      ? `${p.last_sender_type === "contact" ? "Prospect" : "Commercial"} : ${body}`
      : "";

    const name = isPlaceholderName(p.participant_name, p.personId)
      ? fallbackName(p.platform, p.personId)
      : p.participant_name;

    return {
      platform: p.platform,
      source: p.campaign_title
        ? `${PLATFORM_LABELS[p.platform] || p.platform} — Pub: ${p.campaign_title}`
        : PLATFORM_LABELS[p.platform] || p.platform,
      name,
      phone: p.contact_phone || (p.platform === "whatsapp" ? `+${p.personId}` : ""),
      email: p.contact_email || (p.platform === "email" ? p.personId : ""),
      firstContact: p.first_at,
      lastContact: p.last_at,
      classification,
      classificationLabel: STAGE_LABEL[classification] || classification,
      qualification,
      qualificationLabel: QUALIFICATION_LABEL[qualification] || qualification,
      typologie,
      typologieLabel: TYPOLOGY_LABEL[typologie] || "",
      maturity: maturity.label,
      maturityLevel: maturity.level,
      maturityReason: maturity.reason,
      frein: freinLabel(frein),
      freinCode: frein?.code || "",
      rdvAt,
      agent,
      messagesIn: p.msgs_in,
      messagesOut: p.msgs_out,
      lastMessage: cutText(lastMessage, 160),
    };
  });

  rows.sort((a, b) => new Date(b.lastContact) - new Date(a.lastContact));
  // Nothing is capped any more; kept so callers and files read it as before
  rows.truncated = false;
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
  "Qualification",
  "Typologie",
  "Maturité",
  "Motif / frein",
  "RDV le",
  "Commercial en charge",
  "Messages reçus",
  "Messages envoyés",
  "Dernier message",
];

// Column widths, in HEADERS order — keep the two arrays the same length
const COLUMN_WIDTHS = [11, 34, 24, 15, 26, 17, 17, 18, 20, 18, 10, 28, 17, 20, 9, 9, 46];

// 1-based XLSX column numbers, derived so an inserted column cannot shift them
const CLASS_COL = HEADERS.indexOf("Étape") + 1;
const QUALIFICATION_COL = HEADERS.indexOf("Qualification") + 1;
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
    r.qualificationLabel,
    r.typologieLabel || "",
    r.maturity || "",
    r.frein || "",
    fmtDate(r.rdvAt),
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
    for (const [col, fill] of [
      [CLASS_COL, STAGE_FILLS[r.classification]],
      [QUALIFICATION_COL, QUALIFICATION_FILLS[r.qualification]],
    ]) {
      if (!fill) continue;
      const cell = row.getCell(col);
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
