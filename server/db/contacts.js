/**
 * contacts.js — people, in dbo.contacts, and their platform identities.
 *
 * One identity per (platform, customer id): contact_platform_identities is
 * unique on it, so a customer id always leads to exactly one contact. A
 * WhatsApp contact also gets its number in contacts.phone ("+" and the digits,
 * the form the prospect sheet writes) and an email contact its address in
 * contacts.email; both are unique, so a second identity carrying a number or
 * address already known joins that contact instead of creating another.
 *
 * Names: a placeholder ("User 1234", "Unknown", a raw id) never replaces a
 * real name, and one failed profile lookup never wipes a stored avatar.
 */

"use strict";

const { db, at, lockKey, jsonList, isDuplicateKey } = require("./sql");

const IDENTITY_PLATFORMS = new Set(["facebook", "instagram", "whatsapp", "email", "tiktok"]);

/** Names the webhooks use when the real one is unknown. */
function isPlaceholderName(name, externalId) {
  if (typeof name !== "string") return true;
  const n = name.trim();
  return (
    !n ||
    n === "Unknown" ||
    /^User .{1,4}$/.test(n) ||
    /^\d{6,}$/.test(n) ||
    (externalId !== undefined && n === String(externalId))
  );
}

/** A value for an nvarchar(n) column: trimmed, cut to n, null when empty. */
const fit = (value, n) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, n) : null;
};

/** A URL for an nvarchar(500) column; a longer one is dropped rather than cut. */
const url500 = (value) => {
  const s = typeof value === "string" ? value.trim() : "";
  return s && s.length <= 500 ? s : null;
};

function phoneOf(platform, externalId) {
  if (platform !== "whatsapp") return null;
  const digits = String(externalId).replace(/^\+/, "");
  return /^\d{6,25}$/.test(digits) ? `+${digits}` : null;
}

function emailOf(platform, externalId) {
  if (platform !== "email") return null;
  const s = String(externalId).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) && s.length <= 255 ? s : null;
}

/**
 * Find or create the contact behind one platform identity, inside the
 * caller's transaction `t`, and refresh what was learned about it.
 *
 * @param {object} t   transaction runner from sql.tx
 * @param {object} p
 * @param {string} p.platform
 * @param {string} p.externalId  the customer's platform id
 * @param {string} [p.name]
 * @param {string} [p.username]
 * @param {string} [p.avatar]
 * @param {Date}   [p.seenAt]
 * @returns {Promise<{contactId: string, created: boolean}>}
 */
async function ensureIdentity(t, { platform, externalId, name, username, avatar, seenAt }) {
  if (!IDENTITY_PLATFORMS.has(platform)) throw new Error(`No contact identity for platform ${platform}`);
  const ext = fit(externalId, 255);
  if (!ext) throw new Error("A contact identity needs an external id");
  await lockKey(t, `ident:${platform}:${ext}`);

  const now = seenAt instanceof Date ? seenAt : new Date();
  const realName = !isPlaceholderName(name, ext) ? fit(name, 255) : null;
  const realUsername = !isPlaceholderName(username, ext) ? fit(username, 255) : null;
  const avatarUrl = url500(avatar);

  const found = await t.one(
    `SELECT i.identity_key, i.contact_id FROM dbo.contact_platform_identities i
     WHERE i.platform = @platform AND i.external_id = @ext`,
    { platform, ext },
  );
  if (found) {
    await t.query(
      `UPDATE dbo.contact_platform_identities
         SET name = COALESCE(@realName, @realUsername, name),
             username = COALESCE(@realUsername, username),
             avatar = COALESCE(@avatar, avatar),
             last_seen_date = @seen_date, last_seen_time = @seen_time
       WHERE identity_key = @key;
       UPDATE dbo.contacts
         SET display_name = CASE WHEN COALESCE(@realName, @realUsername) IS NOT NULL
                                  AND (display_name = N'Unknown' OR display_name = @ext
                                       OR (display_name LIKE N'User %' AND LEN(display_name) <= 9)
                                       OR display_name NOT LIKE N'%[^0-9]%')
                                 THEN COALESCE(@realName, @realUsername) ELSE display_name END,
             avatar = COALESCE(@avatar, avatar),
             updated_date = @seen_date, updated_time = @seen_time
       WHERE contact_id = @contactId;`,
      {
        key: found.identity_key,
        contactId: found.contact_id,
        realName,
        realUsername,
        avatar: avatarUrl,
        ext,
        ...at("seen", now),
      },
    );
    return { contactId: found.contact_id, created: false };
  }

  const phone = phoneOf(platform, ext);
  const email = emailOf(platform, ext);
  // A number or address already on file belongs to that person
  let contactId = null;
  if (phone || email) {
    contactId = await t.scalar(
      `SELECT TOP 1 contact_id FROM dbo.contacts
       WHERE (@phone IS NOT NULL AND phone = @phone) OR (@email IS NOT NULL AND email = @email)`,
      { phone, email },
    );
  }
  let created = false;
  if (!contactId) {
    const display = realName || realUsername || (platform === "email" ? ext : "Unknown");
    contactId = await t.scalar(
      `DECLARE @id uniqueidentifier = NEWID();
       INSERT dbo.contacts (contact_id, display_name, email, phone, avatar, total_conversations, total_messages,
                            is_blocked, is_spam, is_vip, first_contact_date, first_contact_time,
                            last_contact_date, last_contact_time, created_date, created_time, updated_date, updated_time)
       VALUES (@id, @display, @email, @phone, @avatar, 0, 0, 0, 0, 0, @now_date, @now_time,
               @now_date, @now_time, @now_date, @now_time, @now_date, @now_time);
       SELECT @id;`,
      { display: fit(display, 255) || "Unknown", email, phone, avatar: avatarUrl, ...at("now", now) },
    );
    created = true;
  }
  try {
    await t.query(
      `INSERT dbo.contact_platform_identities (contact_id, platform, external_id, username, name, avatar,
                                               profile_url, last_seen_date, last_seen_time)
       VALUES (@contactId, @platform, @ext, @realUsername, @identityName, @avatar, NULL, @seen_date, @seen_time)`,
      {
        contactId,
        platform,
        ext,
        realUsername,
        identityName: realName || realUsername || "Unknown",
        avatar: avatarUrl,
        ...at("seen", now),
      },
    );
  } catch (err) {
    // Only possible when the identity was inserted without the applock (a
    // concurrent writer outside this module): the row exists, use it.
    if (!isDuplicateKey(err)) throw err;
    const existing = await t.scalar(
      `SELECT contact_id FROM dbo.contact_platform_identities WHERE platform = @platform AND external_id = @ext`,
      { platform, ext },
    );
    return { contactId: existing, created: false };
  }
  return { contactId, created };
}

/**
 * Stored avatars for a set of customer ids: { customerId: url }.
 * Identity avatar first, then the contact's.
 */
async function avatarMap(platform, externalIds) {
  const ids = [...new Set([...(externalIds || [])].filter(Boolean).map(String))];
  if (ids.length === 0) return {};
  try {
    const rows = (
      await db.query(
        `SELECT i.external_id, avatar = COALESCE(i.avatar, c.avatar)
         FROM dbo.contact_platform_identities i
         JOIN dbo.contacts c ON c.contact_id = i.contact_id
         WHERE i.platform = @platform AND i.external_id IN (SELECT value FROM OPENJSON(@ids))
           AND COALESCE(i.avatar, c.avatar) IS NOT NULL`,
        { platform, ids: jsonList(ids) },
      )
    ).rows;
    const map = {};
    for (const r of rows) map[r.external_id] = r.avatar;
    return map;
  } catch (err) {
    console.error("Avatar map lookup failed (non-fatal):", err.message);
    return {};
  }
}

// ─── Custom fields ───────────────────────────────────────────────────────────

/** Values of one custom field for many identities: Map customerId -> string. */
async function customFieldFor(platform, externalIds, fieldKey) {
  const ids = [...new Set((externalIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (ids.length === 0) return out;
  const rows = (
    await db.query(
      `SELECT i.external_id, f.field_value
       FROM dbo.contact_platform_identities i
       JOIN dbo.contact_custom_fields f ON f.contact_id = i.contact_id AND f.field_key = @fieldKey
       WHERE i.platform = @platform AND i.external_id IN (SELECT value FROM OPENJSON(@ids))`,
      { platform, fieldKey, ids: jsonList(ids) },
    )
  ).rows;
  for (const r of rows) out.set(r.external_id, r.field_value);
  return out;
}

/** Read a custom field inside a transaction. */
async function readCustomField(t, contactId, fieldKey) {
  return t.scalar(
    `SELECT field_value FROM dbo.contact_custom_fields WHERE contact_id = @contactId AND field_key = @fieldKey`,
    { contactId, fieldKey },
  );
}

/** Insert or replace a custom field inside a transaction. */
async function writeCustomField(t, contactId, fieldKey, value) {
  await t.query(
    `UPDATE dbo.contact_custom_fields SET field_value = @value WHERE contact_id = @contactId AND field_key = @fieldKey;
     IF @@ROWCOUNT = 0
       INSERT dbo.contact_custom_fields (contact_id, field_key, field_value) VALUES (@contactId, @fieldKey, @value);`,
    { contactId, fieldKey, value },
  );
}

module.exports = {
  IDENTITY_PLATFORMS,
  isPlaceholderName,
  fit,
  url500,
  ensureIdentity,
  avatarMap,
  customFieldFor,
  readCustomField,
  writeCustomField,
};
