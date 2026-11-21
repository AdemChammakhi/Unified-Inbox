/**
 * partners.js — the directory of MEDTOUR agencies and B2B partners, served as
 * a READ-ONLY library.
 *
 * The SQL Server schema (database/sqlserver/schema/dbunifedbox.sql) has no
 * table for the directory and is never extended (decisions D5, D6: rows
 * only, never schema). The entries therefore come from
 * server/data/partners.seed.json — the spreadsheet management provided —
 * loaded once with the module. The HTTP API keeps main's paths, filters and
 * response shapes so the pages work unchanged; the writes answer 405, and
 * `readOnly: true` on the list tells the page to hide its editors.
 *
 *   GET    /api/partners            any role  list (filters: kind, governorate, q)
 *   GET    /api/partners/export     any role  the list as an .xlsx, same columns as the source sheet
 *   POST   /api/partners            405
 *   PUT    /api/partners/:id        405
 *   DELETE /api/partners/:id        405
 *   POST   /api/partners/import     405
 *
 * The RDV form (routes/classifications.js) resolves an agency by its id
 * through findPartner(); agencyLabel() is the name kept beside that id.
 */

"use strict";

const express = require("express");
const ExcelJS = require("exceljs");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

const READ_ONLY_MESSAGE =
  "L'annuaire est une bibliothèque en lecture seule (fichier server/data/partners.seed.json).";

const KINDS = new Set(["agence", "partenaire"]);
const KIND_LABEL = { agence: "Agence MEDTOUR", partenaire: "Partenaire BtoB" };

const str = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const oneLine = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);

/** "MEDTOUR Sousse", or "Agence X — Sousse" when the name does not say where. */
const agencyLabel = (p) => {
  const name = oneLine(p.name, 120);
  const city = oneLine(p.city, 60);
  return city && !name.toLowerCase().includes(city.toLowerCase())
    ? `${name} — ${city}`
    : name;
};

/** The library, in main's partner shape; the seed key stands in for the id. */
function loadLibrary() {
  let rows;
  try {
    rows = require("../data/partners.seed.json");
  } catch (err) {
    console.error("[Partners] seed file unreadable:", err.message);
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.seedKey === "string" && r.seedKey && r.name && KINDS.has(r.kind))
    .map((r) => ({
      _id: r.seedKey,
      kind: r.kind,
      name: str(r.name, 120),
      contactName: str(r.contactName, 120),
      phones: Array.isArray(r.phones) ? r.phones.map(String) : [],
      city: str(r.city, 80),
      governorate: str(r.governorate, 60),
      address: str(r.address, 300),
      notes: "",
      isActive: true,
      seedKey: r.seedKey,
    }));
}

const PARTNERS = Object.freeze(loadLibrary());
const BY_ID = new Map(PARTNERS.map((p) => [p._id, p]));

/** The partner behind an id (its seed key), or null. */
function findPartner(id) {
  return typeof id === "string" ? BY_ID.get(id) || null : null;
}

// Main sorted on MongoDB's default (binary) string order
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byDirectoryOrder = (a, b) =>
  cmp(a.governorate, b.governorate) ||
  cmp(a.city, b.city) ||
  cmp(a.kind, b.kind) ||
  cmp(a.name, b.name);

const sorted = (list) => [...list].sort(byDirectoryOrder);

const governoratesOf = (list) =>
  [...new Set(list.map((p) => p.governorate).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "fr"),
  );

const readOnly = (req, res) => res.status(405).json({ message: READ_ONLY_MESSAGE });
const write = [protect, authorize("admin", "manager")];

// ── List ────────────────────────────────────────────────────────────────────
router.get("/", protect, (req, res) => {
  try {
    let list = PARTNERS;
    if (KINDS.has(req.query.kind)) list = list.filter((p) => p.kind === req.query.kind);
    const gov = str(req.query.governorate, 60).toLowerCase();
    if (gov) list = list.filter((p) => p.governorate.toLowerCase() === gov);
    const q = str(req.query.q, 80).toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.contactName.toLowerCase().includes(q) ||
          p.city.toLowerCase().includes(q) ||
          p.governorate.toLowerCase().includes(q) ||
          p.phones.some((n) => n.toLowerCase().includes(q)),
      );
    }
    // includeInactive is accepted and ignored: a library entry is never inactive
    return res.json({
      partners: sorted(list),
      governorates: governoratesOf(PARTNERS),
      readOnly: true,
    });
  } catch (err) {
    console.error("[Partners] list failed:", err.message);
    return res.status(500).json({ message: "Impossible de charger les agences et partenaires." });
  }
});

// ── Export (.xlsx, source layout) ───────────────────────────────────────────
router.get("/export", protect, async (req, res) => {
  try {
    const partners = sorted(PARTNERS);
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

// ── Writes: refused, the library is a file ──────────────────────────────────
router.post("/import", ...write, readOnly);
router.post("/", ...write, readOnly);
router.put("/:id", ...write, readOnly);
router.delete("/:id", ...write, readOnly);

module.exports = router;
module.exports.findPartner = findPartner;
module.exports.agencyLabel = agencyLabel;
module.exports.PARTNERS = PARTNERS;
