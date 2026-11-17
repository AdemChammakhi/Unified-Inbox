/**
 * duplicateKey.js — writes that race on a unique index.
 *
 * Message.externalId is unique (models/Message.js). When two writers upsert
 * the same platform message id at once (Meta retrying a webhook, an echo
 * arriving while the send route stores its own row, a Graph sync running
 * beside a webhook), one of them gets E11000 instead of a second copy. The
 * row it wanted already exists, so retrying the same upsert once matches
 * that row and applies the update ($setOnInsert does nothing, $set lands).
 */

"use strict";

const DUPLICATE_KEY_CODES = new Set([11000, 11001]);

function isDuplicateKey(err) {
  return Boolean(err) && DUPLICATE_KEY_CODES.has(err.code);
}

/**
 * Run `write`; if it loses a duplicate-key race, run it once more.
 * @template T
 * @param {() => Promise<T>} write
 * @returns {Promise<T>}
 */
async function retryOnDuplicateKey(write) {
  try {
    return await write();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    return write();
  }
}

/** True when a bulk write failed only because some rows already existed. */
function isDuplicateKeyOnly(err) {
  const writeErrors = err && err.writeErrors;
  if (writeErrors === undefined || writeErrors === null) return isDuplicateKey(err);
  const list = [].concat(writeErrors);
  return list.length > 0 && list.every((e) => isDuplicateKey(e) || isDuplicateKey(e?.err));
}

/**
 * Unordered bulk upsert keyed on a unique field. Every op runs; ops that
 * lost a race to another writer are fine (the row is there), so only other
 * failures are thrown.
 */
async function bulkUpsert(Model, ops) {
  if (!ops || ops.length === 0) return null;
  try {
    return await Model.bulkWrite(ops, { ordered: false });
  } catch (err) {
    if (isDuplicateKeyOnly(err)) return err.result || null;
    throw err;
  }
}

module.exports = {
  isDuplicateKey,
  isDuplicateKeyOnly,
  retryOnDuplicateKey,
  bulkUpsert,
};
