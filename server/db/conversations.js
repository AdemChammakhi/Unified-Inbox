/**
 * conversations.js — one dbo.conversations row per customer per platform.
 *
 * Keys (CLAUDE.md §6: a conversation has no single stable id):
 *  - participant_external_id is the CUSTOMER id (IGSID, PSID, WhatsApp number,
 *    email address, "appel-<digits>" for a prospect who phoned), the only id
 *    both inbox list shapes share;
 *  - external_id is the platform's own conversation id: Meta's thread id
 *    (t_…) once it is known, the customer id until then. It is unique per
 *    platform, so a thread id resolves to its customer without any mapping
 *    table; linkThreads() records it when a Graph list reveals it.
 * Every lookup accepts either key (findByKeys / resolve).
 *
 * Platforms: the API's names, with one alias — "telephone", the leads
 * recorded from an incoming call, is stored as the scripts' "call"
 * (CK_conv_platform); every function takes and returns the API name.
 *
 * The dossier lives on the row and on the customer's contact
 * (constants/pipeline.js, decision D10):
 *  - the pipeline stage as its (Étape, Qualification) pair in
 *    classification_id + qualification_id, each Qualification change
 *    appended to conversation_qualification_history, and every pair in use
 *    registered in classification_qualification_matrix (E27);
 *  - the typologie in motif_id, the RDV date in appointment_*;
 *  - the fields the scripts have no column for — invoice reference, PAX,
 *    priority flag, comment, where the RDV takes place and who receives the
 *    customer — as one JSON value, the "dossier" custom field of the
 *    customer's contact (contact_custom_fields, like the frein);
 *  - the phone number an agent records in contacts.phone.
 * The lock is locked_by_user_id, mirrored in assigned_to_user_id for the
 * warehouse. A phone lead's calls are dbo.call_log rows on its conversation.
 *
 * Deleting a conversation removes its messages and history and resets its
 * dossier, but keeps the row with deleted_date set (the warehouse flags it,
 * and the unique external_id stays reserved); new activity from the customer
 * reopens it.
 */

"use strict";

const { db, tx, at, lockKey, jsonList } = require("./sql");
const { refs, stageOf, pairOf, typologyOf } = require("./reference");
const { channelIdOf } = require("./channels");
const contacts = require("./contacts");
const { isStage, isTypology, DEFAULT_STAGE } = require("../constants/pipeline");

const CALL_PLATFORM = contacts.CALL_PLATFORM; // "telephone"
const DOSSIER_FIELD = "dossier";

/** API platform → stored platform, and back. */
const dbPlatform = (platform) => (platform === CALL_PLATFORM ? "call" : platform);
const apiPlatform = (platform) => (platform === "call" ? CALL_PLATFORM : platform);

const COLUMNS = `
  c.conversation_id, c.platform, c.external_id, c.participant_external_id, c.participant_name,
  c.participant_avatar, c.contact_id, c.channel_id, c.status, c.classification_id, c.qualification_id,
  c.motif_id, c.campaign_id, c.assigned_to_user_id, c.classified_by_user_id, c.locked_by_user_id,
  c.message_count, c.unread_count,
  appointment_at = dbo.fn_DateTimeCombine(c.appointment_date, c.appointment_time),
  classified_at = dbo.fn_DateTimeCombine(c.classified_date, c.classified_time),
  locked_at = dbo.fn_DateTimeCombine(c.locked_date, c.locked_time),
  created_at = dbo.fn_DateTimeCombine(c.created_date, c.created_time),
  updated_at = dbo.fn_DateTimeCombine(c.updated_date, c.updated_time),
  deleted_at = dbo.fn_DateTimeCombine(c.deleted_date, c.deleted_time)`;

/** Graph thread ids are conversations, never people (email has no threads). */
const isThreadId = (platform, id) => platform !== "email" && typeof id === "string" && /^t_/i.test(id);

function toConversation(row) {
  if (!row) return null;
  return {
    id: row.conversation_id,
    platform: apiPlatform(row.platform),
    externalId: row.external_id,
    customerId: row.participant_external_id || null,
    /** The key every map and list uses: the customer, else the thread. */
    key: row.participant_external_id || row.external_id,
    name: row.participant_name,
    avatar: row.participant_avatar,
    contactId: row.contact_id,
    channelId: row.channel_id,
    campaignId: row.campaign_id,
    stage: stageOf(row.classification_id, row.qualification_id),
    typologie: typologyOf(row.motif_id),
    qualificationId: row.qualification_id,
    motifId: row.motif_id,
    classificationId: row.classification_id,
    appointmentAt: row.appointment_at || null,
    classifiedBy: row.classified_by_user_id ? String(row.classified_by_user_id) : null,
    classifiedAt: row.classified_at || null,
    lockedBy: row.locked_by_user_id ? String(row.locked_by_user_id) : null,
    lockedAt: row.locked_at || null,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

const cleanKeys = (keys) =>
  [...new Set((keys || []).filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim()))];

/**
 * Record an (Étape, Qualification) pair in classification_qualification_matrix
 * when it is new: the table lists the pairs the data holds, filled by the
 * scripts' lead import for its rows and by the app for its own.
 */
async function registerPair(t, classificationId, qualificationId) {
  await t.query(
    `IF NOT EXISTS (SELECT 1 FROM dbo.classification_qualification_matrix
                    WHERE classification_id = @cls AND qualification_id = @qual)
       INSERT dbo.classification_qualification_matrix (classification_id, qualification_id) VALUES (@cls, @qual);`,
    { cls: classificationId, qual: qualificationId },
  );
}

/**
 * Rows reachable through any of `keys` (external or customer id), best
 * first: a customer-id match before a thread-id match, then the oldest row.
 */
async function findByKeys(platform, keys, { includeDeleted = false, runner = db } = {}) {
  const list = cleanKeys(keys);
  if (list.length === 0) return [];
  const rows = (
    await runner.query(
      `SELECT ${COLUMNS}
       FROM dbo.conversations c
       WHERE c.platform = @platform
         AND (c.external_id IN (SELECT value FROM OPENJSON(@keys))
              OR c.participant_external_id IN (SELECT value FROM OPENJSON(@keys)))
         AND (@includeDeleted = 1 OR c.deleted_date IS NULL)
       ORDER BY CASE WHEN c.participant_external_id IN (SELECT value FROM OPENJSON(@keys)) THEN 0 ELSE 1 END,
                c.conversation_id`,
      { platform: dbPlatform(platform), keys: jsonList(list), includeDeleted: includeDeleted ? 1 : 0 },
    )
  ).rows;
  return rows.map(toConversation);
}

/** The conversation behind any of `keys`, or null. */
async function resolve(platform, keys, options) {
  return (await findByKeys(platform, keys, options))[0] || null;
}

async function byId(conversationId, runner = db) {
  return toConversation(
    await runner.one(`SELECT ${COLUMNS} FROM dbo.conversations c WHERE c.conversation_id = @id`, {
      id: conversationId,
    }),
  );
}

/**
 * Move everything of conversation `fromId` onto `intoId` and drop `fromId`.
 * Only for the rare row created from a thread id before its customer was
 * known. The richer dossier wins: the target keeps its own unless it is
 * still at the defaults.
 */
async function mergeInto(t, intoId, fromId) {
  const d = refs().defaults;
  await t.query(
    `UPDATE dbo.message SET conversation_id = @intoId WHERE conversation_id = @fromId;
     UPDATE dbo.conversation_qualification_history SET conversation_id = @intoId WHERE conversation_id = @fromId;
     UPDATE dbo.call_log SET conversation_id = @intoId WHERE conversation_id = @fromId;
     DELETE dbo.conversation_agent_unread WHERE conversation_id = @fromId;
     UPDATE i SET
       qualification_id = CASE WHEN i.qualification_id = @defQual AND i.classification_id = @defCls THEN f.qualification_id ELSE i.qualification_id END,
       classification_id = CASE WHEN i.qualification_id = @defQual AND i.classification_id = @defCls THEN f.classification_id ELSE i.classification_id END,
       motif_id = CASE WHEN i.motif_id = @defMotif THEN f.motif_id ELSE i.motif_id END,
       appointment_date = COALESCE(i.appointment_date, f.appointment_date),
       appointment_time = CASE WHEN i.appointment_date IS NULL THEN f.appointment_time ELSE i.appointment_time END,
       locked_by_user_id = COALESCE(i.locked_by_user_id, f.locked_by_user_id),
       locked_date = CASE WHEN i.locked_by_user_id IS NULL THEN f.locked_date ELSE i.locked_date END,
       locked_time = CASE WHEN i.locked_by_user_id IS NULL THEN f.locked_time ELSE i.locked_time END,
       assigned_to_user_id = COALESCE(i.assigned_to_user_id, f.assigned_to_user_id),
       campaign_id = COALESCE(i.campaign_id, f.campaign_id),
       message_count = i.message_count + f.message_count
     FROM dbo.conversations i CROSS JOIN dbo.conversations f
     WHERE i.conversation_id = @intoId AND f.conversation_id = @fromId;
     DELETE dbo.conversations WHERE conversation_id = @fromId;`,
    { intoId, fromId, defQual: d.qualificationId, defCls: d.classificationId, defMotif: d.motifId },
  );
}

/**
 * Find or create the conversation of one customer, refreshing what was
 * learned about them (a real name, an avatar, the thread id). Reopens a
 * deleted conversation. Serialized per customer with an application lock:
 * the schema has no unique key on participant_external_id.
 *
 * @param {object} p
 * @param {string} p.platform
 * @param {string} p.customerId  the customer's platform id
 * @param {string} [p.name]      display name (placeholders are ignored)
 * @param {string} [p.username]
 * @param {string} [p.avatar]
 * @param {string} [p.threadId]  Meta's thread id, when known
 * @param {Date}   [p.firstSeenAt] creation time when the row is new (defaults to now)
 * @returns {Promise<object>} the conversation (toConversation shape)
 */
async function ensureForCustomer({ platform, customerId, name, username, avatar, threadId, firstSeenAt }) {
  const stored = dbPlatform(platform);
  const customer = contacts.fit(customerId, 255);
  if (!customer) throw new Error("ensureForCustomer needs a customer id");
  const thread = threadId && threadId !== customer ? contacts.fit(threadId, 255) : null;
  const channelId = await channelIdOf(stored);
  const d = refs().defaults;
  const realName = !contacts.isPlaceholderName(name, customer)
    ? contacts.fit(name, 255)
    : !contacts.isPlaceholderName(username, customer)
      ? contacts.fit(username, 255)
      : null;
  const avatarUrl = contacts.url500(avatar);
  const now = new Date();

  const conversationId = await tx(async (t) => {
    await lockKey(t, `conv:${stored}:${customer}`);
    let row = await t.one(
      `SELECT TOP 1 c.conversation_id, c.external_id, c.participant_external_id, c.contact_id
       FROM dbo.conversations c
       WHERE c.platform = @platform AND (c.participant_external_id = @customer OR c.external_id = @customer)
       ORDER BY CASE WHEN c.participant_external_id = @customer THEN 0 ELSE 1 END, c.conversation_id`,
      { platform: stored, customer },
    );
    // A row created from the thread id alone, before the customer was known
    let threadRow = null;
    if (thread) {
      threadRow = await t.one(
        `SELECT c.conversation_id, c.participant_external_id FROM dbo.conversations c
         WHERE c.platform = @platform AND c.external_id = @thread`,
        { platform: stored, thread },
      );
      if (threadRow && row && threadRow.conversation_id !== row.conversation_id && !threadRow.participant_external_id) {
        await mergeInto(t, row.conversation_id, threadRow.conversation_id);
        threadRow = null;
      } else if (threadRow && !row && !threadRow.participant_external_id) {
        row = { ...threadRow, external_id: thread, contact_id: null };
      }
    }

    const { contactId } = contacts.IDENTITY_PLATFORMS.has(stored)
      ? await contacts.ensureIdentity(t, { platform: stored, externalId: customer, name, username, avatar, seenAt: now })
      : { contactId: null };

    if (row) {
      const linkThread =
        thread && row.external_id === customer && !threadRow ? thread : null;
      await t.query(
        `UPDATE dbo.conversations SET
           participant_external_id = COALESCE(participant_external_id, @customer),
           contact_id = COALESCE(contact_id, @contactId),
           participant_name = COALESCE(@realName, participant_name),
           participant_avatar = COALESCE(@avatar, participant_avatar),
           external_id = COALESCE(@linkThread, external_id),
           deleted_date = NULL, deleted_time = NULL
         WHERE conversation_id = @id`,
        { id: row.conversation_id, customer, contactId, realName, avatar: avatarUrl, linkThread },
      );
      return row.conversation_id;
    }

    const created = firstSeenAt instanceof Date && !Number.isNaN(firstSeenAt.getTime()) && firstSeenAt < now ? firstSeenAt : now;
    const id = await t.scalar(
      `INSERT dbo.conversations (platform, external_id, channel_id, contact_id, participant_name, participant_avatar,
                                 participant_external_id, status, classification_id, qualification_id, motif_id,
                                 unread_count, message_count, created_date, created_time, updated_date, updated_time)
       OUTPUT INSERTED.conversation_id
       VALUES (@platform, @externalId, @channelId, @contactId, @name, @avatar, @customer, N'open',
               @cls, @qual, @motif, 0, 0, @created_date, @created_time, @created_date, @created_time)`,
      {
        platform: stored,
        externalId: thread && !threadRow ? thread : customer,
        channelId,
        contactId,
        name: realName || (stored === "email" ? customer : "Unknown"),
        avatar: avatarUrl,
        customer,
        cls: d.classificationId,
        qual: d.qualificationId,
        motif: d.motifId,
        ...at("created", created),
      },
    );
    await t.query(
      `INSERT dbo.conversation_qualification_history (conversation_id, qualification_id, changed_by_user_id, changed_date, changed_time)
       VALUES (@id, @qual, NULL, @created_date, @created_time);
       IF @contactId IS NOT NULL
         UPDATE dbo.contacts SET total_conversations = total_conversations + 1 WHERE contact_id = @contactId;`,
      { id, qual: d.qualificationId, contactId, ...at("created", created) },
    );
    await registerPair(t, d.classificationId, d.qualificationId);
    return id;
  });
  return byId(conversationId);
}

/**
 * A conversation keyed by a thread id whose customer is unknown (the inbox
 * sent only `t_…`). Found or created without a customer; ensureForCustomer
 * adopts it once the customer shows up with the same thread id.
 */
async function ensureForThread({ platform, threadId }) {
  const stored = dbPlatform(platform);
  const thread = contacts.fit(threadId, 255);
  const found = await resolve(platform, [thread], { includeDeleted: true });
  if (found) {
    if (found.deletedAt) {
      await db.query(
        `UPDATE dbo.conversations SET deleted_date = NULL, deleted_time = NULL WHERE conversation_id = @id`,
        { id: found.id },
      );
      return byId(found.id);
    }
    return found;
  }
  const channelId = await channelIdOf(stored);
  const d = refs().defaults;
  const id = await tx(async (t) => {
    await lockKey(t, `conv:${stored}:${thread}`);
    const again = await t.scalar(
      `SELECT conversation_id FROM dbo.conversations WHERE platform = @platform AND external_id = @thread`,
      { platform: stored, thread },
    );
    if (again) return again;
    const newId = await t.scalar(
      `INSERT dbo.conversations (platform, external_id, channel_id, participant_name, status, classification_id,
                                 qualification_id, motif_id, unread_count, message_count,
                                 created_date, created_time, updated_date, updated_time)
       OUTPUT INSERTED.conversation_id
       VALUES (@platform, @thread, @channelId, N'Unknown', N'open', @cls, @qual, @motif, 0, 0,
               @now_date, @now_time, @now_date, @now_time)`,
      { platform: stored, thread, channelId, cls: d.classificationId, qual: d.qualificationId, motif: d.motifId, ...at("now", new Date()) },
    );
    await t.query(
      `INSERT dbo.conversation_qualification_history (conversation_id, qualification_id, changed_by_user_id, changed_date, changed_time)
       VALUES (@id, @qual, NULL, @now_date, @now_time)`,
      { id: newId, qual: d.qualificationId, ...at("now", new Date()) },
    );
    await registerPair(t, d.classificationId, d.qualificationId);
    return newId;
  });
  return byId(id);
}

// ─── Incoming calls ──────────────────────────────────────────────────────────

/**
 * The lead of a prospect who phoned the agency ("Appel entrant"): found or
 * created on the "telephone" platform under customer id "appel-<digits>",
 * with its contact (the one whose number this is, else a new one) and one
 * dbo.call_log row per call. A second call from the same number lands on
 * the same lead. A new lead starts at "Contact établi": the agent has just
 * spoken to the customer.
 *
 * @param {object} p
 * @param {string} p.digits   the number as dialled, digits only (country code included)
 * @param {string} p.name
 * @param {string} p.phone    the number as shown ("+216 98 123 456")
 * @param {string} [p.email]
 * @param {string|number} [p.userId]  the agent recording the call
 * @returns {Promise<{conversation: object, created: boolean, callCount: number}>}
 */
async function ensureForCall({ digits, name, phone, email, userId }) {
  const customer = `appel-${String(digits).replace(/\D/g, "")}`;
  const channelId = await channelIdOf("call");
  const now = new Date();
  const result = await tx(async (t) => {
    await lockKey(t, `conv:call:${customer}`);
    const contactId = await contacts.ensureByPhone(t, { phone: `+${String(digits).replace(/\D/g, "")}`, name, email, seenAt: now });
    let row = await t.one(
      `SELECT TOP 1 conversation_id FROM dbo.conversations
       WHERE platform = N'call' AND participant_external_id = @customer ORDER BY conversation_id`,
      { customer },
    );
    let created = false;
    if (row) {
      await t.query(
        `UPDATE dbo.conversations SET participant_name = @name, contact_id = COALESCE(contact_id, @contactId),
           updated_date = @now_date, updated_time = @now_time, deleted_date = NULL, deleted_time = NULL
         WHERE conversation_id = @id`,
        { id: row.conversation_id, name: contacts.fit(name, 255) || "Unknown", contactId, ...at("now", now) },
      );
    } else {
      const pair = pairOf("contact_etabli");
      const d = refs().defaults;
      const id = await t.scalar(
        `INSERT dbo.conversations (platform, external_id, channel_id, contact_id, participant_name, participant_external_id,
                                   status, classification_id, qualification_id, motif_id, classified_by_user_id,
                                   classified_date, classified_time, unread_count, message_count,
                                   created_date, created_time, updated_date, updated_time)
         OUTPUT INSERTED.conversation_id
         VALUES (N'call', @customer, @channelId, @contactId, @name, @customer, N'open', @cls, @qual, @motif, @userId,
                 @now_date, @now_time, 0, 0, @now_date, @now_time, @now_date, @now_time)`,
        {
          customer, channelId, contactId, name: contacts.fit(name, 255) || "Unknown",
          cls: pair.classificationId, qual: pair.qualificationId, motif: d.motifId,
          userId: userId ? Number(userId) : null, ...at("now", now),
        },
      );
      await t.query(
        `INSERT dbo.conversation_qualification_history (conversation_id, qualification_id, changed_by_user_id, changed_date, changed_time)
         VALUES (@id, @qual, @userId, @now_date, @now_time);
         UPDATE dbo.contacts SET total_conversations = total_conversations + 1 WHERE contact_id = @contactId;`,
        { id, qual: pair.qualificationId, userId: userId ? Number(userId) : null, contactId, ...at("now", now) },
      );
      await registerPair(t, pair.classificationId, pair.qualificationId);
      row = { conversation_id: id };
      created = true;
    }
    // The call itself: an answered inbound call, recorded by the CRM
    await t.query(
      `INSERT dbo.call_log (channel_id, conversation_id, source_number, ring_group, destination_number, src_channel_ref,
                            dst_channel_ref, cost_center, call_status, duration_seconds, direction, is_answered_flag,
                            call_date, call_time, source_channel)
       VALUES (@channelId, @id, @source, NULL, N'agence', @ref, NULL, NULL, N'ANSWERED', 0, N'inbound', 1,
               @now_date, @now_time, N'crm')`,
      {
        channelId, id: row.conversation_id, source: contacts.fit(phone, 30) || String(digits).slice(0, 30),
        // UX_call_log_natural is (call_date, call_time, src_channel_ref): two calls
        // recorded within the same second need distinct references
        ref: `CRM/${row.conversation_id}-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ...at("now", now),
      },
    );
    const callCount = await t.scalar(`SELECT COUNT(*) FROM dbo.call_log WHERE conversation_id = @id`, { id: row.conversation_id });
    return { id: row.conversation_id, created, callCount: Number(callCount) || 1 };
  });
  return { conversation: await byId(result.id), created: result.created, callCount: result.callCount };
}

/**
 * The calls of phone leads: Map conversation id → { count, firstAt, lastAt }.
 */
async function callStats(conversationIds) {
  const ids = (conversationIds || []).filter(Boolean);
  const out = new Map();
  if (ids.length === 0) return out;
  const rows = (
    await db.query(
      `SELECT conversation_id, n = COUNT(*),
              first_at = MIN(dbo.fn_DateTimeCombine(call_date, call_time)),
              last_at = MAX(dbo.fn_DateTimeCombine(call_date, call_time))
       FROM dbo.call_log WHERE conversation_id IN (SELECT CONVERT(int, value) FROM OPENJSON(@ids))
       GROUP BY conversation_id`,
      { ids: JSON.stringify(ids) },
    )
  ).rows;
  for (const r of rows) out.set(r.conversation_id, { count: Number(r.n), firstAt: r.first_at, lastAt: r.last_at });
  return out;
}

/** Every phone lead (platform "telephone"), newest activity first. */
async function callLeads(limit = 5000) {
  const rows = (
    await db.query(
      `SELECT TOP (@limit) ${COLUMNS}, contact_phone = ct.phone, contact_email = ct.email
       FROM dbo.conversations c LEFT JOIN dbo.contacts ct ON ct.contact_id = c.contact_id
       WHERE c.platform = N'call' AND c.deleted_date IS NULL
       ORDER BY c.updated_date DESC, c.updated_time DESC, c.conversation_id DESC`,
      { limit },
    )
  ).rows;
  return rows.map((r) => ({ ...toConversation(r), contactPhone: r.contact_phone, contactEmail: r.contact_email }));
}

/**
 * Record Meta thread ids learned from a Graph list: each customer row still
 * keyed by the customer id takes its thread id (unless another row holds it),
 * and a thread-only row learns its customer. Best effort, one statement each.
 * @param {string} platform
 * @param {Array<{customerId: string, threadId: string}>} pairs
 */
async function linkThreads(platform, pairs) {
  const byThread = new Map();
  for (const p of pairs || []) {
    const customer = contacts.fit(p?.customerId, 255);
    const thread = contacts.fit(p?.threadId, 255);
    if (!customer || !thread || customer === thread || isThreadId(platform, customer)) continue;
    byThread.set(thread, customer);
  }
  if (byThread.size === 0) return;
  const json = JSON.stringify([...byThread].map(([t, c]) => ({ t, c })));
  await db.query(
    `UPDATE c SET external_id = p.t
     FROM dbo.conversations c
     JOIN OPENJSON(@pairs) WITH (t nvarchar(255) '$.t', c nvarchar(255) '$.c') p ON c.participant_external_id = p.c
     WHERE c.platform = @platform AND c.external_id = c.participant_external_id
       AND NOT EXISTS (SELECT 1 FROM dbo.conversations x WHERE x.platform = @platform AND x.external_id = p.t);
     UPDATE c SET participant_external_id = p.c
     FROM dbo.conversations c
     JOIN OPENJSON(@pairs) WITH (t nvarchar(255) '$.t', c nvarchar(255) '$.c') p ON c.external_id = p.t
     WHERE c.platform = @platform AND c.participant_external_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.conversations x WHERE x.platform = @platform AND x.participant_external_id = p.c);`,
    { platform: dbPlatform(platform), pairs: json },
  );
}

/** Refresh the stored name / avatar of a customer (profile healing). */
async function updateProfile(platform, customerId, { name, avatar }) {
  const realName = !contacts.isPlaceholderName(name, customerId) ? contacts.fit(name, 255) : null;
  const avatarUrl = contacts.url500(avatar);
  if (!realName && !avatarUrl) return;
  await db.query(
    `UPDATE dbo.conversations
       SET participant_name = COALESCE(@realName, participant_name),
           participant_avatar = COALESCE(@avatar, participant_avatar)
     WHERE platform = @platform AND participant_external_id = @customer;
     UPDATE dbo.contact_platform_identities
       SET name = COALESCE(@realName, name), avatar = COALESCE(@avatar, avatar)
     WHERE platform = @platform AND external_id = @customer;
     UPDATE ct SET
       display_name = CASE WHEN @realName IS NOT NULL
                            AND (ct.display_name = N'Unknown' OR ct.display_name = @customer
                                 OR (ct.display_name LIKE N'User %' AND LEN(ct.display_name) <= 9)
                                 OR ct.display_name NOT LIKE N'%[^0-9]%')
                           THEN @realName ELSE ct.display_name END,
       avatar = COALESCE(@avatar, ct.avatar)
     FROM dbo.contacts ct
     JOIN dbo.contact_platform_identities i ON i.contact_id = ct.contact_id
     WHERE i.platform = @platform AND i.external_id = @customer;`,
    { platform: dbPlatform(platform), customer: String(customerId), realName, avatar: avatarUrl },
  );
}

/**
 * Customers of a platform whose stored name is still a placeholder, most
 * recently active first (for the Instagram profile healer).
 */
async function placeholderCustomers(platform, limit = 10) {
  const rows = (
    await db.query(
      `SELECT TOP (@limit) c.participant_external_id
       FROM dbo.conversations c
       WHERE c.platform = @platform AND c.deleted_date IS NULL AND c.participant_external_id IS NOT NULL
         AND (c.participant_name = N'Unknown' OR c.participant_name = c.participant_external_id
              OR (c.participant_name LIKE N'User %' AND LEN(c.participant_name) <= 9)
              OR c.participant_name NOT LIKE N'%[^0-9]%')
       ORDER BY c.updated_date DESC, c.updated_time DESC`,
      { platform: dbPlatform(platform), limit },
    )
  ).rows;
  return rows.map((r) => r.participant_external_id);
}

// ─── Lists ───────────────────────────────────────────────────────────────────

/**
 * The most recently active conversations of a platform, each with its
 * newest message, newest first.
 * @returns {Promise<Array<object>>} conversation + lastMessage
 *   { text, senderType, time, messageType, hasMedia, senderUserId, senderUserName }
 */
async function recentWithLastMessage(platform, limit = 100) {
  const rows = (
    await db.query(
      `SELECT TOP (@limit) ${COLUMNS},
              lm_content = LEFT(lm.content, 500), lm_sender_type = lm.sender_type, lm_sender_user_id = lm.sender_user_id,
              lm_type = lm.message_type, lm_has_media = CASE WHEN lm.attachment_url IS NULL THEN 0 ELSE 1 END,
              lm_at = dbo.fn_DateTimeCombine(lm.sent_date, lm.sent_time),
              lm_user_name = LTRIM(RTRIM(CONCAT(lu.first_name, N' ', lu.last_name)))
       FROM dbo.conversations c
       CROSS APPLY (
         SELECT TOP 1 m.content, m.sender_type, m.sender_user_id, m.message_type, m.attachment_url, m.sent_date, m.sent_time
         FROM dbo.message m
         WHERE m.conversation_id = c.conversation_id
         ORDER BY m.sent_date DESC, m.sent_time DESC, m.message_id DESC
       ) lm
       LEFT JOIN dbo.users lu ON lu.user_id = lm.sender_user_id
       WHERE c.platform = @platform AND c.deleted_date IS NULL
       ORDER BY lm.sent_date DESC, lm.sent_time DESC, c.conversation_id DESC`,
      { platform: dbPlatform(platform), limit },
    )
  ).rows;
  return rows.map((row) => ({
    ...toConversation(row),
    lastMessage: {
      text: row.lm_content || "",
      senderType: row.lm_sender_type,
      senderUserId: row.lm_sender_user_id ? String(row.lm_sender_user_id) : null,
      senderUserName: row.lm_user_name || null,
      messageType: row.lm_type,
      hasMedia: row.lm_has_media === 1,
      time: row.lm_at,
    },
  }));
}

// ─── Locks ───────────────────────────────────────────────────────────────────

/** Every locked conversation with its agent (optionally one platform). */
async function lockedConversations(platform = null) {
  const rows = (
    await db.query(
      `SELECT c.conversation_id, c.platform, c.external_id, c.participant_external_id, c.locked_by_user_id,
              locked_at = dbo.fn_DateTimeCombine(c.locked_date, c.locked_time),
              u.first_name, u.last_name, u.email, u.role
       FROM dbo.conversations c
       LEFT JOIN dbo.users u ON u.user_id = c.locked_by_user_id
       WHERE c.locked_by_user_id IS NOT NULL AND c.deleted_date IS NULL
         AND (@platform IS NULL OR c.platform = @platform)`,
      { platform: platform ? dbPlatform(platform) : null },
    )
  ).rows;
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    platform: apiPlatform(r.platform),
    externalId: r.external_id,
    customerId: r.participant_external_id,
    agentId: String(r.locked_by_user_id),
    agentName: r.first_name ? `${r.first_name} ${r.last_name}` : "Unknown",
    agentEmail: r.email || undefined,
    lockedAt: r.locked_at,
  }));
}

/**
 * Lock a conversation to a user unless someone already holds it.
 * @returns {Promise<boolean>} true when this call took the lock
 */
async function lock(conversationId, userId, { expiresInMs = null } = {}) {
  const now = new Date();
  const expires = expiresInMs ? new Date(now.getTime() + expiresInMs) : null;
  const n = await db.scalar(
    `UPDATE dbo.conversations
       SET locked_by_user_id = @userId, assigned_to_user_id = @userId,
           locked_date = @now_date, locked_time = @now_time,
           lock_expires_date = @exp_date, lock_expires_time = @exp_time
     WHERE conversation_id = @id AND locked_by_user_id IS NULL;
     SELECT @@ROWCOUNT;`,
    { id: conversationId, userId: Number(userId), ...at("now", now), ...at("exp", expires) },
  );
  return Number(n) === 1;
}

/**
 * Give a conversation to a user whoever holds it (an admin's reassignment),
 * or release it with userId null. One row per customer carries every key
 * the inbox may send, so the lock follows the customer whatever the list shape.
 */
async function assign(conversationId, userId) {
  const now = new Date();
  await db.query(
    `UPDATE dbo.conversations
       SET locked_by_user_id = @userId, assigned_to_user_id = @userId,
           locked_date = CASE WHEN @userId IS NULL THEN NULL ELSE @now_date END,
           locked_time = CASE WHEN @userId IS NULL THEN NULL ELSE @now_time END,
           lock_expires_date = NULL, lock_expires_time = NULL
     WHERE conversation_id = @id`,
    { id: conversationId, userId: userId ? Number(userId) : null, ...at("now", now) },
  );
}

/** Push the (unenforced, decision E6) expiry of a held lock. */
async function refreshLockExpiry(conversationId, expiresInMs) {
  await db.query(
    `UPDATE dbo.conversations SET lock_expires_date = @exp_date, lock_expires_time = @exp_time
     WHERE conversation_id = @id AND locked_by_user_id IS NOT NULL`,
    { id: conversationId, ...at("exp", new Date(Date.now() + expiresInMs)) },
  );
}

/** Release the lock of the conversation behind `key` (any platform when null). */
async function unlockByKey(key, platform = null) {
  return db.scalar(
    `UPDATE dbo.conversations
       SET locked_by_user_id = NULL, assigned_to_user_id = NULL, locked_date = NULL, locked_time = NULL,
           lock_expires_date = NULL, lock_expires_time = NULL
     WHERE (external_id = @key OR participant_external_id = @key)
       AND (@platform IS NULL OR platform = @platform) AND locked_by_user_id IS NOT NULL;
     SELECT @@ROWCOUNT;`,
    { key, platform: platform ? dbPlatform(platform) : null },
  );
}

// ─── Dossier ─────────────────────────────────────────────────────────────────

/** The fields of the "dossier" custom field, with their empty values. */
const EMPTY_EXTRAS = Object.freeze({
  invoiceRef: "",
  pax: null,
  isPriority: false,
  comment: "",
  commentBy: null,
  commentAt: null,
  appointmentPlace: "",
  appointmentAgencyId: "",
  appointmentAgencyName: "",
  appointmentAgent: "",
});

function parseExtras(value) {
  if (typeof value !== "string" || !value) return { ...EMPTY_EXTRAS };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? { ...EMPTY_EXTRAS, ...parsed } : { ...EMPTY_EXTRAS };
  } catch {
    return { ...EMPTY_EXTRAS };
  }
}

/** Map contact_id → extras, for the given contacts. */
async function extrasFor(contactIds, runner = db) {
  const ids = [...new Set((contactIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (ids.length === 0) return out;
  const rows = (
    await runner.query(
      `SELECT f.contact_id, f.field_value FROM dbo.contact_custom_fields f
       WHERE f.field_key = @key AND f.contact_id IN (SELECT CONVERT(uniqueidentifier, value) FROM OPENJSON(@ids))`,
      { key: DOSSIER_FIELD, ids: JSON.stringify(ids) },
    )
  ).rows;
  for (const r of rows) out.set(String(r.contact_id).toLowerCase(), parseExtras(r.field_value));
  return out;
}

/**
 * Conversations whose dossier was touched (stage, typologie or RDV set,
 * edited at least once, or carrying extras on their contact), optionally
 * for one platform, each with its extras and its contact's phone.
 */
async function dossiers(platform = null) {
  const d = refs().defaults;
  const rows = (
    await db.query(
      `SELECT ${COLUMNS}, contact_phone = ct.phone, extras_json = f.field_value
       FROM dbo.conversations c
       LEFT JOIN dbo.contacts ct ON ct.contact_id = c.contact_id
       LEFT JOIN dbo.contact_custom_fields f ON f.contact_id = c.contact_id AND f.field_key = @key
       WHERE c.deleted_date IS NULL AND (@platform IS NULL OR c.platform = @platform)
         AND (c.classification_id <> @defCls OR c.qualification_id <> @defQual OR c.motif_id <> @defMotif
              OR c.appointment_date IS NOT NULL OR c.classified_date IS NOT NULL OR f.field_value IS NOT NULL)`,
      {
        platform: platform ? dbPlatform(platform) : null, key: DOSSIER_FIELD,
        defCls: d.classificationId, defQual: d.qualificationId, defMotif: d.motifId,
      },
    )
  ).rows;
  return rows.map((r) => ({ ...toConversation(r), extras: parseExtras(r.extras_json), contactPhone: r.contact_phone }));
}

/** One conversation with its extras and contact phone (for a response). */
async function withExtras(conversationId) {
  const r = await db.one(
    `SELECT ${COLUMNS}, contact_phone = ct.phone, extras_json = f.field_value
     FROM dbo.conversations c
     LEFT JOIN dbo.contacts ct ON ct.contact_id = c.contact_id
     LEFT JOIN dbo.contact_custom_fields f ON f.contact_id = c.contact_id AND f.field_key = @key
     WHERE c.conversation_id = @id`,
    { id: conversationId, key: DOSSIER_FIELD },
  );
  return r ? { ...toConversation(r), extras: parseExtras(r.extras_json), contactPhone: r.contact_phone } : null;
}

/**
 * Change the dossier of one conversation. Only the given fields change:
 *   stage (pipeline code), typologie ("" = not known yet), appointmentAt
 *   (Date|null), phone (the contact's number, "" to clear) and the extras
 *   (invoiceRef, pax, isPriority, comment, appointmentPlace,
 *   appointmentAgencyId, appointmentAgencyName, appointmentAgent).
 * A stage change writes its (Étape, Qualification) pair and appends a
 * history row when the Qualification moves; every edit records who made it
 * and when (classified_by / classified_date). Extras need the customer's
 * contact: a thread-only conversation keeps none.
 * @throws {Error} with status 409 when the phone number belongs to another contact
 */
async function setDossier(conversationId, { stage, typologie, appointmentAt, phone, extras }, userId) {
  const now = new Date();
  await tx(async (t) => {
    const current = await t.one(
      `SELECT qualification_id, classification_id, contact_id FROM dbo.conversations WITH (UPDLOCK) WHERE conversation_id = @id`,
      { id: conversationId },
    );
    if (!current) throw new Error("Conversation not found");
    const sets = [
      "classified_by_user_id = @userId",
      "classified_date = @now_date",
      "classified_time = @now_time",
      "updated_date = @now_date",
      "updated_time = @now_time",
    ];
    const params = { id: conversationId, userId: userId ? Number(userId) : null, ...at("now", now) };
    let newQualification = null;
    if (stage !== undefined && isStage(stage)) {
      const pair = pairOf(stage);
      sets.push("classification_id = @cls", "qualification_id = @qual");
      params.cls = pair.classificationId;
      params.qual = pair.qualificationId;
      newQualification = pair.qualificationId;
    }
    if (typologie !== undefined && (typologie === "" || isTypology(typologie))) {
      sets.push("motif_id = @motif");
      params.motif = refs().typologyToMotif[typologie];
    }
    if (appointmentAt !== undefined) {
      sets.push("appointment_date = @rdv_date", "appointment_time = @rdv_time");
      Object.assign(params, at("rdv", appointmentAt));
    }
    await t.query(`UPDATE dbo.conversations SET ${sets.join(", ")} WHERE conversation_id = @id`, params);
    if (newQualification !== null && newQualification !== current.qualification_id) {
      await t.query(
        `INSERT dbo.conversation_qualification_history (conversation_id, qualification_id, changed_by_user_id, changed_date, changed_time)
         VALUES (@id, @qual, @userId, @now_date, @now_time)`,
        { id: conversationId, qual: newQualification, userId: params.userId, ...at("now", now) },
      );
    }
    if (params.cls !== undefined) await registerPair(t, params.cls, params.qual);

    if (current.contact_id && phone !== undefined) {
      const number = contacts.fit(phone, 30);
      const taken = number
        ? await t.scalar(`SELECT 1 FROM dbo.contacts WHERE phone = @phone AND contact_id <> @contactId`, { phone: number, contactId: current.contact_id })
        : null;
      if (taken) {
        const err = new Error("Ce numéro est déjà celui d'un autre prospect.");
        err.status = 409;
        throw err;
      }
      await t.query(`UPDATE dbo.contacts SET phone = @phone WHERE contact_id = @contactId`, { phone: number, contactId: current.contact_id });
    }
    if (current.contact_id && extras && Object.keys(extras).length > 0) {
      const stored = parseExtras(await contacts.readCustomField(t, current.contact_id, DOSSIER_FIELD));
      const next = { ...stored, ...extras };
      await contacts.writeCustomField(t, current.contact_id, DOSSIER_FIELD, JSON.stringify(next));
    }
  });
  return withExtras(conversationId);
}

/** The client-facing dossier of a conversation (main's shape, CLAUDE.md §6). */
const publicDossier = (conv) => {
  const x = conv?.extras || EMPTY_EXTRAS;
  return {
    stage: conv?.stage || DEFAULT_STAGE,
    typologie: conv?.typologie || "",
    invoiceRef: x.invoiceRef || "",
    phone: conv?.platform === "whatsapp" ? "" : conv?.contactPhone || "",
    pax: Number.isInteger(x.pax) ? x.pax : null,
    isPriority: x.isPriority === true,
    appointmentAt: conv?.appointmentAt || null,
    appointmentPlace: conv?.appointmentAt ? x.appointmentPlace || "" : "",
    appointmentAgencyId: conv?.appointmentAt ? x.appointmentAgencyId || "" : "",
    appointmentAgencyName: conv?.appointmentAt ? x.appointmentAgencyName || "" : "",
    appointmentAgent: conv?.appointmentAt ? x.appointmentAgent || "" : "",
    comment: x.comment || "",
    commentAt: x.commentAt || null,
  };
};

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a conversation's data: its messages and qualification history go, its
 * dossier and lock are reset, and the row stays with deleted_date set.
 * @returns {Promise<{messages: number, classifications: number, locks: number}>}
 */
async function softDelete(conversationId) {
  const d = refs().defaults;
  return tx(async (t) => {
    const before = await t.one(
      `SELECT locked_by_user_id, classification_id, qualification_id, motif_id, appointment_date, classified_date, contact_id
       FROM dbo.conversations WITH (UPDLOCK) WHERE conversation_id = @id`,
      { id: conversationId },
    );
    if (!before) return { messages: 0, classifications: 0, locks: 0 };
    const messages = await t.scalar(
      `DELETE dbo.message WHERE conversation_id = @id; SELECT @@ROWCOUNT;`,
      { id: conversationId },
    );
    await t.query(
      `DELETE dbo.conversation_qualification_history WHERE conversation_id = @id;
       DELETE dbo.conversation_agent_unread WHERE conversation_id = @id;
       UPDATE dbo.conversations SET
         qualification_id = @qual, classification_id = @cls, motif_id = @motif,
         appointment_date = NULL, appointment_time = NULL,
         classified_by_user_id = NULL, classified_date = NULL, classified_time = NULL,
         locked_by_user_id = NULL, assigned_to_user_id = NULL, locked_date = NULL, locked_time = NULL,
         lock_expires_date = NULL, lock_expires_time = NULL,
         message_count = 0, unread_count = 0,
         deleted_date = @now_date, deleted_time = @now_time, updated_date = @now_date, updated_time = @now_time
       WHERE conversation_id = @id;
       IF @contactId IS NOT NULL
         DELETE dbo.contact_custom_fields WHERE contact_id = @contactId AND field_key = @key;`,
      { id: conversationId, qual: d.qualificationId, cls: d.classificationId, motif: d.motifId, contactId: before.contact_id, key: DOSSIER_FIELD, ...at("now", new Date()) },
    );
    const touched =
      before.classification_id !== d.classificationId ||
      before.qualification_id !== d.qualificationId ||
      before.motif_id !== d.motifId ||
      before.appointment_date !== null ||
      before.classified_date !== null;
    return {
      messages: Number(messages) || 0,
      classifications: touched ? 1 : 0,
      locks: before.locked_by_user_id ? 1 : 0,
    };
  });
}

module.exports = {
  CALL_PLATFORM,
  DOSSIER_FIELD,
  EMPTY_EXTRAS,
  dbPlatform,
  apiPlatform,
  isThreadId,
  toConversation,
  findByKeys,
  resolve,
  byId,
  ensureForCustomer,
  ensureForThread,
  ensureForCall,
  callStats,
  callLeads,
  linkThreads,
  updateProfile,
  placeholderCustomers,
  recentWithLastMessage,
  lockedConversations,
  lock,
  assign,
  refreshLockExpiry,
  unlockByKey,
  dossiers,
  withExtras,
  extrasFor,
  parseExtras,
  setDossier,
  publicDossier,
  softDelete,
};
