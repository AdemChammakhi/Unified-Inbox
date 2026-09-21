/**
 * seedPartners.js — load the embedded agencies/partners spreadsheet into the
 * Partner collection at startup.
 *
 * Idempotent: rows are matched on `seedKey` and only INSERTED when missing
 * ($setOnInsert), so anything edited or deactivated from the UI stays as the
 * team left it. Removing a row from the JSON never deletes it from the DB.
 */

"use strict";

const Partner = require("../models/Partner");

async function seedPartners() {
  let rows;
  try {
    rows = require("../data/partners.seed.json");
  } catch (err) {
    return { loaded: 0, inserted: 0, error: err.message };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { loaded: 0, inserted: 0 };

  const ops = rows
    .filter((r) => r && r.seedKey && r.name && (r.kind === "agence" || r.kind === "partenaire"))
    .map((r) => ({
      updateOne: {
        filter: { seedKey: r.seedKey },
        update: {
          $setOnInsert: {
            seedKey: r.seedKey,
            kind: r.kind,
            name: r.name,
            contactName: r.contactName || "",
            phones: Array.isArray(r.phones) ? r.phones : [],
            city: r.city || "",
            governorate: r.governorate || "",
            address: r.address || "",
            notes: "",
            isActive: true,
          },
        },
        upsert: true,
      },
    }));

  const res = await Partner.bulkWrite(ops, { ordered: false });
  return { loaded: ops.length, inserted: res.upsertedCount || 0 };
}

module.exports = seedPartners;
