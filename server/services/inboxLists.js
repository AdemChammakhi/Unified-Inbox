/**
 * inboxLists.js — the stored side of the Instagram and Facebook lists.
 *
 * Those lists are built from Meta's Graph API and completed from the
 * database: a newer stored message replaces Graph's preview, and customers
 * Meta did not return (new senders, or the whole list while the Graph edge is
 * down) are added from their stored conversation. One entry per PERSON: a
 * stored conversation matches a Graph one through either key (the thread id
 * in external_id, or the customer id), see server/db/conversations.js.
 */

"use strict";

const conversations = require("../db/conversations");
const { isPlaceholderName } = require("../db/contacts");
const { syncGraphMessages } = require("./conversationService");

/** The list's lastMessage for a stored conversation. */
function storedLastMessage(conv) {
  const last = conv.lastMessage;
  return {
    text: last.text || "",
    from: last.senderType === "contact" ? conv.name || "Unknown" : "Page",
    time: last.time,
  };
}

/** Display name of a stored customer; `extra` holds names looked up this build. */
function storedName(conv, extra = {}) {
  const id = String(conv.customerId || conv.externalId || "");
  if (!isPlaceholderName(conv.name, id)) return conv.name;
  return extra[id]?.name || `User ${id.slice(-4)}`;
}

/** A stored conversation as a list entry. */
function storedEntry(conv, extra = {}, flags = {}) {
  const id = conv.customerId || conv.externalId;
  return {
    id: conv.externalId,
    participants: [
      {
        id,
        name: storedName(conv, extra),
        profilePicUrl: conv.avatar || extra[id]?.avatar || null,
      },
    ],
    lastMessage: storedLastMessage(conv),
    messages: [],
    ...flags,
  };
}

/**
 * Complete a Graph-built list in place with what the database knows.
 * @param {string} platform
 * @param {Array<object>} formatted  list entries { id, participants, lastMessage }
 * @param {object} [opts]
 * @param {number} [opts.limit]      stored conversations considered
 * @param {object} [opts.extra]      names/avatars looked up this build, by id
 * @param {object} [opts.flags]      fields added to entries that come from the database
 */
async function mergeStoredConversations(platform, formatted, { limit = 100, extra = {}, flags = {} } = {}) {
  const knownIds = new Set();
  formatted.forEach((c) => {
    knownIds.add(c.id);
    (c.participants || []).forEach((p) => knownIds.add(p.id));
  });

  const stored = await conversations.recentWithLastMessage(platform, limit);
  const byKey = new Map();
  for (const conv of stored) {
    byKey.set(conv.externalId, conv);
    if (conv.customerId) byKey.set(conv.customerId, conv);
  }

  // Newer stored message wins over Graph's preview
  for (const c of formatted) {
    let conv = byKey.get(c.id);
    if (!conv) {
      for (const p of c.participants || []) {
        if (byKey.has(p.id)) {
          conv = byKey.get(p.id);
          break;
        }
      }
    }
    if (!conv) continue;
    const graphTime = new Date(c.lastMessage?.time || 0).getTime();
    const dbTime = new Date(conv.lastMessage.time || 0).getTime();
    if (dbTime > graphTime) c.lastMessage = storedLastMessage(conv);
  }

  // Customers Meta did not return
  const added = stored
    .filter(
      (conv) =>
        conv.customerId &&
        !knownIds.has(conv.externalId) &&
        !knownIds.has(conv.customerId),
    )
    .map((conv) => storedEntry(conv, extra, flags));
  if (added.length > 0) formatted.unshift(...added);
  return added.length;
}

/** The whole list from the database (Graph unavailable). */
async function storedConversationList(platform, limit = 100) {
  const stored = await conversations.recentWithLastMessage(platform, limit);
  return stored.filter((conv) => conv.customerId).map((conv) => storedEntry(conv));
}

/**
 * Record what a Graph list revealed, without holding up the response: the
 * thread id of each listed customer and, in full mode, the listed messages.
 * @param {string} platform
 * @param {Array<{customerId, threadId}>} links
 * @param {Array<object>} syncs  syncGraphMessages arguments
 */
function recordGraphListInBackground(platform, links, syncs) {
  setImmediate(async () => {
    if (links.length > 0) {
      await conversations.linkThreads(platform, links).catch((err) =>
        console.error("[%s] thread id link failed (non-fatal):", platform, err.message),
      );
    }
    for (const args of syncs) {
      try {
        await syncGraphMessages(args);
      } catch (err) {
        console.error("[%s] message sync error (non-fatal):", platform, err.message);
      }
    }
  });
}

module.exports = {
  mergeStoredConversations,
  storedConversationList,
  recordGraphListInBackground,
};
