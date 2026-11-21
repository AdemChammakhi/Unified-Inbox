/**
 * users.js — accounts, in dbo.users.
 *
 * The API keeps the shape the client has always read: `_id` is the user id as
 * a string, plus firstName, lastName, email, role, isActive, createdBy,
 * createdAt, updatedAt. Passwords are bcrypt hashes (cost 10) in password_hash.
 *
 * Roles: the API and the client keep the app's historical names (admin,
 * manager, marketing); the scripts' CK_users_role allows admin, manager and
 * agent, so "marketing" is stored as "agent" and read back as "marketing"
 * (decision E5). Nothing above this module sees the stored name.
 */

"use strict";

const bcrypt = require("bcryptjs");
const { db, tx, at } = require("./sql");

const ROLES = Object.freeze(["admin", "manager", "marketing"]);

/** API role → stored role, and back. */
const toStoredRole = (role) => (role === "marketing" ? "agent" : role);
const toApiRole = (role) => (role === "agent" ? "marketing" : role);

const COLUMNS = `
  u.user_id, u.first_name, u.last_name, u.email, u.role, u.created_by_user_id, u.is_active,
  created_at = dbo.fn_DateTimeCombine(u.created_date, u.created_time),
  updated_at = dbo.fn_DateTimeCombine(u.updated_date, u.updated_time)`;

/** A user id from a token, a route param or `req.user._id`; null when not one. */
function userIdOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

function toUser(row) {
  if (!row) return null;
  return {
    _id: String(row.user_id),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: toApiRole(row.role),
    isActive: row.is_active !== false,
    createdBy: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const fullName = (u) => (u ? `${u.firstName || u.first_name || ""} ${u.lastName || u.last_name || ""}`.trim() : "");

const cleanEmail = (email) => String(email || "").trim().toLowerCase();

async function findById(id) {
  const userId = userIdOf(id);
  if (!userId) return null;
  return toUser(await db.one(`SELECT ${COLUMNS} FROM dbo.users u WHERE u.user_id = @userId`, { userId }));
}

/** The user and their password hash, for the login check only. */
async function findForLogin(email) {
  const row = await db.one(
    `SELECT ${COLUMNS}, u.password_hash FROM dbo.users u WHERE u.email = @email`,
    { email: cleanEmail(email) },
  );
  if (!row) return null;
  return { user: toUser(row), passwordHash: row.password_hash };
}

async function emailTaken(email, exceptId = null) {
  return Boolean(
    await db.scalar(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.users WHERE email = @email AND user_id <> ISNULL(@exceptId, 0)) THEN 1 ELSE 0 END`,
      { email: cleanEmail(email), exceptId: userIdOf(exceptId) },
    ),
  );
}

/**
 * Accounts, newest first, each with its creator.
 * @param {{createdBy?: string|number}} [filter] only the accounts that user opened
 */
async function list(filter = {}) {
  const createdBy = filter.createdBy !== undefined ? userIdOf(filter.createdBy) : null;
  const rows = (
    await db.query(
      `SELECT ${COLUMNS},
              creator_first_name = c.first_name, creator_last_name = c.last_name, creator_email = c.email
       FROM dbo.users u
       LEFT JOIN dbo.users c ON c.user_id = u.created_by_user_id
       WHERE @createdBy IS NULL OR u.created_by_user_id = @createdBy
       ORDER BY u.created_date DESC, u.created_time DESC, u.user_id DESC`,
      { createdBy },
    )
  ).rows;
  return rows.map((row) => ({
    ...toUser(row),
    creator: row.created_by_user_id
      ? {
          _id: String(row.created_by_user_id),
          name: `${row.creator_first_name || ""} ${row.creator_last_name || ""}`.trim(),
          email: row.creator_email,
        }
      : null,
  }));
}

async function create({ firstName, lastName, email, password, role, createdBy }) {
  const hash = await bcrypt.hash(String(password), 10);
  const now = new Date();
  const row = await db.one(
    `INSERT dbo.users (first_name, last_name, email, password_hash, role, created_by_user_id, is_active,
                       created_date, created_time, updated_date, updated_time)
     OUTPUT INSERTED.user_id
     VALUES (@firstName, @lastName, @email, @hash, @role, @createdBy, 1, @now_date, @now_time, @now_date, @now_time)`,
    {
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: cleanEmail(email),
      hash,
      role: toStoredRole(role),
      createdBy: userIdOf(createdBy),
      ...at("now", now),
    },
  );
  return findById(row.user_id);
}

/** Update the given fields; a `password` is hashed here, never stored in clear. */
async function update(id, fields) {
  const userId = userIdOf(id);
  const sets = [];
  const params = { userId, ...at("now", new Date()) };
  if (fields.firstName !== undefined) {
    sets.push("first_name = @firstName");
    params.firstName = String(fields.firstName).trim();
  }
  if (fields.lastName !== undefined) {
    sets.push("last_name = @lastName");
    params.lastName = String(fields.lastName).trim();
  }
  if (fields.email !== undefined) {
    sets.push("email = @email");
    params.email = cleanEmail(fields.email);
  }
  if (fields.role !== undefined) {
    sets.push("role = @role");
    params.role = toStoredRole(fields.role);
  }
  if (fields.isActive !== undefined) {
    sets.push("is_active = @isActive");
    params.isActive = Boolean(fields.isActive);
  }
  if (fields.password) {
    sets.push("password_hash = @hash");
    params.hash = await bcrypt.hash(String(fields.password), 10);
  }
  if (sets.length > 0) {
    sets.push("updated_date = @now_date", "updated_time = @now_time");
    await db.query(`UPDATE dbo.users SET ${sets.join(", ")} WHERE user_id = @userId`, params);
  }
  return findById(userId);
}

/**
 * Delete an account. Foreign keys forbid orphans, so every reference to the
 * user is cleared first, as MongoDB's dangling references effectively were:
 * the locks they held are released, their replies and qualification changes lose
 * their author, and the accounts they opened lose their creator.
 * @returns {Promise<{releasedLocks: number}>}
 */
async function remove(id) {
  const userId = userIdOf(id);
  return tx(async (t) => {
    const released = await t.scalar(
      `UPDATE dbo.conversations
         SET locked_by_user_id = NULL, locked_date = NULL, locked_time = NULL,
             lock_expires_date = NULL, lock_expires_time = NULL
       WHERE locked_by_user_id = @userId;
       SELECT @@ROWCOUNT;`,
      { userId },
    );
    await t.query(
      `UPDATE dbo.conversations SET assigned_to_user_id = NULL WHERE assigned_to_user_id = @userId;
       UPDATE dbo.conversations SET classified_by_user_id = NULL WHERE classified_by_user_id = @userId;
       UPDATE dbo.message SET sender_user_id = NULL WHERE sender_user_id = @userId;
       UPDATE dbo.conversation_qualification_history SET changed_by_user_id = NULL WHERE changed_by_user_id = @userId;
       UPDATE dbo.users SET created_by_user_id = NULL WHERE created_by_user_id = @userId;
       UPDATE dbo.channel_call_config SET default_agent_user_id = NULL WHERE default_agent_user_id = @userId;
       DELETE dbo.conversation_agent_unread WHERE user_id = @userId;
       DELETE dbo.channel_agents WHERE user_id = @userId;
       DELETE dbo.extension_agents WHERE user_id = @userId;
       DELETE dbo.agent_label_map WHERE user_id = @userId;
       DELETE dbo.users WHERE user_id = @userId;`,
      { userId },
    );
    return { releasedLocks: Number(released) || 0 };
  });
}

/** The active accounts, as { _id, name, role }, for pickers. */
async function activeAgents() {
  const rows = (
    await db.query(
      `SELECT u.user_id, u.first_name, u.last_name, u.role FROM dbo.users u
       WHERE u.is_active = 1 ORDER BY u.first_name, u.last_name`,
    )
  ).rows;
  return rows.map((r) => ({
    _id: String(r.user_id),
    name: `${r.first_name || ""} ${r.last_name || ""}`.trim(),
    role: toApiRole(r.role),
  }));
}

/** Map user id (string) → "First Last", for the given ids. */
async function namesByIds(ids) {
  const wanted = [...new Set((ids || []).map(userIdOf).filter(Boolean))];
  const names = new Map();
  if (wanted.length === 0) return names;
  const rows = (
    await db.query(
      `SELECT u.user_id, u.first_name, u.last_name FROM dbo.users u
       WHERE u.user_id IN (SELECT CONVERT(int, value) FROM OPENJSON(@ids))`,
      { ids: JSON.stringify(wanted) },
    )
  ).rows;
  for (const r of rows) names.set(String(r.user_id), `${r.first_name || ""} ${r.last_name || ""}`.trim());
  return names;
}

const comparePassword = (candidate, hash) =>
  typeof candidate === "string" && typeof hash === "string" ? bcrypt.compare(candidate, hash) : Promise.resolve(false);

module.exports = {
  ROLES,
  toStoredRole,
  toApiRole,
  activeAgents,
  userIdOf,
  fullName,
  findById,
  findForLogin,
  emailTaken,
  list,
  create,
  update,
  remove,
  namesByIds,
  comparePassword,
};
