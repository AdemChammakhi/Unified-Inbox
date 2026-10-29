/**
 * resolveRecipient.js — make sure we hand Meta a PERSON, not a thread.
 *
 * The inbox sends `recipientId: participants[0]?.id || conversation.id`. When
 * Meta gives us no participant — which is the normal state for Instagram
 * under Standard Access, and also happens whenever the conversation list is
 * built from our own database — that falls through to the conversation id.
 * For any thread-keyed conversation that id is `t_…`, and the Send API
 * answers "(#100) No matching user found": the reply never leaves, and until
 * this was mapped the agent saw only a generic failure.
 *
 * The conversation row behind a thread id carries its customer
 * (participant_external_id, see server/db/conversations.js), so the person is
 * always recoverable from what we already stored.
 */

"use strict";

const conversations = require("../db/conversations");

/**
 * @param {string} platform
 * @param {string} recipientId    what the client asked us to send to
 * @param {string} conversationId the conversation it belongs to
 * @returns {Promise<{id: string, repaired: boolean}>}
 */
async function resolveRecipientId(platform, recipientId, conversationId) {
  const given = typeof recipientId === "string" ? recipientId.trim() : "";
  // A plain user id is already correct — don't spend a query on it.
  if (given && !/^t_/i.test(given)) return { id: given, repaired: false };

  const keys = [given, conversationId].filter((k) => typeof k === "string" && k);
  if (keys.length === 0) return { id: given, repaired: false };

  try {
    const conv = await conversations.resolve(platform, keys);
    if (conv?.customerId && !/^t_/i.test(conv.customerId)) {
      console.log(
        `[Send] recipient repaired: ${given} -> ${conv.customerId} (${platform})`,
      );
      return { id: conv.customerId, repaired: true };
    }
  } catch (err) {
    console.error("[Send] recipient resolution failed:", err.message);
  }

  // Nothing better to offer — let Meta answer, and the error mapper will
  // explain it rather than swallowing it.
  return { id: given, repaired: false };
}

module.exports = { resolveRecipientId };
