/**
 * sql.js — the SQL Server connection to UnifiedBox1 and small query helpers.
 *
 * The schema is fixed (database/sqlserver/schema, decision D5 in
 * database/sqlserver/decisions.md): every timestamp is stored as a UTC `date`
 * plus a `time(0)`, so writers pass `at(date)` and readers select
 * `dbo.fn_DateTimeCombine(x_date, x_time)`, the schema's own function.
 *
 * Connection settings come from SQLSERVER_* variables (see .env.example).
 */

"use strict";

const sql = require("mssql");

let _pool = null;

function connectionConfig() {
  const env = process.env;
  return {
    server: env.SQLSERVER_HOST || "localhost",
    port: Number(env.SQLSERVER_PORT) || 1433,
    user: env.SQLSERVER_USER,
    password: env.SQLSERVER_PASSWORD,
    database: env.SQLSERVER_DATABASE || "UnifiedBox1",
    connectionTimeout: 15000,
    requestTimeout: 120000,
    options: {
      encrypt: env.SQLSERVER_ENCRYPT !== "false",
      trustServerCertificate: env.SQLSERVER_TRUST_SERVER_CERTIFICATE === "true",
      useUTC: true,
      enableArithAbort: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
}

/** The shared pool, connected on first use. A failed connect is retried next call. */
function getPool() {
  if (!_pool) {
    _pool = new sql.ConnectionPool(connectionConfig())
      .connect()
      .catch((err) => {
        _pool = null;
        throw err;
      });
  }
  return _pool;
}

async function closePool() {
  if (!_pool) return;
  const pool = await _pool.catch(() => null);
  _pool = null;
  if (pool) await pool.close();
}

// ─── Parameters ──────────────────────────────────────────────────────────────

/** A value with an explicit SQL type. */
function typed(type, value) {
  return { __typed: true, type, value: value === undefined ? null : value };
}

/** A UTC instant truncated to the second, as the time(0) columns keep it. */
function toSecond(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

/**
 * The two parameters of a split timestamp column pair:
 *   { ...at("sent", message.timestamp) }  →  @sent_date, @sent_time
 */
function at(prefix, value) {
  const d = toSecond(value);
  return {
    [`${prefix}_date`]: typed(sql.Date, d),
    [`${prefix}_time`]: typed(sql.Time(0), d),
  };
}

const guid = (value) => typed(sql.UniqueIdentifier, value || null);

/** An id list for OPENJSON(@name): one parameter whatever its length. */
const jsonList = (values) =>
  typed(sql.NVarChar(sql.MAX), JSON.stringify([...new Set((values || []).filter((v) => v !== null && v !== undefined && v !== "").map(String))]));

function inferType(value) {
  if (value === null || value === undefined) return sql.NVarChar(sql.MAX);
  if (typeof value === "boolean") return sql.Bit;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return sql.Float;
    return Math.abs(value) > 2147483647 ? sql.BigInt : sql.Int;
  }
  if (value instanceof Date) return sql.DateTime2(0);
  const text = String(value);
  return sql.NVarChar(text.length > 4000 ? sql.MAX : 4000);
}

function bind(request, params) {
  for (const [name, raw] of Object.entries(params || {})) {
    if (raw && raw.__typed) request.input(name, raw.type, raw.value);
    else request.input(name, inferType(raw), raw === undefined ? null : raw);
  }
  return request;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

function makeRunner(getRequest) {
  const run = async (text, params) => {
    const result = await bind(await getRequest(), params).query(text);
    return {
      rows: result.recordset || [],
      recordsets: result.recordsets || [],
      rowsAffected: (result.rowsAffected || []).reduce((a, b) => a + b, 0),
    };
  };
  return {
    query: run,
    one: async (text, params) => (await run(text, params)).rows[0] || null,
    scalar: async (text, params) => {
      const row = (await run(text, params)).rows[0];
      return row ? Object.values(row)[0] : null;
    },
  };
}

const db = makeRunner(async () => (await getPool()).request());

/**
 * Run `work(t)` in one transaction; `t` has the same query/one/scalar methods.
 * Rolls back and rethrows on error.
 */
async function tx(work) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  const t = makeRunner(() => new sql.Request(transaction));
  try {
    const out = await work(t);
    await transaction.commit();
    return out;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      // already rolled back by the server (XACT_ABORT) — keep the first error
    }
    throw err;
  }
}

/**
 * Serialize work on one key for the rest of the transaction, e.g. so two
 * webhooks for the same customer never create two conversation rows (the
 * schema has no unique key on participant_external_id).
 */
async function lockKey(t, resource) {
  const status = await t.scalar(
    `DECLARE @r int;
     EXEC @r = sys.sp_getapplock @Resource = @resource, @LockMode = 'Exclusive',
                                 @LockOwner = 'Transaction', @LockTimeout = 10000;
     SELECT @r;`,
    { resource: String(resource).slice(0, 255) },
  );
  if (status < 0) throw new Error(`Could not lock ${resource} (sp_getapplock ${status})`);
}

// ─── Errors ──────────────────────────────────────────────────────────────────

const errorNumber = (err) => err?.number ?? err?.originalError?.info?.number ?? null;

/** Unique constraint (2627) or unique index (2601). */
const isDuplicateKey = (err) => [2627, 2601].includes(errorNumber(err));

/** Foreign key or CHECK constraint (547). */
const isConstraintViolation = (err) => errorNumber(err) === 547;

module.exports = {
  sql,
  getPool,
  closePool,
  db,
  tx,
  lockKey,
  typed,
  at,
  guid,
  jsonList,
  toSecond,
  isDuplicateKey,
  isConstraintViolation,
  errorNumber,
};
