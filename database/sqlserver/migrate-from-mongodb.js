#!/usr/bin/env node
/**
 * migrate-from-mongodb.js — one-time copy of the MongoDB data into UnifiedBox1
 * (decision D7 in database/sqlserver/decisions.md).
 *
 *   node database/sqlserver/migrate-from-mongodb.js --mongo-uri <uri>            dry run
 *   node database/sqlserver/migrate-from-mongodb.js --mongo-uri <uri> --commit   copy
 *
 * The target comes from the SQLSERVER_* variables, the same as the app. Run it
 * with the production values of FACEBOOK_PAGE_ID, INSTAGRAM_ACCOUNT_ID,
 * WHATSAPP_PHONE_NUMBER_ID and EMAIL_USER: they tell our own messages from the
 * customers'. The MongoDB database is only read.
 *
 * Everything is written in ONE transaction. A dry run does all of it, prints
 * the report, then rolls back: run it against a copy first. The target must
 * hold no users, conversations or messages yet (reference rows are fine).
 *
 * What goes where (the scripts are not altered, decision D5):
 *  - users → dbo.users. Password hashes are copied, so passwords stay; ids
 *    change type, so every session ends. The role "marketing" becomes "agent".
 *  - channels → dbo.channels (+ credentials reference, email settings,
 *    assigned agents).
 *  - contacts → dbo.contacts, one identity per (platform, customer id): the
 *    most recently updated contact keeps a duplicated identity, and the frein
 *    of the others is merged in. customFields → contact_custom_fields, tags →
 *    contact_tags.
 *  - messages → one conversation per customer per platform, found the way
 *    the app finds them (routes/exports.js had the same rule): the sender of
 *    an incoming message, the recipient of ours, a thread id mapped to the
 *    customer who wrote in it. A Graph thread id becomes the conversation's
 *    external_id. Sends the platform refused (status "failed") are not copied.
 *  - classifications → the conversation's dossier. The 12-stage pipeline maps
 *    onto the scripts' two fields, Étape (classification_id) and
 *    Qualification (qualification_id), through PREVIOUS_STAGE_TO_MODEL; the
 *    six classifications older than the pipeline go through LEGACY_TO_STAGE
 *    first; a lost lead's reason comes from its frein (LOSS_REASON_BY_FREIN).
 *    Typologie and RDV are copied. Priority and invoice reference are left
 *    behind (D6).
 *  - conversation locks → locked_by / assigned_to.
 *  - the first ad a customer came from → dbo.campaigns + conversations.campaign_id.
 *  - Not copied (D3, D6): message context beyond that ad, extra attachments,
 *    attachment names, delivery status (only "read" survives), per-message
 *    sender names, email subject/HTML, partners, templates, dossier documents,
 *    and attachment URLs longer than 500 characters (Meta's, long expired).
 */

"use strict";

const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const root = path.resolve(__dirname, "../..");
require("dotenv").config({ path: path.join(root, ".env") });
const { getPool, sql, closePool } = require(path.join(root, "server/db/sql"));
const { ensureReferenceRows, refs } = require(path.join(root, "server/db/reference"));
const {
  PREVIOUS_STAGE_TO_MODEL,
  LOSS_REASON_BY_FREIN,
  LEGACY_TO_STAGE,
  DEFAULT_QUALIFICATION,
  isTypology,
} = require(path.join(root, "server/constants/pipeline"));

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const MONGO_URI = argValue("--mongo-uri") || process.env.MIGRATION_MONGO_URI;
const COMMIT = args.includes("--commit");
const BATCH = 500;

const PLATFORMS = new Set(["facebook", "instagram", "whatsapp", "email", "tiktok"]);
const UNAVAILABLE_TEXT = "[Pièce jointe indisponible]";

// ─── Small helpers ───────────────────────────────────────────────────────────

const fit = (value, n) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, n) : null;
};
const url500 = (value) => {
  const s = typeof value === "string" ? value.trim() : "";
  return s && s.length <= 500 ? s : null;
};
const dateOf = (...values) => {
  for (const v of values) {
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
};
const pad = (n) => String(n).padStart(2, "0");
const dPart = (d) => (d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : null);
const tPart = (d) => (d ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : null);
const platformOf = (p) => (p === "messenger" ? "facebook" : p);

function isPlaceholderName(name, id) {
  if (typeof name !== "string") return true;
  const n = name.trim();
  return !n || n === "Unknown" || /^User .{1,4}$/.test(n) || /^\d{6,}$/.test(n) || n === String(id);
}
const isThreadId = (platform, id) => platform !== "email" && typeof id === "string" && /^t_/i.test(id);
/** A customer id as a key: email addresses compare case-insensitively (so does the database). */
const norm = (platform, id) => {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  if (!s) return null;
  return platform === "email" ? s.toLowerCase() : s;
};

// ─── SQL, inside the migration transaction ───────────────────────────────────

let _tx = null;
async function q(text, params = {}) {
  const request = new sql.Request(_tx);
  for (const [name, value] of Object.entries(params)) {
    if (value && value.__type) request.input(name, value.__type, value.value);
    else if (typeof value === "number") request.input(name, Number.isInteger(value) ? sql.Int : sql.Float, value);
    else if (typeof value === "boolean") request.input(name, sql.Bit, value);
    else request.input(name, sql.NVarChar(sql.MAX), value === undefined ? null : value);
  }
  const r = await request.query(text);
  return r.recordset || [];
}
const json = (rows) => JSON.stringify(rows);
async function inBatches(rows, fn) {
  for (let i = 0; i < rows.length; i += BATCH) await fn(rows.slice(i, i + BATCH));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!MONGO_URI) {
    console.error("Missing --mongo-uri <uri> (or MIGRATION_MONGO_URI).");
    process.exit(2);
  }
  const report = {};
  const count = (key, n = 1) => (report[key] = (report[key] || 0) + n);

  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const mdb = mongo.db();
  console.log(`MongoDB: ${mdb.databaseName} → SQL Server: ${process.env.SQLSERVER_HOST || "localhost"}/${process.env.SQLSERVER_DATABASE || "UnifiedBox1"}`);
  console.log(COMMIT ? "Mode: COMMIT" : "Mode: dry run (everything is rolled back at the end)");

  const pool = await getPool();
  const occupied = (
    await pool.request().query(
      `SELECT n = (SELECT COUNT(*) FROM dbo.users) + (SELECT COUNT(*) FROM dbo.conversations) + (SELECT COUNT(*) FROM dbo.message)`,
    )
  ).recordset[0].n;
  if (occupied > 0) {
    console.error("The target already holds users, conversations or messages. Migrate into an empty UnifiedBox1.");
    process.exit(3);
  }
  // Reference rows are the app's own and idempotent: committed before the copy
  await ensureReferenceRows();
  const r = refs();

  // Read everything but messages (those are streamed twice)
  const [mUsers, mChannels, mContacts, mClassifications, mLocks] = await Promise.all([
    mdb.collection("users").find({}).toArray(),
    mdb.collection("channels").find({}).toArray(),
    mdb.collection("contacts").find({}).toArray(),
    mdb.collection("classifications").find({}).toArray(),
    mdb.collection("conversationlocks").find({}).toArray(),
  ]);

  const own = new Set(
    [
      process.env.FACEBOOK_PAGE_ID,
      process.env.INSTAGRAM_ACCOUNT_ID,
      process.env.WHATSAPP_PHONE_NUMBER_ID,
      process.env.EMAIL_USER,
      "agent",
      "unknown",
      "Page",
      ...mChannels.map((c) => c.externalId),
    ]
      .filter(Boolean)
      .map(String),
  );
  const OWN_NAMES = new Set(["Page", "You"]);
  const isFromProspect = (m) =>
    m.direction === "incoming" && !own.has(String(m.senderId)) && !OWN_NAMES.has(m.senderName);
  const isFailed = (m) => m.direction !== "incoming" && m.status === "failed";

  // ── Pass 1 over messages: who each message belongs to ──────────────────────
  const projection = {
    platform: 1, conversationId: 1, senderId: 1, senderName: 1, recipientId: 1, direction: 1,
    status: 1, timestamp: 1, createdAt: 1, "context.kind": 1, "context.adId": 1, "context.title": 1,
    "context.body": 1, "context.url": 1,
  };
  const convToPerson = new Map(); // "<platform>:<key>" -> customer id
  for await (const m of mdb.collection("messages").find({}, { projection })) {
    const platform = platformOf(m.platform);
    if (!isFromProspect(m)) continue;
    const sender = norm(platform, m.senderId);
    if (!sender || isThreadId(platform, sender)) continue;
    if (m.conversationId) convToPerson.set(`${platform}:${norm(platform, m.conversationId)}`, sender);
    convToPerson.set(`${platform}:${sender}`, sender);
  }
  const personOf = (m, platform) => {
    if (isFromProspect(m)) return norm(platform, m.senderId);
    const via =
      convToPerson.get(`${platform}:${norm(platform, m.recipientId)}`) ||
      convToPerson.get(`${platform}:${norm(platform, m.conversationId)}`);
    if (via) return via;
    const to = norm(platform, m.recipientId);
    if (to && !own.has(to)) return to;
    const conv = norm(platform, m.conversationId);
    return conv && !own.has(conv) ? conv : null;
  };

  const persons = new Map(); // "<platform>:<person>" -> aggregate
  const personKey = (platform, person) => `${platform}:${person}`;
  const personFor = (platform, person) => {
    const key = personKey(platform, person);
    let p = persons.get(key);
    if (!p) {
      p = { platform, person, first: null, last: null, name: null, nameAt: null, thread: null, ad: null, adAt: null, messages: 0 };
      persons.set(key, p);
    }
    return p;
  };
  for await (const m of mdb.collection("messages").find({}, { projection })) {
    const platform = platformOf(m.platform);
    if (!PLATFORMS.has(platform)) {
      count("messages skipped: unknown platform");
      continue;
    }
    if (isFailed(m)) continue;
    const person = personOf(m, platform);
    if (!person || person.length > 255) {
      count("messages skipped: no customer");
      continue;
    }
    const p = personFor(platform, person);
    const when = dateOf(m.timestamp, m.createdAt) || new Date(0);
    p.messages += 1;
    if (!p.first || when < p.first) p.first = when;
    if (!p.last || when > p.last) p.last = when;
    const conv = norm(platform, m.conversationId);
    if (conv && conv !== person && isThreadId(platform, conv) && !isThreadId(platform, person)) p.thread = conv;
    if (isFromProspect(m) && !isPlaceholderName(m.senderName, person) && (!p.nameAt || when > p.nameAt)) {
      p.name = m.senderName;
      p.nameAt = when;
    }
    const ctx = m.context;
    if (isFromProspect(m) && ctx && ctx.kind === "ad" && ctx.adId && (!p.adAt || when < p.adAt)) {
      p.ad = ctx;
      p.adAt = when;
    }
  }

  // Dossiers and locks keyed by a thread id belong to its customer
  const personOfKey = (platform, key) => {
    const k = norm(platform, key);
    return convToPerson.get(`${platform}:${k}`) || k;
  };
  const newest = (a, b, field) => (!a || dateOf(b[field]) > dateOf(a[field]) ? b : a);
  const dossierOf = new Map(); // personKey -> classification doc
  for (const c of mClassifications) {
    const platform = platformOf(c.platform);
    if (!PLATFORMS.has(platform) || !c.conversationId) continue;
    const person = personOfKey(platform, c.conversationId);
    if (!person || own.has(person) || person.length > 255) continue;
    const key = personKey(platform, person);
    dossierOf.set(key, newest(dossierOf.get(key), c, "updatedAt"));
    personFor(platform, person); // a dossier without messages still gets its conversation
  }
  const lockOf = new Map();
  for (const l of mLocks) {
    const platform = platformOf(l.platform);
    if (!PLATFORMS.has(platform) || !l.conversationId) continue;
    const person = personOfKey(platform, l.conversationId);
    if (!person || own.has(person) || person.length > 255) continue;
    const key = personKey(platform, person);
    lockOf.set(key, newest(lockOf.get(key), l, "lockedAt"));
    personFor(platform, person);
  }

  const pool2 = await getPool();
  _tx = new sql.Transaction(pool2);
  await _tx.begin();
  try {
    // ── Users ────────────────────────────────────────────────────────────────
    const userId = new Map(); // mongo id -> user_id
    const usedEmails = new Set();
    for (const u of mUsers) {
      const email = fit(String(u.email || "").toLowerCase(), 255);
      if (!email || usedEmails.has(email) || !u.password) {
        count("users skipped (no email, duplicate or no password)");
        continue;
      }
      usedEmails.add(email);
      const role = u.role === "marketing" ? "agent" : ["admin", "manager", "agent"].includes(u.role) ? u.role : "agent";
      const created = dateOf(u.createdAt) || new Date();
      const updated = dateOf(u.updatedAt, u.createdAt) || created;
      const [row] = await q(
        `INSERT dbo.users (first_name, last_name, email, password_hash, role, created_by_user_id, is_active,
                           created_date, created_time, updated_date, updated_time)
         OUTPUT INSERTED.user_id
         VALUES (@first, @last, @email, @hash, @role, NULL, @active, @cd, @ct, @ud, @ut)`,
        {
          first: fit(u.firstName, 100) || "-",
          last: fit(u.lastName, 100) || "-",
          email,
          hash: String(u.password).slice(0, 255),
          role,
          active: u.isActive !== false,
          cd: dPart(created), ct: tPart(created), ud: dPart(updated), ut: tPart(updated),
        },
      );
      userId.set(String(u._id), row.user_id);
      count("users");
      if (u.role === "marketing") count("users renamed marketing → agent");
    }
    for (const u of mUsers) {
      const id = userId.get(String(u._id));
      const by = u.createdBy ? userId.get(String(u.createdBy)) : null;
      if (id && by) await q(`UPDATE dbo.users SET created_by_user_id = @by WHERE user_id = @id`, { id, by });
    }
    const uid = (v) => (v ? userId.get(String(v)) || null : null);

    // ── Channels ─────────────────────────────────────────────────────────────
    const channelOf = new Map(); // platform -> channel_id
    const seenChannel = new Set();
    for (const c of mChannels) {
      const platform = platformOf(c.platform);
      const ext = fit(c.externalId, 255);
      if (!PLATFORMS.has(platform) || !ext || seenChannel.has(`${platform}:${ext}`)) continue;
      seenChannel.add(`${platform}:${ext}`);
      const envIdOf = {
        facebook: process.env.FACEBOOK_PAGE_ID, instagram: process.env.INSTAGRAM_ACCOUNT_ID,
        whatsapp: process.env.WHATSAPP_PHONE_NUMBER_ID, email: process.env.EMAIL_USER, tiktok: process.env.TIKTOK_ACCOUNT_ID,
      }[platform];
      // The app creates its channels on first use: one may exist already
      const [existing] = await q(`SELECT channel_id FROM dbo.channels WHERE platform = @platform AND external_id = @ext`, { platform, ext });
      if (existing) {
        if (!channelOf.has(platform) || ext === (envIdOf || platform)) channelOf.set(platform, existing.channel_id);
        count("channels already present");
        continue;
      }
      const created = dateOf(c.createdAt) || new Date();
      const updated = dateOf(c.updatedAt, c.createdAt) || created;
      const [row] = await q(
        `INSERT dbo.channels (platform, name, external_id, avatar, is_active, is_verified, auto_reply, auto_reply_message,
                              created_date, created_time, updated_date, updated_time)
         OUTPUT INSERTED.channel_id
         VALUES (@platform, @name, @ext, @avatar, @active, @verified, @auto, @autoMsg, @cd, @ct, @ud, @ut)`,
        {
          platform, name: fit(c.name, 255) || platform, ext, avatar: url500(c.avatar),
          active: c.isActive !== false, verified: c.isVerified === true, auto: c.autoReply === true,
          autoMsg: c.autoReplyMessage || null,
          cd: dPart(created), ct: tPart(created), ud: dPart(updated), ut: tPart(updated),
        },
      );
      if (c.accessTokenRef || c.webhookVerifyToken) {
        await q(
          `INSERT dbo.channel_credentials (channel_id, access_token_ref, webhook_verify_token, updated_date, updated_time)
           VALUES (@id, @ref, @verify, @ud, @ut)`,
          { id: row.channel_id, ref: fit(c.accessTokenRef, 255), verify: fit(c.webhookVerifyToken, 255), ud: dPart(updated), ut: tPart(updated) },
        );
      }
      if (platform === "email" && c.emailConfig) {
        await q(
          `INSERT dbo.channel_email_config (channel_id, imap_host, imap_port, smtp_host, smtp_port, username)
           VALUES (@id, @ih, @ip, @sh, @sp, @user)`,
          {
            id: row.channel_id, ih: fit(c.emailConfig.imapHost, 255), ip: Number(c.emailConfig.imapPort) || 993,
            sh: fit(c.emailConfig.smtpHost, 255), sp: Number(c.emailConfig.smtpPort) || 587, user: fit(c.emailConfig.username, 255),
          },
        );
      }
      for (const agent of new Set((c.assignedAgents || []).map(uid).filter(Boolean))) {
        await q(`INSERT dbo.channel_agents (channel_id, user_id) VALUES (@id, @agent)`, { id: row.channel_id, agent });
      }
      // The channel the app will use for this platform (channels.js: env account id, else the platform name)
      if (!channelOf.has(platform) || ext === (envIdOf || platform)) channelOf.set(platform, row.channel_id);
      count("channels");
    }
    const channelFor = async (platform) => {
      if (channelOf.has(platform)) return channelOf.get(platform);
      const envId = {
        facebook: process.env.FACEBOOK_PAGE_ID, instagram: process.env.INSTAGRAM_ACCOUNT_ID,
        whatsapp: process.env.WHATSAPP_PHONE_NUMBER_ID, email: process.env.EMAIL_USER, tiktok: process.env.TIKTOK_ACCOUNT_ID,
      }[platform];
      const [existing] = await q(`SELECT channel_id FROM dbo.channels WHERE platform = @platform AND external_id = @ext`, { platform, ext: fit(envId || platform, 255) });
      if (existing) {
        channelOf.set(platform, existing.channel_id);
        return existing.channel_id;
      }
      const now = new Date();
      const [row] = await q(
        `INSERT dbo.channels (platform, name, external_id, is_active, is_verified, auto_reply, created_date, created_time, updated_date, updated_time)
         OUTPUT INSERTED.channel_id
         VALUES (@platform, @name, @ext, 1, 1, 0, @d, @t, @d, @t)`,
        { platform, name: `${platform.charAt(0).toUpperCase()}${platform.slice(1)} Channel`, ext: fit(envId || platform, 255), d: dPart(now), t: tPart(now) },
      );
      channelOf.set(platform, row.channel_id);
      count("channels");
      return row.channel_id;
    };

    // ── Contacts ─────────────────────────────────────────────────────────────
    // Most recently updated first: it keeps any identity another contact shares
    const contactsSorted = [...mContacts].sort(
      (a, b) => (dateOf(b.updatedAt, b.createdAt) || 0) - (dateOf(a.updatedAt, a.createdAt) || 0),
    );
    const identityOwner = new Map(); // "<platform>:<ext>" -> contact record
    const contactRows = [];
    const usedPhones = new Set();
    const usedMailboxes = new Set();
    for (const c of contactsSorted) {
      const identities = [];
      let mergedInto = null;
      for (const i of c.platformIdentities || []) {
        const platform = platformOf(i.platform);
        const ext = fit(norm(platform, i.externalId), 255);
        if (!PLATFORMS.has(platform) || !ext) continue;
        const key = `${platform}:${ext}`;
        if (identityOwner.has(key)) {
          mergedInto = mergedInto || identityOwner.get(key);
          continue;
        }
        identities.push({ platform, ext, i });
      }
      const custom = c.customFields && typeof c.customFields === "object" && !Array.isArray(c.customFields) ? c.customFields : {};
      if (identities.length === 0 && mergedInto) {
        // A duplicate: its frein history joins the survivor's
        mergedInto.freins.push(...[custom.leadFrein, ...(Array.isArray(custom.leadFreinHistory) ? custom.leadFreinHistory : [])].filter(Boolean));
        count("contacts merged into a duplicate");
        continue;
      }
      if (identities.length === 0) {
        count("contacts skipped (no identity)");
        continue;
      }
      const record = {
        id: crypto.randomUUID(),
        c,
        custom,
        identities,
        freins: [custom.leadFrein, ...(Array.isArray(custom.leadFreinHistory) ? custom.leadFreinHistory : [])].filter(Boolean),
      };
      for (const { platform, ext } of identities) identityOwner.set(`${platform}:${ext}`, record);
      contactRows.push(record);
    }

    const newContact = (platform, ext, name) => {
      const record = {
        id: crypto.randomUUID(),
        c: { displayName: name || (platform === "email" ? ext : "Unknown") },
        custom: {},
        identities: [{ platform, ext, i: { name: name || "Unknown" } }],
        freins: [],
      };
      identityOwner.set(`${platform}:${ext}`, record);
      contactRows.push(record);
      count("contacts created for customers without one");
      return record;
    };
    for (const p of persons.values()) {
      if (!p.person || isThreadId(p.platform, p.person)) continue;
      if (!identityOwner.has(`${p.platform}:${p.person}`)) newContact(p.platform, p.person, p.name);
    }

    const contactValues = [];
    const identityValues = [];
    const fieldValues = [];
    const tagValues = [];
    for (const rec of contactRows) {
      const c = rec.c;
      let phone = fit(c.phone, 30);
      let email = fit(c.email ? String(c.email).toLowerCase() : null, 255);
      for (const { platform, ext } of rec.identities) {
        if (!phone && platform === "whatsapp" && /^\+?\d{6,25}$/.test(ext)) phone = `+${ext.replace(/^\+/, "")}`;
        if (!email && platform === "email" && /^[^\s@]+@[^\s@]+$/.test(ext)) email = ext.toLowerCase().slice(0, 255);
      }
      if (phone && usedPhones.has(phone)) phone = null;
      if (email && usedMailboxes.has(email)) email = null;
      if (phone) usedPhones.add(phone);
      if (email) usedMailboxes.add(email);
      const created = dateOf(c.createdAt) || new Date();
      const updated = dateOf(c.updatedAt, c.createdAt) || created;
      const first = dateOf(c.firstContactAt);
      const last = dateOf(c.lastContactAt);
      const display = !isPlaceholderName(c.displayName) ? c.displayName : rec.identities.map((x) => x.i.name).find((n) => !isPlaceholderName(n)) || c.displayName;
      contactValues.push({
        id: rec.id, dn: fit(display, 255) || "Unknown", em: email, ph: phone, av: url500(c.avatar), tz: fit(c.timezone, 50),
        lo: fit(c.locale, 10), co: fit(c.companyName, 255), jt: fit(c.jobTitle, 255), no: c.notes || null,
        bl: c.isBlocked === true ? 1 : 0, sp: c.isSpam === true ? 1 : 0, vip: c.isVIP === true || c.isVip === true ? 1 : 0,
        fd: dPart(first), ft: tPart(first), ld: dPart(last), lt: tPart(last),
        cd: dPart(created), ct: tPart(created), ud: dPart(updated), ut: tPart(updated),
      });
      for (const { platform, ext, i } of rec.identities) {
        const seen = dateOf(i.lastSeenAt);
        identityValues.push({
          c: rec.id, p: platform, e: ext, u: fit(i.username, 255), n: fit(i.name, 255), a: url500(i.avatar),
          pu: url500(i.profileUrl), sd: dPart(seen), st: tPart(seen),
        });
      }
      // Custom fields: the frein (newest wins, history merged, 20 kept), then the rest as they are
      const freins = rec.freins.filter((f) => f && f.code).sort((a, b) => (dateOf(a.setAt) || 0) - (dateOf(b.setAt) || 0));
      const remap = (f) => ({ ...f, setBy: f.setBy ? String(uid(f.setBy) || "") || null : null });
      if (freins.length) {
        fieldValues.push({ c: rec.id, k: "leadFrein", v: JSON.stringify(remap(freins[freins.length - 1])) });
        const seenAt = new Set();
        const history = freins.filter((f) => {
          const k = `${f.code}|${dateOf(f.setAt)?.getTime()}`;
          if (seenAt.has(k)) return false;
          seenAt.add(k);
          return true;
        });
        fieldValues.push({ c: rec.id, k: "leadFreinHistory", v: JSON.stringify(history.slice(-20).map(remap)) });
        count("freins");
      }
      for (const [k, v] of Object.entries(rec.custom)) {
        if (k === "leadFrein" || k === "leadFreinHistory" || v === undefined || v === null) continue;
        fieldValues.push({ c: rec.id, k: k.slice(0, 100), v: typeof v === "string" ? v : JSON.stringify(v) });
      }
      for (const tag of new Set((c.tags || []).map((t) => fit(t, 100)).filter(Boolean))) tagValues.push({ c: rec.id, t: tag });
    }
    await inBatches(contactValues, (rows) =>
      q(
        `INSERT dbo.contacts (contact_id, display_name, email, phone, avatar, timezone, locale, company_name, job_title, notes,
                              total_conversations, total_messages, is_blocked, is_spam, is_vip,
                              first_contact_date, first_contact_time, last_contact_date, last_contact_time,
                              created_date, created_time, updated_date, updated_time)
         SELECT id, dn, em, ph, av, tz, lo, co, jt, no, 0, 0, bl, sp, vip, fd, ft, ld, lt, cd, ct, ud, ut
         FROM OPENJSON(@rows) WITH (id uniqueidentifier, dn nvarchar(255), em nvarchar(255), ph nvarchar(30), av nvarchar(500),
              tz nvarchar(50), lo nvarchar(10), co nvarchar(255), jt nvarchar(255), no nvarchar(max), bl bit, sp bit, vip bit,
              fd date, ft time(0), ld date, lt time(0), cd date, ct time(0), ud date, ut time(0))`,
        { rows: json(rows) },
      ),
    );
    await inBatches(identityValues, (rows) =>
      q(
        `INSERT dbo.contact_platform_identities (contact_id, platform, external_id, username, name, avatar, profile_url, last_seen_date, last_seen_time)
         SELECT c, p, e, u, n, a, pu, sd, st
         FROM OPENJSON(@rows) WITH (c uniqueidentifier, p nvarchar(20), e nvarchar(255), u nvarchar(255), n nvarchar(255),
              a nvarchar(500), pu nvarchar(500), sd date, st time(0))`,
        { rows: json(rows) },
      ),
    );
    await inBatches(fieldValues, (rows) =>
      q(
        `INSERT dbo.contact_custom_fields (contact_id, field_key, field_value)
         SELECT c, k, v FROM OPENJSON(@rows) WITH (c uniqueidentifier, k nvarchar(100), v nvarchar(max))`,
        { rows: json(rows) },
      ),
    );
    await inBatches(tagValues, (rows) =>
      q(`INSERT dbo.contact_tags (contact_id, tag) SELECT c, t FROM OPENJSON(@rows) WITH (c uniqueidentifier, t nvarchar(100))`, { rows: json(rows) }),
    );
    count("contacts", contactValues.length);
    count("contact identities", identityValues.length);

    // ── Campaigns (the first ad each customer came from) ─────────────────────
    const campaignOf = new Map(); // "<platform>:<adId>" -> campaign_id
    for (const p of persons.values()) {
      if (!p.ad) continue;
      const cp = p.platform === "instagram" || p.platform === "facebook" ? p.platform : /instagram\.com/i.test(p.ad.url || "") ? "instagram" : "facebook";
      const adId = fit(p.ad.adId, 255);
      const key = `${cp}:${adId}`;
      if (!campaignOf.has(key)) {
        const at = p.adAt || new Date();
        const [row] = await q(
          `INSERT dbo.campaigns (channel_id, platform, external_id, title, content_preview, permalink, status, diffusion_date, diffusion_time)
           OUTPUT INSERTED.campaign_id
           VALUES (@ch, @plat, @ad, @title, @preview, @link, N'active', @d, @t)`,
          { ch: await channelFor(p.platform), plat: cp, ad: adId, title: fit(p.ad.title, 255), preview: p.ad.body || null, link: url500(p.ad.url), d: dPart(at), t: tPart(at) },
        );
        campaignOf.set(key, row.campaign_id);
        count("campaigns");
      }
      p.campaignId = campaignOf.get(key);
    }

    // ── Conversations ────────────────────────────────────────────────────────
    const convRows = [];
    const usedExternal = new Set(); // "<platform>:<external_id>"
    for (const p of persons.values()) {
      const threadOnly = isThreadId(p.platform, p.person);
      const customer = threadOnly ? null : p.person;
      let external = p.thread && !usedExternal.has(`${p.platform}:${p.thread}`) ? p.thread : p.person;
      if (usedExternal.has(`${p.platform}:${external}`)) {
        count("conversations skipped (key already used)");
        continue;
      }
      usedExternal.add(`${p.platform}:${external}`);
      const key = personKey(p.platform, p.person);
      const dossier = dossierOf.get(key);
      const lock = lockOf.get(key);
      const contact = customer ? identityOwner.get(`${p.platform}:${customer}`) : null;
      const identity = contact?.identities.find((x) => x.platform === p.platform && x.ext === customer)?.i;

      // The 12-stage pipeline (or the six classifications before it) onto
      // the scripts' Étape + Qualification; a lost lead's reason is its frein
      let previous = dossier?.stage;
      if (!PREVIOUS_STAGE_TO_MODEL[previous]) previous = LEGACY_TO_STAGE[dossier?.classification] || "nouveau_lead";
      const [stage, mapped] = PREVIOUS_STAGE_TO_MODEL[previous];
      let qualificationKey = mapped;
      if (previous === "perdu") {
        const lastFrein = (contact?.freins || [])
          .filter((f) => f && f.code)
          .sort((a, b) => (dateOf(a.setAt) || 0) - (dateOf(b.setAt) || 0))
          .pop();
        if (LOSS_REASON_BY_FREIN[lastFrein?.code]) {
          qualificationKey = LOSS_REASON_BY_FREIN[lastFrein.code];
          count("lost leads given their frein as loss reason");
        }
      }
      if (dossier) count(`dossiers from stage ${previous}`);
      const typologie = isTypology(dossier?.typologie) ? dossier.typologie : "";
      const qualification = r.qualificationToId[qualificationKey];
      const classification = r.stageToClassification[stage];
      const created = dateOf(p.first, dossier?.createdAt, lock?.lockedAt) || new Date();
      const touched = dateOf(dossier?.updatedAt);
      const updated = [p.last, touched].filter(Boolean).reduce((a, b) => (b > a ? b : a), created);
      const rdv = dateOf(dossier?.appointmentAt);
      const lockedBy = uid(lock?.lockedBy);
      const lockedAt = lockedBy ? dateOf(lock.lockedAt, lock.createdAt) || created : null;
      const expires = lockedBy ? dateOf(lock.expiresAt) : null;
      const name = !isPlaceholderName(p.name, customer) ? p.name : !isPlaceholderName(identity?.name, customer) ? identity.name : customer && p.platform === "email" ? customer : "Unknown";
      if (dossier && (dossier.isPriority || dossier.invoiceRef)) count("dossier fields left behind (priority / invoice ref)");
      convRows.push({
        key,
        p: p.platform, e: fit(external, 255), ch: await channelFor(p.platform), ct: contact?.id || null,
        pn: fit(name, 255) || "Unknown", pa: url500(identity?.avatar || contact?.c?.avatar), px: customer ? fit(customer, 255) : null,
        cls: classification, qual: qualification, mot: r.typologyToMotif[typologie], camp: p.campaignId || null,
        cb: dossier ? uid(dossier.classifiedBy) : null, cd: dossier ? dPart(touched) : null, ctm: dossier ? tPart(touched) : null,
        rd: dPart(rdv), rt: tPart(rdv),
        lb: lockedBy, ld: dPart(lockedAt), lt: tPart(lockedAt), ed: dPart(expires), et: tPart(expires),
        crd: dPart(created), crt: tPart(created), upd: dPart(updated), upt: tPart(updated),
        qualificationKey, touched, createdAt: created,
      });
    }
    const conversationId = new Map(); // personKey -> conversation_id
    await inBatches(convRows, async (rows) => {
      const inserted = await q(
        `INSERT dbo.conversations (platform, external_id, channel_id, contact_id, participant_name, participant_avatar, participant_external_id,
                                   status, assigned_to_user_id, classification_id, classified_by_user_id, locked_by_user_id, unread_count, message_count,
                                   motif_id, qualification_id, campaign_id, classified_date, classified_time, appointment_date, appointment_time,
                                   locked_date, locked_time, lock_expires_date, lock_expires_time, created_date, created_time, updated_date, updated_time)
         OUTPUT INSERTED.conversation_id, INSERTED.platform, INSERTED.external_id
         SELECT p, e, ch, ct, pn, pa, px, N'open', lb, cls, cb, lb, 0, 0, mot, qual, camp, cd, ctm, rd, rt, ld, lt, ed, et, crd, crt, upd, upt
         FROM OPENJSON(@rows) WITH (p nvarchar(20), e nvarchar(255), ch int, ct uniqueidentifier, pn nvarchar(255), pa nvarchar(500),
              px nvarchar(255), lb int, cls smallint, cb int, mot smallint, qual smallint, camp int, cd date, ctm time(0), rd date, rt time(0),
              ld date, lt time(0), ed date, et time(0), crd date, crt time(0), upd date, upt time(0))`,
        { rows: json(rows.map(({ key, qualificationKey, touched, createdAt, ...v }) => v)) },
      );
      const byExternal = new Map(inserted.map((x) => [`${x.platform}:${x.external_id}`, x.conversation_id]));
      for (const row of rows) conversationId.set(row.key, byExternal.get(`${row.p}:${row.e}`));
    });
    count("conversations", convRows.length);
    // The (Étape, Qualification) pairs now in use, as the scripts' lead
    // import records its own (decision E27)
    await q(`
      INSERT dbo.classification_qualification_matrix (classification_id, qualification_id)
      SELECT DISTINCT c.classification_id, c.qualification_id FROM dbo.conversations c
      WHERE NOT EXISTS (SELECT 1 FROM dbo.classification_qualification_matrix m
                        WHERE m.classification_id = c.classification_id AND m.qualification_id = c.qualification_id)`);

    // Qualification history: the start as a new lead, then the current
    // qualification when it moved
    const historyValues = [];
    for (const row of convRows) {
      const id = conversationId.get(row.key);
      historyValues.push({ c: id, q: r.defaults.qualificationId, u: null, d: row.crd, t: row.crt });
      if (row.qualificationKey !== DEFAULT_QUALIFICATION) {
        const at = row.touched && row.touched > row.createdAt ? row.touched : new Date(row.createdAt.getTime() + 1000);
        historyValues.push({ c: id, q: row.qual, u: row.cb, d: dPart(at), t: tPart(at) });
      }
    }
    await inBatches(historyValues, (rows) =>
      q(
        `INSERT dbo.conversation_qualification_history (conversation_id, qualification_id, changed_by_user_id, changed_date, changed_time)
         SELECT c, q, u, d, t FROM OPENJSON(@rows) WITH (c int, q smallint, u int, d date, t time(0))`,
        { rows: json(rows) },
      ),
    );

    // ── Pass 2 over messages: the rows themselves, oldest first ──────────────
    const contactOfConversation = new Map(convRows.map((row) => [conversationId.get(row.key), row.ct]));
    const seenMessage = new Set(); // "<conversation_id>:<external id>"
    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      await q(
        `INSERT dbo.message (conversation_id, external_id, sender_type, sender_user_id, sender_contact_id, message_type, content,
                             attachment_url, is_read, sent_date, sent_time, created_date, created_time)
         SELECT c, e, s, u, sc, t, x, a, rd, sd, st, cd, ct
         FROM OPENJSON(@rows) WITH (c int, e nvarchar(255), s nvarchar(10), u int, sc uniqueidentifier, t nvarchar(20), x nvarchar(max),
              a nvarchar(500), rd bit, sd date, st time(0), cd date, ct time(0))`,
        { rows: json(rows) },
      );
    };
    const cursor = mdb.collection("messages").find({}).sort({ timestamp: 1, _id: 1 }).allowDiskUse(true);
    for await (const m of cursor) {
      const platform = platformOf(m.platform);
      if (!PLATFORMS.has(platform)) continue;
      if (isFailed(m)) {
        count("messages left behind (send refused by the platform)");
        continue;
      }
      const person = personOf(m, platform);
      const convId = person ? conversationId.get(personKey(platform, person)) : null;
      if (!convId) continue;
      const ext = fit(m.externalId, 255);
      if (ext) {
        const k = `${convId}:${ext}`;
        if (seenMessage.has(k)) {
          count("messages skipped (same message id twice)");
          continue;
        }
        seenMessage.add(k);
      }
      const incoming = isFromProspect(m);
      const attachments = Array.isArray(m.attachments) ? m.attachments.filter((a) => a && a.url) : [];
      const firstUrl = attachments[0]?.url || m.attachmentUrl || null;
      const kept = url500(firstUrl);
      if (firstUrl && !kept) count("attachment URLs over 500 characters left behind");
      if (attachments.length > 1) count("extra attachments left behind", attachments.length - 1);
      const kind = attachments[0]?.type || m.messageType;
      const type = !kept
        ? "text"
        : ["image", "video", "audio"].includes(kind)
          ? kind
          : kind === "sticker"
            ? "image"
            : "document";
      let content = typeof m.content === "string" ? m.content : "";
      if (firstUrl && !kept && !content.trim()) content = UNAVAILABLE_TEXT;
      const sent = dateOf(m.timestamp, m.createdAt) || new Date(0);
      const created = dateOf(m.createdAt, m.timestamp) || sent;
      batch.push({
        c: convId, e: ext, s: incoming ? "contact" : "agent", u: incoming ? null : uid(m.sentBy),
        sc: incoming ? contactOfConversation.get(convId) || null : null, t: type, x: content, a: kept,
        rd: m.status === "read" ? 1 : 0, sd: dPart(sent), st: tPart(sent), cd: dPart(created), ct: tPart(created),
      });
      count("messages");
      if (m.context) count("message contexts left behind");
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    // ── Counters from what was copied ────────────────────────────────────────
    await q(`
      UPDATE c SET message_count = x.n
      FROM dbo.conversations c JOIN (SELECT conversation_id, n = COUNT(*) FROM dbo.message GROUP BY conversation_id) x
        ON x.conversation_id = c.conversation_id;
      UPDATE ct SET
        total_conversations = x.n_conv,
        total_messages = x.n_msg,
        first_contact_date = COALESCE(CONVERT(date, x.first_at), ct.first_contact_date),
        first_contact_time = COALESCE(CONVERT(time(0), x.first_at), ct.first_contact_time),
        last_contact_date = COALESCE(CONVERT(date, x.last_at), ct.last_contact_date),
        last_contact_time = COALESCE(CONVERT(time(0), x.last_at), ct.last_contact_time)
      FROM dbo.contacts ct
      JOIN (
        SELECT c.contact_id, n_conv = COUNT(DISTINCT c.conversation_id), n_msg = COUNT(m.message_id),
               first_at = MIN(dbo.fn_DateTimeCombine(m.sent_date, m.sent_time)),
               last_at = MAX(dbo.fn_DateTimeCombine(m.sent_date, m.sent_time))
        FROM dbo.conversations c
        LEFT JOIN dbo.message m ON m.conversation_id = c.conversation_id AND m.sender_type = N'contact'
        WHERE c.contact_id IS NOT NULL
        GROUP BY c.contact_id
      ) x ON x.contact_id = ct.contact_id;`);

    // ── Report ───────────────────────────────────────────────────────────────
    const check = (
      await q(`SELECT users = (SELECT COUNT(*) FROM dbo.users), channels = (SELECT COUNT(*) FROM dbo.channels),
                      contacts = (SELECT COUNT(*) FROM dbo.contacts), conversations = (SELECT COUNT(*) FROM dbo.conversations),
                      messages = (SELECT COUNT(*) FROM dbo.message), dossiers = (SELECT COUNT(*) FROM dbo.conversations WHERE classified_date IS NOT NULL),
                      locks = (SELECT COUNT(*) FROM dbo.conversations WHERE locked_by_user_id IS NOT NULL),
                      campaigns = (SELECT COUNT(*) FROM dbo.campaigns)`)
    )[0];
    console.log("\nMongoDB read:", JSON.stringify({ users: mUsers.length, channels: mChannels.length, contacts: mContacts.length, classifications: mClassifications.length, locks: mLocks.length }));
    console.log("Report:");
    for (const [k, v] of Object.entries(report).sort()) console.log(`  ${k}: ${v}`);
    console.log("SQL Server now holds:", JSON.stringify(check));

    if (COMMIT) {
      await _tx.commit();
      console.log("\nCommitted. Run the warehouse load next (the app does it daily, or call dbo.usp_run_etl).");
    } else {
      await _tx.rollback();
      console.log("\nDry run: rolled back. Nothing was written (except the reference rows the app inserts anyway).");
    }
  } catch (err) {
    try {
      await _tx.rollback();
    } catch {
      // already rolled back by the server
    }
    throw err;
  } finally {
    await mongo.close();
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("Migration failed, nothing was written:", err.stack || err.message);
    await closePool();
    process.exit(1);
  });
