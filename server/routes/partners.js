/**
 * partners.js — the directory of MEDTOUR agencies and B2B partners.
 *
 *   GET    /api/partners            any role     list (filters: kind, governorate, q, includeInactive)
 *   GET    /api/partners/export     any role     the list as an .xlsx, same columns as the source sheet
 *   POST   /api/partners            admin/manager create
 *   PUT    /api/partners/:id        admin/manager update
 *   DELETE /api/partners/:id        admin/manager deactivate (hard delete with ?hard=1)
 *   POST   /api/partners/import     admin/manager .xlsx upload in the source layout
 *
 * Import rows are matched on (kind, name, city) case-insensitively: existing
 * rows are updated, new ones inserted, nothing is ever deleted by an import.
 */

"use strict";

const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const mongoose = require("mongoose");
const Partner = require("../models/Partner");
const { protect, authorize } = require("../middleware/auth");
const { governorateForCity, normalize } = require("../utils/tunisiaGovernorates");

const router = express.Router();
const write = [protect, authorize("admin", "manager")];

const KINDS = new Set(["agence", "partenaire"]);
const KIND_LABEL = { agence: "Agence MEDTOUR", partenaire: "Partenaire BtoB" };
const MAX = { name: 120, contactName: 120, city: 80, governorate: 60, address: 300, notes: 1000 };

const str = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Accept "98 407 489", "26392129/71481042", ["..."] → clean digit strings. */
function parsePhones(v) {
  const raw = Array.isArray(v) ? v.join("/") : String(v == null ? "" : v);
  return [...new Set(
    raw
      .split(/[/,;]|\s{2,}|\s-\s/)
      .map((p) => p.replace(/[^\d+]/g, ""))
      .filter((p) => /^\+?\d{6,15}$/.test(p)),
  )].slice(0, 5);
}

function sanitize(body) {
  const out = {};
  if (body.kind !== undefined) out.kind = KINDS.has(body.kind) ? body.kind : null;
  for (const k of Object.keys(MAX)) if (body[k] !== undefined) out[k] = str(body[k], MAX[k]);
  if (body.phones !== undefined) out.phones = parsePhones(body.phones);
  if (body.isActive !== undefined) out.isActive = body.isActive === true || body.isActive === "true";
  // The gouvernorat is derived from the city when left blank or omitted.
  if (!out.governorate && out.city) out.governorate = governorateForCity(out.city);
  return out;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const validId = (id) => mongoose.Types.ObjectId.isValid(id);

// ── List ────────────────────────────────────────────────────────────────────
router.get("/", protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.includeInactive !== "1") filter.isActive = true;
    if (KINDS.has(req.query.kind)) filter.kind = req.query.kind;
    const gov = str(req.query.governorate, 60);
    if (gov) filter.governorate = new RegExp("^" + escapeRegex(gov) + "$", "i");
    const q = str(req.query.q, 80);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ name: rx }, { contactName: rx }, { city: rx }, { governorate: rx }, { phones: rx }];
    }
    const partners = await Partner.find(filter)
      .sort({ governorate: 1, city: 1, kind: 1, name: 1 })
      .lean();
    const governorates = await Partner.distinct("governorate", { isActive: true });
    return res.json({
      partners,
      governorates: governorates.filter(Boolean).sort((a, b) => a.localeCompare(b, "fr")),
    });
  } catch (err) {
    console.error("[Partners] list failed:", err.message);
    return res.status(500).json({ message: "Impossible de charger les agences et partenaires." });
  }
});

// ── Export (.xlsx, source layout) ───────────────────────────────────────────
router.get("/export", protect, async (req, res) => {
  try {
    const partners = await Partner.find({ isActive: true })
      .sort({ governorate: 1, city: 1, kind: 1, name: 1 })
      .lean();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Agences & partenaires");
    ws.columns = [
      { header: "Agence Medtour - Partenaire", key: "name", width: 34 },
      { header: "Nom du responsable", key: "contactName", width: 28 },
      { header: "Mobile", key: "phones", width: 22 },
      { header: "Localisation", key: "city", width: 20 },
      { header: "Gouvernorat", key: "governorate", width: 16 },
      { header: "Adresse", key: "address", width: 34 },
      { header: "Statut", key: "kind", width: 18 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const p of partners) {
      ws.addRow({
        name: p.name, contactName: p.contactName, phones: p.phones.join(" / "),
        city: p.city, governorate: p.governorate, address: p.address, kind: KIND_LABEL[p.kind],
      });
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="agences-partenaires-medtour.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[Partners] export failed:", err.message);
    return res.status(500).json({ message: "Export impossible." });
  }
});

// ── Create ──────────────────────────────────────────────────────────────────
router.post("/", ...write, async (req, res) => {
  try {
    const data = sanitize(req.body || {});
    if (!data.kind) return res.status(400).json({ message: "Type invalide (agence ou partenaire)." });
    if (!data.name) return res.status(400).json({ message: "Le nom est obligatoire." });
    const partner = await Partner.create({ ...data, createdBy: req.user._id, updatedBy: req.user._id });
    return res.status(201).json({ partner });
  } catch (err) {
    console.error("[Partners] create failed:", err.message);
    return res.status(500).json({ message: "Création impossible." });
  }
});

// ── Update ──────────────────────────────────────────────────────────────────
router.put("/:id", ...write, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Identifiant invalide." });
    const data = sanitize(req.body || {});
    if (data.kind === null) return res.status(400).json({ message: "Type invalide (agence ou partenaire)." });
    if (data.name === "") return res.status(400).json({ message: "Le nom est obligatoire." });
    const partner = await Partner.findByIdAndUpdate(
      req.params.id,
      { $set: { ...data, updatedBy: req.user._id } },
      { new: true, runValidators: true },
    ).lean();
    if (!partner) return res.status(404).json({ message: "Fiche introuvable." });
    return res.json({ partner });
  } catch (err) {
    console.error("[Partners] update failed:", err.message);
    return res.status(500).json({ message: "Mise à jour impossible." });
  }
});

// ── Deactivate / delete ─────────────────────────────────────────────────────
router.delete("/:id", ...write, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Identifiant invalide." });
    if (req.query.hard === "1" && req.user.role === "admin") {
      const r = await Partner.findByIdAndDelete(req.params.id);
      if (!r) return res.status(404).json({ message: "Fiche introuvable." });
      return res.json({ deleted: true });
    }
    const partner = await Partner.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false, updatedBy: req.user._id } },
      { new: true },
    ).lean();
    if (!partner) return res.status(404).json({ message: "Fiche introuvable." });
    return res.json({ partner });
  } catch (err) {
    console.error("[Partners] delete failed:", err.message);
    return res.status(500).json({ message: "Suppression impossible." });
  }
});

// ── Import (.xlsx in the source layout) ─────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    cb(null, /\.xlsx$/i.test(file.originalname || "") &&
      /spreadsheetml|octet-stream|excel/i.test(file.mimetype || "")),
});

const HEADER_ALIASES = {
  name: /agence|partenaire|nom de l.agence|^nom$/i,
  contactName: /responsable|contact/i,
  phones: /mobile|t[ée]l[ée]phone|phone/i,
  city: /localisation|ville/i,
  governorate: /gouvernorat|r[ée]gion/i,
  address: /adresse/i,
  kind: /statut|type/i,
};

const cellText = (x) => {
  if (x == null) return "";
  if (typeof x === "object") return String(x.text || x.result || (x.richText ? x.richText.map((r) => r.text).join("") : "")).trim();
  return String(x).trim();
};

router.post("/import", ...write, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "Joignez un fichier .xlsx." });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ message: "Le classeur est vide." });

    // Map columns by header text so the sheet can be in any column order.
    const cols = {};
    ws.getRow(1).eachCell((cell, n) => {
      const h = cellText(cell.value);
      for (const [key, rx] of Object.entries(HEADER_ALIASES)) if (!cols[key] && rx.test(h)) cols[key] = n;
    });
    if (!cols.name) {
      return res.status(400).json({ message: "Colonne « Agence Medtour - Partenaire » introuvable en première ligne." });
    }

    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];
    for (let n = 2; n <= ws.rowCount; n++) {
      const row = ws.getRow(n);
      const get = (k) => (cols[k] ? cellText(row.getCell(cols[k]).value) : "");
      const name = str(get("name"), MAX.name);
      if (!name) { skipped++; continue; }
      const statut = get("kind");
      const kind = /medtour|agence/i.test(statut) ? "agence" : /partenaire|b ?to ?b|b2b/i.test(statut) ? "partenaire" : null;
      if (!kind) { errors.push(`Ligne ${n} : statut inconnu « ${statut} »`); skipped++; continue; }
      const city = str(get("city"), MAX.city);
      const data = {
        kind, name,
        contactName: str(get("contactName"), MAX.contactName),
        phones: parsePhones(get("phones")),
        city,
        governorate: str(get("governorate"), MAX.governorate) || governorateForCity(city),
        address: str(get("address"), MAX.address),
      };
      // Same office = same kind, same name, same place. The place matches on
      // the city ignoring case and accents ("BEJA" is the stored "Béja"), or
      // failing that on the gouvernorat, so the sheet's own spellings
      // ("MEDININE", "TATOUINE") still find the corrected rows.
      const candidates = await Partner.find({
        kind,
        name: new RegExp("^" + escapeRegex(name) + "$", "i"),
      }).select("_id city governorate").lean();
      const existing =
        candidates.find((c) => normalize(c.city) === normalize(city)) ||
        (data.governorate
          ? candidates.find((c) => normalize(c.governorate) === normalize(data.governorate))
          : undefined);
      if (existing) {
        const set = { ...data, isActive: true, updatedBy: req.user._id };
        if (!data.governorate) delete set.governorate; // keep a hand-filled gouvernorat
        if (!data.address) delete set.address;
        await Partner.updateOne({ _id: existing._id }, { $set: set });
        updated++;
      } else {
        await Partner.create({ ...data, createdBy: req.user._id, updatedBy: req.user._id });
        inserted++;
      }
    }
    return res.json({ inserted, updated, skipped, errors: errors.slice(0, 20) });
  } catch (err) {
    console.error("[Partners] import failed:", err.message);
    return res.status(400).json({ message: "Import impossible : vérifiez que le fichier est un .xlsx valide." });
  }
});

module.exports = router;
