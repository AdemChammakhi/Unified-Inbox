/**
 * migrateMessageExternalIds.js — make Message.externalId unique.
 *
 * Every message write upserts on the platform message id, but the index on
 * it used to be a plain one, and MongoDB only stops two concurrent upserts
 * from both inserting when a UNIQUE index exists. So a retried webhook, or
 * a webhook racing a Graph sync, could store the same message twice.
 *
 * Steps (idempotent; a no-op once the unique index exists):
 *  1. remove the extra copies of each duplicated id, keeping the copy that
 *     carries the agent (sentBy) — that is what the reply counts read —
 *     else the oldest. Removed copies are first saved, untouched, into the
 *     `messages_duplicates_removed` collection so nothing is lost;
 *  2. build the unique index (partial: rows without an id are not indexed),
 *     then drop the old plain `messages_extId` index;
 *  3. build the remaining schema indexes, which Mongoose's own start-up
 *     index build may have skipped while the duplicates were there.
 * A duplicate written between steps 1 and 2 makes the build fail; it then
 * cleans up again, up to MAX_ATTEMPTS times.
 */

"use strict";

const Message = require("../models/Message");
const { isDuplicateKey } = require("../utils/duplicateKey");

const UNIQUE_NAME = "uniq_messages_extId";
const LEGACY_NAME = "messages_extId";
const BACKUP_COLLECTION = "messages_duplicates_removed";
const MAX_ATTEMPTS = 3;

/** Server refuses two indexes on one key that differ only in options. */
const INDEX_CONFLICT_CODES = new Set([85, 86]); // IndexOptionsConflict, IndexKeySpecsConflict

async function listIndexes(coll) {
  try {
    return await coll.indexes();
  } catch (err) {
    if (err?.code === 26) return []; // NamespaceNotFound: no messages yet
    throw err;
  }
}

/** Keep the agent-attributed copy, then the oldest, then the lowest _id. */
function keepFirst(a, b) {
  const aAgent = a.sentBy ? 0 : 1;
  const bAgent = b.sentBy ? 0 : 1;
  if (aAgent !== bAgent) return aAgent - bAgent;
  const aAt = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
  const bAt = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
  if (aAt !== bAt) return aAt - bAt;
  return String(a._id).localeCompare(String(b._id));
}

async function removeDuplicates(coll) {
  const groups = await coll
    .aggregate(
      [
        { $match: { externalId: { $gt: "" } } },
        { $group: { _id: "$externalId", n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ],
      { allowDiskUse: true },
    )
    .toArray();
  if (groups.length === 0) return 0;

  // Message.db is the Mongoose connection; its .db is the driver's Db
  const backup = Message.db.db.collection(BACKUP_COLLECTION);
  let removed = 0;
  for (const g of groups) {
    const rows = await coll.find({ externalId: g._id }).toArray();
    if (rows.length < 2) continue;
    rows.sort(keepFirst);
    const kept = rows[0];
    const extra = rows.slice(1);
    try {
      await backup.insertMany(
        extra.map((doc) => ({
          ...doc,
          _dedupe: { keptId: kept._id, removedAt: new Date() },
        })),
        { ordered: false },
      );
    } catch (err) {
      // Already backed up by an earlier, interrupted run
      const errs = [].concat(err.writeErrors || []);
      if (!(isDuplicateKey(err) || (errs.length && errs.every((e) => isDuplicateKey(e))))) {
        throw err;
      }
    }
    const res = await coll.deleteMany({ _id: { $in: extra.map((d) => d._id) } });
    removed += res.deletedCount || 0;
  }
  return removed;
}

async function createUniqueIndex(coll) {
  const spec = { externalId: 1 };
  const options = {
    name: UNIQUE_NAME,
    unique: true,
    partialFilterExpression: { externalId: { $gt: "" } },
  };
  try {
    await coll.createIndex(spec, options);
  } catch (err) {
    // Older servers will not hold it beside the plain index on the same key
    if (!INDEX_CONFLICT_CODES.has(err?.code)) throw err;
    await coll.dropIndex(LEGACY_NAME).catch(() => {});
    await coll.createIndex(spec, options);
  }
}

async function migrateMessageExternalIds() {
  const coll = Message.collection;
  const indexes = await listIndexes(coll);
  const unique = indexes.find((i) => i.name === UNIQUE_NAME && i.unique);
  const legacy = indexes.find((i) => i.name === LEGACY_NAME);
  if (unique && !legacy) return { alreadyUnique: true, removed: 0 };

  let removed = 0;
  if (!unique) {
    for (let attempt = 1; ; attempt += 1) {
      removed += await removeDuplicates(coll);
      try {
        await createUniqueIndex(coll);
        break;
      } catch (err) {
        if (!isDuplicateKey(err) || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
  }

  if ((await listIndexes(coll)).some((i) => i.name === LEGACY_NAME)) {
    await coll.dropIndex(LEGACY_NAME);
  }
  await Message.createIndexes();
  return { alreadyUnique: false, removed };
}

module.exports = migrateMessageExternalIds;
module.exports.BACKUP_COLLECTION = BACKUP_COLLECTION;
