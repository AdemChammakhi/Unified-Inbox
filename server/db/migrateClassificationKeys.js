/**
 * migrateClassificationKeys.js
 *
 * Re-key classifications saved under a Meta thread id ("t_…") to the
 * customer's own id (IGSID / PSID), which is the only id present in every
 * conversation-list shape (see PUT /api/classifications).
 *
 * Idempotent and cheap: it only touches rows whose key starts with "t_",
 * resolves the customer from an inbound message stored under that thread,
 * and leaves rows alone when nothing inbound was ever synced for them.
 * When a row already exists under the customer id, the newer one wins.
 */

"use strict";

const Classification = require("../models/Classification");
const Message = require("../models/Message");

async function migrateClassificationKeys() {
  const threadRows = await Classification.find({
    conversationId: /^t_/i,
  }).lean();
  if (threadRows.length === 0) return { scanned: 0, rekeyed: 0 };

  let rekeyed = 0;
  for (const row of threadRows) {
    const inbound = await Message.findOne({
      platform: row.platform,
      conversationId: row.conversationId,
      direction: "incoming",
    })
      .select("senderId")
      .lean();
    const customerId = inbound?.senderId;
    if (!customerId || customerId === row.conversationId) continue;

    const existing = await Classification.findOne({
      platform: row.platform,
      conversationId: customerId,
    }).lean();

    if (existing) {
      // Keep whichever was set last; drop the other.
      const keepThread =
        new Date(row.updatedAt || 0) > new Date(existing.updatedAt || 0);
      if (keepThread) {
        await Classification.deleteOne({ _id: existing._id });
        await Classification.updateOne(
          { _id: row._id },
          { $set: { conversationId: customerId } },
        );
      } else {
        await Classification.deleteOne({ _id: row._id });
      }
    } else {
      await Classification.updateOne(
        { _id: row._id },
        { $set: { conversationId: customerId } },
      );
    }
    rekeyed += 1;
  }
  return { scanned: threadRows.length, rekeyed };
}

module.exports = migrateClassificationKeys;
