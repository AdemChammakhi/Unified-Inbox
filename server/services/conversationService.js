/**
 * conversationService.js
 *
 * The one path every stored message takes: webhooks, CRM sends, email sync
 * and Meta Graph history sync all resolve the customer's conversation
 * (server/db/conversations.js), bring the attachment within the schema's
 * limits (utils/storedMedia.js) and insert through server/db/messages.js,
 * which dedupes on the platform message id.
 */

"use strict";

const conversations = require("../db/conversations");
const messages = require("../db/messages");
const contacts = require("../db/contacts");
const campaigns = require("../db/campaigns");
const { ownAccountId } = require("../db/channels");
const { firstAttachmentUrl, UNAVAILABLE_TEXT } = require("../utils/storedMedia");
const { parseGraphAttachments } = require("../utils/metaPayload");

/**
 * The text and attachment to store for a message: the first attachment
 * only, and a note instead of an empty bubble when its file is lost.
 */
async function storablePayload(content, attachments) {
  const text = typeof content === "string" ? content : "";
  const { attachmentUrl, lost } = await firstAttachmentUrl(attachments);
  return {
    content: lost && !text.trim() ? UNAVAILABLE_TEXT : text,
    attachmentUrl,
    messageType: attachmentUrl ? messages.messageTypeOf(attachments) : "text",
  };
}

/**
 * Store one message exchanged with a customer.
 *
 * @param {object} p
 * @param {string} p.platform
 * @param {string} p.customerId            the customer's platform id
 * @param {"contact"|"agent"} p.senderType contact = from the customer
 * @param {string} [p.externalId]          platform message id (dedupe key)
 * @param {string|number} [p.senderUserId] CRM user who sent it
 * @param {string} [p.content]
 * @param {Array<object>} [p.attachments]  utils/metaPayload shapes
 * @param {Date|string} [p.sentAt]
 * @param {string} [p.name] / [p.username] / [p.avatar] what was learned about the customer
 * @param {string} [p.threadId]            Meta's thread id, when known
 * @param {object} [p.context]             parsed ad referral (campaign attribution)
 * @param {boolean} [p.isRead]
 * @returns {Promise<{conversation: object, inserted: boolean, messageId: number|null}>}
 */
async function storeCustomerMessage(p) {
  const conversation = await conversations.ensureForCustomer({
    platform: p.platform,
    customerId: p.customerId,
    name: p.senderType === "contact" ? p.name : undefined,
    username: p.username,
    avatar: p.avatar,
    threadId: p.threadId,
    firstSeenAt: p.sentAt ? new Date(p.sentAt) : undefined,
  });
  const payload = await storablePayload(p.content, p.attachments);
  const res = await messages.insertMessage(conversation, {
    externalId: p.externalId,
    senderType: p.senderType,
    senderUserId: p.senderUserId,
    isRead: p.isRead,
    sentAt: p.sentAt,
    ...payload,
  });
  if (p.context) {
    campaigns.recordReferral(conversation, p.platform, p.context).catch((err) => {
      console.error("[Campaign] %s referral not recorded (non-fatal):", p.platform, err.message);
    });
  }
  return { conversation, ...res };
}

/**
 * Store a message the CRM sent, claiming the row an echo may have stored
 * first under the same platform id (see routes/webhooks.js, storeEcho).
 */
async function storeCrmSend({ platform, customerId, externalId, content, attachments, userId, sentAt }) {
  const conversation = await conversations.ensureForCustomer({ platform, customerId });
  const payload = await storablePayload(content, attachments);
  const res = await messages.storeCrmSend(conversation, {
    externalId,
    userId,
    sentAt,
    ...payload,
  });
  return { conversation, ...res };
}

/** Our own ids on Meta for a platform: they are never a customer. */
function metaOwnIds(platform, extra = []) {
  return new Set(
    [
      process.env.FACEBOOK_PAGE_ID,
      platform === "instagram" ? process.env.INSTAGRAM_ACCOUNT_ID : null,
      ownAccountId(platform),
      ...extra,
    ]
      .filter(Boolean)
      .map(String),
  );
}

/**
 * The customer of a Graph thread, from its messages: the sender of an
 * incoming one, else the recipient of one of ours.
 */
function customerOfGraphMessages(graphMessages, ownIds) {
  for (const m of graphMessages || []) {
    const from = m?.from?.id ? String(m.from.id) : null;
    if (from && !ownIds.has(from)) return from;
  }
  for (const m of graphMessages || []) {
    const to = m?.to?.data?.[0]?.id ? String(m.to.data[0].id) : null;
    if (to && !ownIds.has(to)) return to;
  }
  return null;
}

/**
 * Store a batch of Graph API messages of one thread (history sync). Only
 * messages not stored yet are fetched for media and inserted.
 *
 * @param {object} p
 * @param {string} p.platform
 * @param {Array<object>} p.graphMessages  Graph `messages.data` entries
 * @param {Set<string>} p.ownIds           ids that are us (Page, IG account)
 * @param {string} [p.customerId]          the customer when already known
 * @param {string} [p.threadId]            the Graph thread id
 * @param {string} [p.customerName]
 * @returns {Promise<{conversation: object|null, inserted: number}>}
 */
async function syncGraphMessages({ platform, graphMessages, ownIds, customerId, threadId, customerName }) {
  const list = (graphMessages || []).filter((m) => m && m.id);
  const customer = customerId || customerOfGraphMessages(list, ownIds);
  if (!customer || conversations.isThreadId(platform, customer)) return { conversation: null, inserted: 0 };
  const incomingName =
    customerName ||
    list.map((m) => (m.from?.id === customer ? m.from?.username || m.from?.name : null)).find(Boolean);
  const conversation = await conversations.ensureForCustomer({
    platform,
    customerId: customer,
    name: incomingName,
    threadId,
    firstSeenAt: list.length ? new Date(list[list.length - 1].created_time) : undefined,
  });
  const known = await messages.existingExternalIds(
    conversation.id,
    list.map((m) => m.id),
  );
  const fresh = list.filter((m) => !known.has(String(m.id)));
  if (fresh.length === 0) return { conversation, inserted: 0 };
  const rows = [];
  for (const m of fresh) {
    const outgoing = m.from?.id ? ownIds.has(String(m.from.id)) : false;
    const payload = await storablePayload(m.message || "", parseGraphAttachments(m.attachments));
    rows.push({
      externalId: m.id,
      senderType: outgoing ? "agent" : "contact",
      sentAt: m.created_time,
      ...payload,
    });
  }
  const inserted = await messages.insertMessages(conversation, rows);
  return { conversation, inserted: inserted.length };
}

/** Stored avatars for list rows without one: { customerId: url }. */
function getContactAvatarMap(platform, externalIds) {
  return contacts.avatarMap(platform, externalIds);
}

module.exports = {
  storeCustomerMessage,
  storeCrmSend,
  syncGraphMessages,
  customerOfGraphMessages,
  metaOwnIds,
  getContactAvatarMap,
};
