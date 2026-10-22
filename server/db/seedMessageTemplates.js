/**
 * seedMessageTemplates.js — load MEDTOURS' official quick-reply library
 * ("Bibliothèque officielle des réponses rapides – UNIFIED INBOX", Oct 2026)
 * into the MessageTemplate collection at startup.
 *
 * Idempotent: templates are matched on `seedKey` and only INSERTED when
 * missing ($setOnInsert), so anything edited or deactivated from the
 * Modèles page stays as the team left it. Removing an entry from the JSON
 * never deletes it from the DB. A library template cannot be hard-deleted
 * (routes/messageTemplates.js deactivates it instead), or it would come back
 * at the next restart.
 */

"use strict";

const MessageTemplate = require("../models/MessageTemplate");

async function seedMessageTemplates() {
  let rows;
  try {
    rows = require("../data/messageTemplates.seed.json");
  } catch (err) {
    return { loaded: 0, inserted: 0, error: err.message };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { loaded: 0, inserted: 0 };

  const ops = rows
    .filter((r) => r && r.seedKey && r.title && r.body)
    .map((r) => ({
      updateOne: {
        filter: { seedKey: r.seedKey },
        update: {
          $setOnInsert: {
            seedKey: r.seedKey,
            title: String(r.title).slice(0, 120),
            body: String(r.body).slice(0, 4096),
            category: String(r.category || "").slice(0, 60),
            platforms: [],
            sortOrder: Number.isFinite(r.sortOrder) ? r.sortOrder : 0,
            isActive: true,
            usageCount: 0,
          },
        },
        upsert: true,
      },
    }));

  const res = await MessageTemplate.bulkWrite(ops, { ordered: false });
  return { loaded: ops.length, inserted: res.upsertedCount || 0 };
}

module.exports = seedMessageTemplates;
