/**
 * dispatching.js — give a discussion to an agent, and follow it.
 *
 * `assignConversation` is the lock move behind PUT /api/locks/assign and
 * behind every dispatch: a conversation has no single id (CLAUDE.md §6),
 * the inbox may list it under the customer id or a Meta thread id, and the
 * send routes check the lock under whichever one the inbox sent. So the
 * lock is set on EVERY key the customer's messages live under: the new
 * agent passes the check whatever the list shape, the previous one no
 * longer does. A null agent releases the discussion.
 *
 * `noteDispatchReply` is called by the send routes once a message is out:
 * the first answer of the dispatched agent is what the admin's board shows
 * as "started".
 */

"use strict";

const ConversationLock = require("../models/ConversationLock");
const Dispatch = require("../models/Dispatch");
const Message = require("../models/Message");

/** Every key this customer's discussion is stored under, the customer id first. */
async function conversationKeys(platform, customerId) {
  // Both $or branches are index-backed: platform+senderId, platform+recipientId
  const threadKeys = await Message.distinct("conversationId", {
    platform,
    $or: [{ senderId: customerId }, { recipientId: customerId }],
  });
  return [...new Set([customerId, ...threadKeys.filter(Boolean).map(String)])];
}

/**
 * Lock the discussion for `agentId` on all its keys, or release it when
 * `agentId` is null. Returns the keys written.
 */
async function assignConversation({ platform, customerId, agentId }) {
  const keys = await conversationKeys(platform, customerId);
  if (!agentId) {
    await ConversationLock.deleteMany({ platform, conversationId: { $in: keys } });
    return keys;
  }
  const now = new Date();
  await ConversationLock.bulkWrite(
    keys.map((conversationId) => ({
      updateOne: {
        filter: { conversationId, platform },
        update: {
          $set: { lockedBy: agentId, lockedAt: now, expiresAt: null },
          $setOnInsert: { conversationId, platform },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return keys;
}

/**
 * Record the dispatched agent's first reply. `ids` are the ids the send
 * route knows (the lock key and the recipient); the dispatch is keyed by
 * the customer id, which is one of them. Never throws: the message is
 * already out, this is bookkeeping.
 */
async function noteDispatchReply(platform, ids, userId) {
  try {
    const customerIds = [...new Set((ids || []).filter(Boolean).map(String))];
    if (customerIds.length === 0 || !userId) return;
    await Dispatch.updateOne(
      {
        platform,
        customerId: { $in: customerIds },
        agent: userId,
        status: "open",
        firstReplyAt: null,
      },
      { $set: { firstReplyAt: new Date() } },
    );
  } catch (err) {
    console.error("[Dispatch] first-reply note failed (non-fatal):", err.message);
  }
}

module.exports = { conversationKeys, assignConversation, noteDispatchReply };
