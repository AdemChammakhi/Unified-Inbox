/**
 * messages.js — dbo.message rows, and their shape in the API.
 *
 * The table follows the document strictly (decision D3): a message belongs
 * to one conversation, is sent by the contact, an agent or the system, has a
 * type, a text, at most one attachment URL and a read flag. Direction,
 * sender name and ids are derived when a row is read:
 *  - incoming = sender_type 'contact', named after the conversation's customer;
 *  - outgoing = anything else; sender_user_id is the CRM user who sent it
 *    (null for replies typed in Business Suite or the apps, stored from
 *    Meta's echoes, and for synced history).
 *
 * Dedupe: a platform message id (external_id) is stored once per
 * conversation. Inserts for one conversation are serialized with an
 * application lock, so the check and the insert cannot interleave.
 */

"use strict";

const { db, at } = require("./sql");
const { ownAccountId } = require("./channels");

/** SQL message_type for a normalized attachment list (utils/metaPayload shapes). */
function messageTypeOf(attachments) {
  const first = Array.isArray(attachments) ? attachments.find((a) => a && a.url) : null;
  if (!first) return "text";
  if (first.type === "image" || first.type === "video" || first.type === "audio") return first.type;
  if (first.type === "sticker") return "image";
  return "document";
}

const WA_MEDIA_PATH = /^\/api\/whatsapp\/media\/([^/?#]+)/;

/** The API's attachment list for a stored row: zero or one element. */
function attachmentsOf(row) {
  if (!row.attachment_url) return [];
  const type = row.message_type === "document" || row.message_type === "text" ? "file" : row.message_type;
  const wa = WA_MEDIA_PATH.exec(row.attachment_url);
  return [
    {
      type,
      url: row.attachment_url,
      ...(wa ? { mediaId: decodeURIComponent(wa[1]) } : {}),
    },
  ];
}

function outgoingName(platform, row) {
  if (platform === "whatsapp" && row.user_first_name) {
    return `${row.user_first_name} ${row.user_last_name || ""}`.trim();
  }
  if (platform === "email") return process.env.EMAIL_FROM_NAME || "Unified Inbox";
  return "Page";
}

/**
 * The message as the API has always returned it from /messages-paged.
 * `row` must carry the conversation's platform and customer (see SELECT_API).
 */
function toApiMessage(row) {
  const outgoing = row.sender_type !== "contact";
  const platform = row.platform;
  return {
    id: row.external_id || String(row.message_id),
    text: row.content || "",
    from: outgoing ? outgoingName(platform, row) : row.participant_name || "Unknown",
    fromId: outgoing
      ? ownAccountId(platform) || (platform === "whatsapp" ? "agent" : "Page")
      : row.participant_external_id || row.conversation_external_id,
    time: row.sent_at,
    direction: outgoing ? "outgoing" : "incoming",
    messageType: row.message_type,
    attachmentUrl: null,
    attachments: attachmentsOf(row),
    context: null,
  };
}

const SELECT_API = `
  m.message_id, m.conversation_id, m.external_id, m.sender_type, m.sender_user_id, m.message_type,
  m.content, m.attachment_url, m.is_read,
  sent_at = dbo.fn_DateTimeCombine(m.sent_date, m.sent_time),
  created_at = dbo.fn_DateTimeCombine(m.created_date, m.created_time),
  c.platform, c.participant_external_id, c.participant_name, conversation_external_id = c.external_id,
  user_first_name = u.first_name, user_last_name = u.last_name`;

const FROM_API = `
  FROM dbo.message m
  JOIN dbo.conversations c ON c.conversation_id = m.conversation_id
  LEFT JOIN dbo.users u ON u.user_id = m.sender_user_id`;

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const isoTime = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function validDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Store messages in one conversation, skipping any whose external id is
 * already stored there. Counters on the conversation and the contact follow.
 *
 * @param {object} conversation  { id, contactId } (conversations.js shape)
 * @param {Array<object>} list   each:
 *   { externalId?, senderType: "contact"|"agent"|"system", senderUserId?,
 *     messageType?, content?, attachmentUrl?, isRead?, sentAt? }
 * @returns {Promise<Array<{messageId: number, externalId: string|null}>>} the rows inserted
 */
async function insertMessages(conversation, list) {
  const seen = new Set();
  const rows = [];
  const now = new Date();
  (list || []).forEach((m, i) => {
    const ext = typeof m.externalId === "string" && m.externalId.trim() ? m.externalId.trim().slice(0, 255) : null;
    if (ext) {
      if (seen.has(ext)) return;
      seen.add(ext);
    }
    const sent = validDate(m.sentAt) || now;
    const url = typeof m.attachmentUrl === "string" && m.attachmentUrl.length <= 500 ? m.attachmentUrl : null;
    rows.push({
      i,
      e: ext,
      s: ["contact", "agent", "system"].includes(m.senderType) ? m.senderType : "agent",
      u: m.senderUserId ? Number(m.senderUserId) || null : null,
      t: m.messageType || (url ? "document" : "text"),
      c: typeof m.content === "string" ? m.content : "",
      a: url,
      r: m.isRead ? 1 : 0,
      d: isoDate(sent),
      h: isoTime(sent),
    });
  });
  if (rows.length === 0) return [];

  const result = await db.query(
    `SET XACT_ABORT ON;
     BEGIN TRAN;
     DECLARE @r int;
     EXEC @r = sys.sp_getapplock @Resource = @lockName, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
     IF @r < 0 THROW 51000, N'Could not lock the conversation for a message insert', 1;

     DECLARE @ins TABLE (message_id int, external_id nvarchar(255), sender_type nvarchar(10), sent_date date, sent_time time(0));
     INSERT dbo.message (conversation_id, external_id, sender_type, sender_user_id, sender_contact_id, message_type,
                         content, attachment_url, is_read, sent_date, sent_time, created_date, created_time)
     OUTPUT INSERTED.message_id, INSERTED.external_id, INSERTED.sender_type, INSERTED.sent_date, INSERTED.sent_time INTO @ins
     SELECT @conv, r.e, r.s, r.u, CASE WHEN r.s = N'contact' THEN @contact END, r.t, r.c, r.a, r.r, r.d, r.h,
            @now_date, @now_time
     FROM OPENJSON(@rows) WITH (i int '$.i', e nvarchar(255) '$.e', s nvarchar(10) '$.s', u int '$.u',
                                t nvarchar(20) '$.t', c nvarchar(max) '$.c', a nvarchar(500) '$.a',
                                r bit '$.r', d date '$.d', h time(0) '$.h') r
     WHERE r.e IS NULL
        OR NOT EXISTS (SELECT 1 FROM dbo.message x WHERE x.conversation_id = @conv AND x.external_id = r.e)
     ORDER BY r.d, r.h, r.i;

     DECLARE @n int = (SELECT COUNT(*) FROM @ins);
     IF @n > 0
     BEGIN
       DECLARE @nContact int = (SELECT COUNT(*) FROM @ins WHERE sender_type = N'contact');
       DECLARE @first datetime2(0) = (SELECT MIN(dbo.fn_DateTimeCombine(sent_date, sent_time)) FROM @ins);
       DECLARE @last datetime2(0) = (SELECT MAX(dbo.fn_DateTimeCombine(sent_date, sent_time)) FROM @ins);
       DECLARE @lastByAgent bit = (SELECT TOP 1 CASE WHEN sender_type = N'contact' THEN 0 ELSE 1 END
                                   FROM @ins ORDER BY sent_date DESC, sent_time DESC, message_id DESC);
       DECLARE @firstContact datetime2(0) = (SELECT MIN(dbo.fn_DateTimeCombine(sent_date, sent_time)) FROM @ins WHERE sender_type = N'contact');
       DECLARE @lastContact datetime2(0) = (SELECT MAX(dbo.fn_DateTimeCombine(sent_date, sent_time)) FROM @ins WHERE sender_type = N'contact');

       UPDATE dbo.conversations SET
         message_count = message_count + @n,
         unread_count = CASE WHEN @lastByAgent = 1 THEN 0 ELSE unread_count + @nContact END,
         updated_date = CASE WHEN @last > dbo.fn_DateTimeCombine(updated_date, updated_time) THEN CONVERT(date, @last) ELSE updated_date END,
         updated_time = CASE WHEN @last > dbo.fn_DateTimeCombine(updated_date, updated_time) THEN CONVERT(time(0), @last) ELSE updated_time END,
         created_date = CASE WHEN @first < dbo.fn_DateTimeCombine(created_date, created_time) THEN CONVERT(date, @first) ELSE created_date END,
         created_time = CASE WHEN @first < dbo.fn_DateTimeCombine(created_date, created_time) THEN CONVERT(time(0), @first) ELSE created_time END
       WHERE conversation_id = @conv;

       IF @contact IS NOT NULL AND @nContact > 0
         UPDATE dbo.contacts SET
           total_messages = total_messages + @nContact,
           first_contact_date = CASE WHEN first_contact_date IS NULL OR @firstContact < dbo.fn_DateTimeCombine(first_contact_date, first_contact_time)
                                     THEN CONVERT(date, @firstContact) ELSE first_contact_date END,
           first_contact_time = CASE WHEN first_contact_date IS NULL OR @firstContact < dbo.fn_DateTimeCombine(first_contact_date, first_contact_time)
                                     THEN CONVERT(time(0), @firstContact) ELSE first_contact_time END,
           last_contact_date = CASE WHEN last_contact_date IS NULL OR @lastContact > dbo.fn_DateTimeCombine(last_contact_date, last_contact_time)
                                    THEN CONVERT(date, @lastContact) ELSE last_contact_date END,
           last_contact_time = CASE WHEN last_contact_date IS NULL OR @lastContact > dbo.fn_DateTimeCombine(last_contact_date, last_contact_time)
                                    THEN CONVERT(time(0), @lastContact) ELSE last_contact_time END
         WHERE contact_id = @contact;
     END
     COMMIT;
     SELECT message_id, external_id FROM @ins ORDER BY message_id;`,
    {
      lockName: `msg:${conversation.id}`,
      conv: conversation.id,
      contact: conversation.contactId || null,
      rows: JSON.stringify(rows),
      ...at("now", now),
    },
  );
  return result.rows.map((r) => ({ messageId: r.message_id, externalId: r.external_id }));
}

/** Store one message; `inserted` is false when its external id was already stored. */
async function insertMessage(conversation, message) {
  const [row] = await insertMessages(conversation, [message]);
  return row ? { inserted: true, messageId: row.messageId } : { inserted: false, messageId: null };
}

/**
 * Store a message the CRM sent, following the dedupe contract with the echo
 * webhook: with Meta's message id, a row the echo stored first is claimed
 * (its sender becomes the CRM user) instead of duplicated.
 */
async function storeCrmSend(conversation, { externalId, content, messageType, attachmentUrl, userId, sentAt }) {
  const res = await insertMessage(conversation, {
    externalId,
    senderType: "agent",
    senderUserId: userId,
    messageType,
    content,
    attachmentUrl,
    sentAt,
  });
  if (!res.inserted && externalId) {
    await db.query(
      `UPDATE dbo.message SET sender_type = N'agent', sender_user_id = @userId
       WHERE conversation_id = @conv AND external_id = @ext`,
      { conv: conversation.id, ext: externalId, userId: userId ? Number(userId) : null },
    );
  }
  return res;
}

/**
 * True when the CRM already stored `content` as a reply (sender_user_id set)
 * in these conversations within ±windowMs of `timestamp`.
 */
async function hasCrmTextCopy(conversationIds, content, timestamp, windowMs, excludeMessageId = null) {
  const ids = (conversationIds || []).filter(Boolean);
  if (ids.length === 0) return false;
  return Boolean(
    await db.scalar(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM dbo.message m
         WHERE m.conversation_id IN (SELECT CONVERT(int, value) FROM OPENJSON(@ids))
           AND m.sender_type = N'agent' AND m.sender_user_id IS NOT NULL
           AND m.content = @content COLLATE Latin1_General_100_BIN2
           AND dbo.fn_DateTimeCombine(m.sent_date, m.sent_time) BETWEEN @from AND @to
           AND m.message_id <> ISNULL(@exclude, 0)
       ) THEN 1 ELSE 0 END`,
      {
        ids: JSON.stringify(ids),
        content,
        from: new Date(timestamp.getTime() - windowMs - 1000),
        to: new Date(timestamp.getTime() + windowMs),
        exclude: excludeMessageId,
      },
    ),
  );
}

/**
 * Remove the copy of a message an echo stored without a CRM sender, once
 * the CRM's own row holds that text.
 * @returns {Promise<number>} rows removed
 */
async function deleteEchoCopy(conversationIds, externalId, messageId = null) {
  const ids = (conversationIds || []).filter(Boolean);
  if (ids.length === 0 || (!externalId && !messageId)) return 0;
  const removed = await db.scalar(
    `DECLARE @gone TABLE (conversation_id int);
     DELETE m OUTPUT DELETED.conversation_id INTO @gone
     FROM dbo.message m
     WHERE m.conversation_id IN (SELECT CONVERT(int, value) FROM OPENJSON(@ids))
       AND (@ext IS NULL OR m.external_id = @ext) AND (@mid IS NULL OR m.message_id = @mid)
       AND m.sender_type = N'agent' AND m.sender_user_id IS NULL;
     UPDATE c SET message_count = CASE WHEN c.message_count > g.n THEN c.message_count - g.n ELSE 0 END
     FROM dbo.conversations c JOIN (SELECT conversation_id, n = COUNT(*) FROM @gone GROUP BY conversation_id) g
       ON g.conversation_id = c.conversation_id;
     SELECT COUNT(*) FROM @gone;`,
    { ids: JSON.stringify(ids), ext: externalId || null, mid: messageId },
  );
  return Number(removed) || 0;
}

/** Which of these platform message ids a conversation already holds. */
async function existingExternalIds(conversationId, externalIds) {
  const ids = [...new Set((externalIds || []).filter(Boolean).map(String))];
  if (!conversationId || ids.length === 0) return new Set();
  const rows = (
    await db.query(
      `SELECT external_id FROM dbo.message
       WHERE conversation_id = @conv AND external_id IN (SELECT value FROM OPENJSON(@ids))`,
      { conv: conversationId, ids: JSON.stringify(ids) },
    )
  ).rows;
  return new Set(rows.map((r) => r.external_id));
}

/** True when any of these conversations holds at least one message. */
async function anyIn(conversationIds) {
  const ids = (conversationIds || []).filter(Boolean);
  if (ids.length === 0) return false;
  return Boolean(
    await db.scalar(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.message WHERE conversation_id IN (SELECT CONVERT(int, value) FROM OPENJSON(@ids)))
              THEN 1 ELSE 0 END`,
      { ids: JSON.stringify(ids) },
    ),
  );
}

/**
 * One page of a thread, oldest first, strictly before `before`. Timestamps
 * have one-second precision, so the page is extended to every message of
 * its oldest second: the next page, strictly before that second, then skips
 * nothing.
 * @returns {Promise<{messages: Array<object>, hasMore: boolean}>}
 */
async function page(conversationIds, { before = null, limit = 30 } = {}) {
  const ids = (conversationIds || []).filter(Boolean);
  if (ids.length === 0) return { messages: [], hasMore: false };
  const beforeDate = validDate(before);
  const rows = (
    await db.query(
      `DECLARE @c TABLE (id int PRIMARY KEY);
       INSERT @c SELECT DISTINCT CONVERT(int, value) FROM OPENJSON(@ids);
       DECLARE @edge_date date, @edge_time time(0);
       SELECT TOP 1 @edge_date = p.sent_date, @edge_time = p.sent_time FROM (
         SELECT TOP (@limit) m.sent_date, m.sent_time
         FROM dbo.message m
         WHERE m.conversation_id IN (SELECT id FROM @c)
           AND (@b_date IS NULL OR m.sent_date < @b_date OR (m.sent_date = @b_date AND m.sent_time < @b_time))
         ORDER BY m.sent_date DESC, m.sent_time DESC, m.message_id DESC
       ) p
       ORDER BY p.sent_date, p.sent_time;
       SELECT ${SELECT_API} ${FROM_API}
       WHERE m.conversation_id IN (SELECT id FROM @c)
         AND @edge_date IS NOT NULL
         AND (m.sent_date > @edge_date OR (m.sent_date = @edge_date AND m.sent_time >= @edge_time))
         AND (@b_date IS NULL OR m.sent_date < @b_date OR (m.sent_date = @b_date AND m.sent_time < @b_time))
       ORDER BY m.sent_date, m.sent_time, m.message_id;`,
      { ids: JSON.stringify(ids), limit, ...at("b", beforeDate) },
    )
  ).rows;
  return { messages: rows.map(toApiMessage), hasMore: rows.length >= limit };
}

/** The newest messages of a platform (debug endpoints), newest first. */
async function recentOfPlatform(platform, limit = 100) {
  const rows = (
    await db.query(
      `SELECT TOP (@limit) ${SELECT_API} ${FROM_API}
       WHERE c.platform = @platform
       ORDER BY m.sent_date DESC, m.sent_time DESC, m.message_id DESC`,
      { platform, limit },
    )
  ).rows;
  return rows.map((r) => ({ ...toApiMessage(r), platform: r.platform, conversationId: r.participant_external_id || r.conversation_external_id, sentBy: r.sender_user_id ? String(r.sender_user_id) : null, createdAt: r.created_at }));
}

/**
 * Mark a message read by its platform id (WhatsApp read receipts). Scoped to
 * the customer's conversations: external_id has no index of its own.
 */
async function markReadByExternalId(conversationIds, externalId) {
  const ids = (conversationIds || []).filter(Boolean);
  if (!externalId || ids.length === 0) return 0;
  return db.scalar(
    `UPDATE dbo.message SET is_read = 1
     WHERE conversation_id IN (SELECT CONVERT(int, value) FROM OPENJSON(@ids)) AND external_id = @ext AND is_read = 0;
     SELECT @@ROWCOUNT;`,
    { ids: JSON.stringify(ids), ext: externalId },
  );
}

module.exports = {
  messageTypeOf,
  toApiMessage,
  SELECT_API,
  FROM_API,
  insertMessages,
  insertMessage,
  storeCrmSend,
  hasCrmTextCopy,
  deleteEchoCopy,
  existingExternalIds,
  anyIn,
  page,
  recentOfPlatform,
  markReadByExternalId,
};
