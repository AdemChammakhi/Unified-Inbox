/**
 * migrateStages.js — derive the pipeline `stage` for records written before
 * the pipeline existed (they only carry the legacy six-value `classification`).
 *
 * Idempotent: it only touches rows where `stage` is absent, applies the
 * approved mapping (server/constants/pipeline.js LEGACY_TO_STAGE), and turns
 * the old "priorite" value into the isPriority flag. Appointment dates are
 * left as they are: they are independent of the stage now.
 */

"use strict";

const Classification = require("../models/Classification");
const { LEGACY_TO_STAGE, DEFAULT_STAGE } = require("../constants/pipeline");

async function migrateStages() {
  const rows = await Classification.find({ stage: { $exists: false } })
    .select("classification")
    .lean();
  if (rows.length === 0) return { scanned: 0, migrated: 0 };

  const ops = rows.map((r) => ({
    updateOne: {
      filter: { _id: r._id, stage: { $exists: false } },
      update: {
        $set: {
          stage: LEGACY_TO_STAGE[r.classification] || DEFAULT_STAGE,
          isPriority: r.classification === "priorite",
        },
      },
    },
  }));
  const res = await Classification.bulkWrite(ops, { ordered: false });
  return { scanned: rows.length, migrated: res.modifiedCount || 0 };
}

module.exports = migrateStages;
