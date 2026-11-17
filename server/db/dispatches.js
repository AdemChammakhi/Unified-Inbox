/**
 * dispatches.js — the admin's dispatch board on SQL Server (decision D13).
 *
 * A dispatch is a discussion an admin hands to an agent with a note, open
 * until the agent (or an admin or manager) marks it done, or an admin
 * cancels or reassigns it. The scripts have no table for it and are never
 * altered, so it is stored in rows that exist already:
 *
 *  - who is in charge: the conversation's lock holder and
 *    assigned_to_user_id (utils/dispatching.js assignConversation), the
 *    same move as an admin's reassignment from the Leads sheet;
 *  - the task itself: the custom field "dispatch" of the customer's
 *    contact, a JSON document {"seq": n, "items": [...]}, one item per
 *    dispatch, newest last. Each item names its platform and customer id,
 *    since one contact may hold several platform identities.
 *
 * A dispatch id is "<contact_id>.<seq>": the contact to read and the item
 * in it. Writes to one contact are serialized with sp_getapplock. Lists
 * read every contact's items with OPENJSON, filtered in SQL.
 */

"use strict";

const { db, tx, lockKey } = require("./sql");
const { contactIdFor, readCustomField, writeCustomField } = require("./contacts");

const FIELD = "dispatch";
/** Closed items kept per contact; open ones are always kept. */
const CLOSED_KEPT = 50;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const statusError = (status, message) => Object.assign(new Error(message), { status });

function parseDoc(value) {
  if (typeof value !== "string" || !value) return { seq: 0, items: [] };
  try {
    const doc = JSON.parse(value);
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.items)) return { seq: 0, items: [] };
    const maxSeq = doc.items.reduce((m, it) => Math.max(m, Number(it.seq) || 0), 0);
    return { seq: Math.max(Number(doc.seq) || 0, maxSeq), items: doc.items };
  } catch {
    return { seq: 0, items: [] };
  }
}

/** Keep every open item and the CLOSED_KEPT most recent closed ones. */
function trimmed(items) {
  const closed = items.filter((it) => it.status !== "open");
  const drop = new Set(closed.slice(0, Math.max(0, closed.length - CLOSED_KEPT)));
  return items.filter((it) => !drop.has(it));
}

function parseId(id) {
  if (typeof id !== "string") return null;
  const dot = id.lastIndexOf(".");
  if (dot < 0) return null;
  const contactId = id.slice(0, dot);
  const seq = Number(id.slice(dot + 1));
  if (!GUID.test(contactId) || !Number.isInteger(seq) || seq <= 0) return null;
  return { contactId: contactId.toLowerCase(), seq };
}

const isId = (id) => parseId(id) !== null;

/** Read-modify-write one contact's document inside a transaction. */
async function withDoc(t, contactId, change) {
  await lockKey(t, `dispatch:${contactId}`);
  const doc = parseDoc(await readCustomField(t, contactId, FIELD));
  const out = change(doc);
  doc.items = trimmed(doc.items);
  await writeCustomField(t, contactId, FIELD, JSON.stringify(doc));
  return out;
}

const nowIso = () => new Date().toISOString();

/**
 * Open a dispatch for (platform, customerId). The customer's open dispatch
 * on that platform, if any, is cancelled first: one open per customer.
 * @returns {Promise<string>} the new dispatch id
 */
async function create({ platform, customerId, agentId, byId, note }) {
  return tx(async (t) => {
    const contactId = await contactIdFor(t, platform, customerId);
    if (!contactId) throw statusError(404, "Client introuvable.");
    const cid = String(contactId).toLowerCase();
    return withDoc(t, cid, (doc) => {
      const now = nowIso();
      for (const it of doc.items) {
        if (it.status === "open" && it.platform === platform && it.customerId === customerId) {
          Object.assign(it, { status: "cancelled", closedAt: now, closedById: String(byId) });
        }
      }
      doc.seq += 1;
      doc.items.push({
        seq: doc.seq,
        platform,
        customerId,
        agentId: String(agentId),
        dispatchedById: String(byId),
        dispatchedAt: now,
        note: note || "",
        status: "open",
        firstReplyAt: null,
        closedAt: null,
        closedById: null,
      });
      return `${cid}.${doc.seq}`;
    });
  });
}

/**
 * Close an open dispatch as done or cancelled. `allow(item)` may refuse
 * (returns a message): the route's permission check, made under the lock.
 * @returns {Promise<object>} the item as it was before closing
 */
async function close(id, { status, byId, allow }) {
  const ref = parseId(id);
  if (!ref) throw statusError(400, "Dispatch invalide.");
  return tx((t) =>
    withDoc(t, ref.contactId, (doc) => {
      const it = doc.items.find((x) => Number(x.seq) === ref.seq);
      if (!it) throw statusError(404, "Dispatch introuvable.");
      if (it.status !== "open") throw statusError(409, "Ce dispatch est déjà clos.");
      const refusal = allow ? allow(it) : null;
      if (refusal) throw statusError(403, refusal);
      const before = { ...it };
      Object.assign(it, { status, closedAt: nowIso(), closedById: String(byId) });
      return before;
    }),
  );
}

/** One open item, or a status error (for reassign, before the new one). */
async function openItem(id) {
  const ref = parseId(id);
  if (!ref) throw statusError(400, "Dispatch invalide.");
  const doc = parseDoc(
    await db.scalar(
      `SELECT field_value FROM dbo.contact_custom_fields WHERE contact_id = @contactId AND field_key = @field`,
      { contactId: ref.contactId, field: FIELD },
    ),
  );
  const it = doc.items.find((x) => Number(x.seq) === ref.seq);
  if (!it) throw statusError(404, "Dispatch introuvable.");
  if (it.status !== "open") throw statusError(409, "Ce dispatch est déjà clos.");
  return it;
}

/**
 * The first reply of the dispatched agent: stamp firstReplyAt on the open
 * dispatch of any of `customerIds` on `platform` held by `userId`.
 * @returns {Promise<number>} items stamped
 */
async function noteFirstReply(platform, customerIds, userId) {
  const ids = [...new Set((customerIds || []).filter(Boolean).map(String))];
  if (ids.length === 0 || !userId) return 0;
  const rows = (
    await db.query(
      `SELECT DISTINCT f.contact_id
       FROM dbo.contact_custom_fields f
       CROSS APPLY OPENJSON(CASE WHEN ISJSON(f.field_value) = 1 THEN f.field_value END, '$.items')
         WITH (platform nvarchar(20) '$.platform', customerId nvarchar(255) '$.customerId',
               agentId nvarchar(20) '$.agentId', status nvarchar(20) '$.status',
               firstReplyAt nvarchar(40) '$.firstReplyAt') j
       WHERE f.field_key = @field AND j.status = N'open' AND j.platform = @platform
         AND j.agentId = @agentId AND j.firstReplyAt IS NULL
         AND j.customerId IN (SELECT value FROM OPENJSON(@ids))`,
      { field: FIELD, platform, agentId: String(userId), ids: JSON.stringify(ids) },
    )
  ).rows;
  let stamped = 0;
  for (const r of rows) {
    stamped += await tx((t) =>
      withDoc(t, String(r.contact_id).toLowerCase(), (doc) => {
        let n = 0;
        for (const it of doc.items) {
          if (
            it.status === "open" &&
            it.platform === platform &&
            ids.includes(it.customerId) &&
            it.agentId === String(userId) &&
            !it.firstReplyAt
          ) {
            it.firstReplyAt = nowIso();
            n += 1;
          }
        }
        return n;
      }),
    );
  }
  return stamped;
}

/**
 * Dispatches with their names, newest data from SQL: status "open", "done",
 * "cancelled" or null for all; optional platform and agent filters.
 * Open ones oldest first; closed ones most recently closed first.
 */
async function list({ status = "open", platform = null, agentId = null, limit = 1000, ref = null } = {}) {
  const rows = (
    await db.query(
      `SELECT TOP (@limit)
              f.contact_id, j.seq, j.platform, j.customerId, j.agentId, j.dispatchedById,
              j.dispatchedAt, j.note, j.status, j.firstReplyAt, j.closedAt,
              agent_first = ua.first_name, agent_last = ua.last_name, agent_active = ua.is_active,
              by_first = ub.first_name, by_last = ub.last_name,
              customer_name = cn.participant_name
       FROM dbo.contact_custom_fields f
       CROSS APPLY OPENJSON(CASE WHEN ISJSON(f.field_value) = 1 THEN f.field_value END, '$.items')
         WITH (seq int '$.seq', platform nvarchar(20) '$.platform', customerId nvarchar(255) '$.customerId',
               agentId nvarchar(20) '$.agentId', dispatchedById nvarchar(20) '$.dispatchedById',
               dispatchedAt nvarchar(40) '$.dispatchedAt', note nvarchar(400) '$.note',
               status nvarchar(20) '$.status', firstReplyAt nvarchar(40) '$.firstReplyAt',
               closedAt nvarchar(40) '$.closedAt') j
       LEFT JOIN dbo.users ua ON ua.user_id = TRY_CONVERT(int, j.agentId)
       LEFT JOIN dbo.users ub ON ub.user_id = TRY_CONVERT(int, j.dispatchedById)
       OUTER APPLY (
         SELECT TOP 1 c.participant_name FROM dbo.conversations c
         WHERE c.platform = CASE WHEN j.platform = N'telephone' THEN N'call' ELSE j.platform END
           AND (c.participant_external_id = j.customerId OR c.external_id = j.customerId)
         ORDER BY CASE WHEN c.deleted_date IS NULL THEN 0 ELSE 1 END, c.conversation_id
       ) cn
       WHERE f.field_key = @field
         AND (@contactId IS NULL OR f.contact_id = TRY_CONVERT(uniqueidentifier, @contactId))
         AND (@seq IS NULL OR j.seq = @seq)
         AND (@status IS NULL OR j.status = @status)
         AND (@platform IS NULL OR j.platform = @platform)
         AND (@agentId IS NULL OR j.agentId = @agentId)
       ORDER BY
         CASE WHEN @status = N'open' THEN j.dispatchedAt END ASC,
         j.closedAt DESC, j.dispatchedAt DESC`,
      {
        field: FIELD,
        limit: Math.max(1, Math.min(Number(limit) || 1000, 5000)),
        status: status || null,
        platform: platform || null,
        agentId: agentId ? String(agentId) : null,
        contactId: ref ? ref.contactId : null,
        seq: ref ? ref.seq : null,
      },
    )
  ).rows;
  return rows.map(toPublic);
}

/** One dispatch by id, in the list's shape (null when absent). */
async function byId(id) {
  const ref = parseId(id);
  if (!ref) return null;
  const [found] = await list({ status: null, limit: 1, ref });
  return found || null;
}

const name = (first, last) => (first ? `${first} ${last || ""}`.trim() : "");
const asDate = (iso) => (iso ? new Date(iso) : null);

function toPublic(r) {
  return {
    id: `${String(r.contact_id).toLowerCase()}.${r.seq}`,
    platform: r.platform,
    customerId: r.customerId,
    customerName: r.customer_name && r.customer_name !== "Unknown" ? r.customer_name : "",
    agentId: r.agentId || null,
    agentName: name(r.agent_first, r.agent_last),
    agentActive: r.agent_active !== false,
    dispatchedById: r.dispatchedById || null,
    dispatchedByName: name(r.by_first, r.by_last),
    dispatchedAt: asDate(r.dispatchedAt),
    note: r.note || "",
    status: r.status,
    firstReplyAt: asDate(r.firstReplyAt),
    closedAt: asDate(r.closedAt),
  };
}

module.exports = {
  FIELD,
  isId,
  create,
  close,
  openItem,
  noteFirstReply,
  list,
  byId,
  // for tests
  parseDoc,
  trimmed,
};
