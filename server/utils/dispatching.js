/**
 * dispatching.js — give a discussion to an agent, and follow it.
 *
 * `assignConversation` is the move behind PUT /api/locks/assign and behind
 * every dispatch: the customer's conversation row (one per customer per
 * platform, decision E11) gets the agent as lock holder and
 * assigned_to_user_id, so the agent passes the send routes' lock check
 * whatever key the inbox sends. A null agent releases the discussion.
 *
 * `noteDispatchReply` is called by the send routes once a message is out:
 * the first answer of the dispatched agent is what the admin's board shows
 * as "started" (server/db/dispatches.js).
 */

"use strict";

const conversations = require("../db/conversations");
const dispatches = require("../db/dispatches");

/**
 * The customer's conversation, created when nothing is stored yet, reopened
 * when it had been deleted.
 */
async function conversationFor(platform, customerId) {
  let conv = await conversations.resolve(platform, [customerId], { includeDeleted: true });
  if (!conv) {
    conv = conversations.isThreadId(platform, customerId)
      ? await conversations.ensureForThread({ platform, threadId: customerId })
      : await conversations.ensureForCustomer({ platform, customerId });
  } else if (conv.deletedAt) {
    conv = conv.customerId
      ? await conversations.ensureForCustomer({ platform, customerId: conv.customerId })
      : await conversations.ensureForThread({ platform, threadId: conv.externalId });
  }
  return conv;
}

/**
 * Give the discussion to `agentId`, or release it when null.
 * @returns {Promise<object>} the conversation
 */
async function assignConversation({ platform, customerId, agentId }) {
  const conv = await conversationFor(platform, customerId);
  await conversations.assign(conv.id, agentId || null);
  return conv;
}

/**
 * Record the dispatched agent's first reply. `ids` are the ids the send
 * route knows (the lock key and the recipient); the dispatch is keyed by
 * the customer id, which is one of them. Never throws: the message is
 * already out, this is bookkeeping.
 */
async function noteDispatchReply(platform, ids, userId) {
  try {
    await dispatches.noteFirstReply(platform, ids, userId);
  } catch (err) {
    console.error("[Dispatch] first-reply note failed (non-fatal):", err.message);
  }
}

module.exports = { conversationFor, assignConversation, noteDispatchReply };
