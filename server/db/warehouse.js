/**
 * warehouse.js — keeps UnifiedBoxDW loadable and loads it once a day.
 *
 * The warehouse procedures (database/sqlserver/schema/dwunifiedbox.sql) are used
 * as they are (decision D5). They expect rows no script creates, so the app
 * inserts the missing ones — rows only, never schema:
 *  - the "unknown" member -1 of every dimension the facts fall back on;
 *  - the conversation statuses in dim_status;
 *  - a French calendar in dim_date covering every date the facts reference,
 *    extended before each run.
 * Before each run it also puts the reference rows back in shape (reference.js):
 * a lead import since the app started may have given a qualification the
 * wrong group, and the "won" flag reads the group (decisions.md E23).
 * Then it runs dbo.usp_run_etl, which logs each step in dbo.etl_log.
 *
 * SQL Server Express has no SQL Agent, so the daily run is scheduled here:
 * WAREHOUSE_ETL_HOUR (default 2, Africa/Tunis). WAREHOUSE_ETL_DISABLED=true
 * turns it off. The database name comes from SQLSERVER_DW_DATABASE.
 */

"use strict";

const { db } = require("./sql");
const { ensureReferenceRows } = require("./reference");

const DW = () => `[${(process.env.SQLSERVER_DW_DATABASE || "UnifiedBoxDW").replace(/]/g, "")}]`;

/** The conversation statuses CK_conv_status allows. */
const STATUSES = [
  ["open", "Ouvert"],
  ["pending", "En attente"],
  ["resolved", "Résolu"],
];

/**
 * The -1 rows, dim_status and the statuses. Idempotent. Keep in step with
 * database/sqlserver/warehouse-rows.sql, which deploy.sh runs as sa so these
 * rows exist before the app's own login (no ALTER right for IDENTITY_INSERT)
 * ever needs them.
 */
async function ensureWarehouseRows() {
  const dw = DW();
  await db.query(`
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_agent WHERE agent_key = -1)
    BEGIN
      SET IDENTITY_INSERT ${dw}.dbo.dim_agent ON;
      INSERT ${dw}.dbo.dim_agent (agent_key, user_id, full_name, role, is_active, effective_date, expiry_date, is_current)
      VALUES (-1, NULL, N'Non attribué', NULL, 0, '19000101', NULL, 1);
      SET IDENTITY_INSERT ${dw}.dbo.dim_agent OFF;
    END
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_channel WHERE channel_key = -1)
    BEGIN
      SET IDENTITY_INSERT ${dw}.dbo.dim_channel ON;
      INSERT ${dw}.dbo.dim_channel (channel_key, channel_id, platform, channel_name, external_id, is_active, is_verified, auto_reply, effective_date, expiry_date, is_current)
      VALUES (-1, NULL, N'inconnu', N'Canal inconnu', NULL, 0, 0, 0, '19000101', NULL, 1);
      SET IDENTITY_INSERT ${dw}.dbo.dim_channel OFF;
    END
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_campaign WHERE campaign_key = -1)
    BEGIN
      SET IDENTITY_INSERT ${dw}.dbo.dim_campaign ON;
      INSERT ${dw}.dbo.dim_campaign (campaign_key, campaign_id, platform, title, content_preview, permalink, date_diffusion, status)
      VALUES (-1, NULL, NULL, N'Sans campagne', NULL, NULL, NULL, NULL);
      SET IDENTITY_INSERT ${dw}.dbo.dim_campaign OFF;
    END
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_contact WHERE contact_key = -1)
    BEGIN
      SET IDENTITY_INSERT ${dw}.dbo.dim_contact ON;
      INSERT ${dw}.dbo.dim_contact (contact_key, contact_id, display_name, email, phone, company_name, job_title, is_vip, is_blocked, is_spam, effective_date, expiry_date, is_current)
      VALUES (-1, NULL, N'Contact inconnu', NULL, NULL, NULL, NULL, 0, 0, 0, '19000101', NULL, 1);
      SET IDENTITY_INSERT ${dw}.dbo.dim_contact OFF;
    END
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_classification WHERE classification_key = -1)
      INSERT ${dw}.dbo.dim_classification (classification_key, classification_label_fr, sort_order) VALUES (-1, N'Inconnue', 255);
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_qualification WHERE qualification_key = -1)
      INSERT ${dw}.dbo.dim_qualification (qualification_key, qualification_label, qualification_group, is_terminal) VALUES (-1, N'Inconnue', N'Nouveau', 0);
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_motif_contact WHERE motif_key = -1)
      INSERT ${dw}.dbo.dim_motif_contact (motif_key, motif_label_fr) VALUES (-1, N'Inconnu');
    IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_status WHERE status_key = -1)
      INSERT ${dw}.dbo.dim_status (status_key, status_code, status_label_fr) VALUES (-1, N'unknown', N'Inconnu');
  `);
  for (const [code, label] of STATUSES) {
    await db.query(
      `IF NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_status WHERE status_code = @code)
         INSERT ${dw}.dbo.dim_status (status_key, status_code, status_label_fr)
         SELECT ISNULL(MAX(status_key), 0) + 1, @code, @label FROM ${dw}.dbo.dim_status WHERE status_key > 0;`,
      { code, label },
    );
  }
}

/**
 * Every day from Jan 1 of the earliest date the facts can reference to Dec 31
 * of the year after the latest one (or after today). Only missing days are added.
 */
async function ensureCalendar() {
  const dw = DW();
  const r = await db.query(`
    DECLARE @today date = CONVERT(date, SYSUTCDATETIME()), @from date, @to date;
    SELECT @from = MIN(d), @to = MAX(d) FROM (
      SELECT MIN(created_date) FROM dbo.conversations UNION ALL SELECT MAX(created_date) FROM dbo.conversations
      UNION ALL SELECT MIN(updated_date) FROM dbo.conversations UNION ALL SELECT MAX(updated_date) FROM dbo.conversations
      UNION ALL SELECT MIN(classified_date) FROM dbo.conversations WHERE classified_date IS NOT NULL
      UNION ALL SELECT MAX(classified_date) FROM dbo.conversations WHERE classified_date IS NOT NULL
      UNION ALL SELECT MIN(appointment_date) FROM dbo.conversations WHERE appointment_date IS NOT NULL
      UNION ALL SELECT MAX(appointment_date) FROM dbo.conversations WHERE appointment_date IS NOT NULL
      UNION ALL SELECT MIN(sent_date) FROM dbo.message UNION ALL SELECT MAX(sent_date) FROM dbo.message
      UNION ALL SELECT MIN(call_date) FROM dbo.call_log UNION ALL SELECT MAX(call_date) FROM dbo.call_log
      UNION ALL SELECT @today
    ) AS x (d)
    WHERE d IS NOT NULL;
    SET @from = DATEFROMPARTS(YEAR(@from), 1, 1);
    SET @to = DATEFROMPARTS(YEAR(@to) + 1, 12, 31);

    WITH n AS (
      SELECT TOP (DATEDIFF(DAY, @from, @to) + 1) i = ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1
      FROM sys.all_objects a CROSS JOIN sys.all_objects b
    ),
    d AS (
      SELECT full_date = DATEADD(DAY, n.i, @from),
             weekday = ((DATEDIFF(DAY, '19000101', DATEADD(DAY, n.i, @from)) % 7) + 7) % 7   -- 0 = Monday
      FROM n
    )
    INSERT ${dw}.dbo.dim_date (date_key, full_date, day_name_fr, week_number, month_number, month_name_fr,
                               month_year_label, quarter, year, is_weekend)
    SELECT CONVERT(int, CONVERT(char(8), d.full_date, 112)), d.full_date,
           CHOOSE(d.weekday + 1, N'Lundi', N'Mardi', N'Mercredi', N'Jeudi', N'Vendredi', N'Samedi', N'Dimanche'),
           DATEPART(ISO_WEEK, d.full_date), MONTH(d.full_date),
           CHOOSE(MONTH(d.full_date), N'Janvier', N'Février', N'Mars', N'Avril', N'Mai', N'Juin', N'Juillet',
                  N'Août', N'Septembre', N'Octobre', N'Novembre', N'Décembre'),
           CONCAT(RIGHT(CONCAT(N'0', MONTH(d.full_date)), 2), N'/', YEAR(d.full_date)),
           DATEPART(QUARTER, d.full_date), YEAR(d.full_date),
           CASE WHEN d.weekday IN (5, 6) THEN 1 ELSE 0 END
    FROM d
    WHERE NOT EXISTS (SELECT 1 FROM ${dw}.dbo.dim_date x WHERE x.full_date = d.full_date);
    SELECT added = @@ROWCOUNT;
  `);
  return r.rows[0]?.added || 0;
}

let _running = null;

/** Seed what is missing, then run dbo.usp_run_etl. One run at a time. */
function runWarehouseEtl() {
  if (_running) return _running;
  _running = (async () => {
    const started = Date.now();
    await ensureReferenceRows();
    await ensureWarehouseRows();
    const days = await ensureCalendar();
    const dw = DW();
    const before = await db.scalar(`SELECT ISNULL(MAX(etl_log_id), 0) FROM ${dw}.dbo.etl_log`);
    let failure = null;
    try {
      await db.query(`EXEC ${dw}.dbo.usp_run_etl;`);
    } catch (err) {
      failure = err;
    }
    const steps = (
      await db.query(
        `SELECT step_name, status, error_message FROM ${dw}.dbo.etl_log WHERE etl_log_id > @before ORDER BY etl_log_id`,
        { before },
      )
    ).rows;
    const ms = Date.now() - started;
    if (failure) {
      console.error(`[Warehouse] ETL failed after ${ms} ms:`, failure.message);
      throw failure;
    }
    console.log(`[Warehouse] ETL done in ${ms} ms: ${steps.length} steps, ${days} calendar days added`);
    return { ms, steps, calendarDaysAdded: days };
  })().finally(() => {
    _running = null;
  });
  return _running;
}

/** Milliseconds until the next occurrence of `hour`:00 in Africa/Tunis. */
function msUntilHour(hour) {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Tunis",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const secondsNow = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  let wait = hour * 3600 - secondsNow;
  if (wait <= 0) wait += 24 * 3600;
  return wait * 1000;
}

/** Schedule the daily run. Returns a function that cancels it. */
function scheduleWarehouseEtl() {
  if (process.env.WAREHOUSE_ETL_DISABLED === "true") {
    console.log("[Warehouse] Daily ETL disabled (WAREHOUSE_ETL_DISABLED=true)");
    return () => {};
  }
  const hour = Math.min(23, Math.max(0, Number(process.env.WAREHOUSE_ETL_HOUR ?? 2) || 0));
  let timer = null;
  const arm = () => {
    timer = setTimeout(() => {
      runWarehouseEtl()
        .catch(() => {})
        .finally(arm);
    }, msUntilHour(hour));
    if (typeof timer.unref === "function") timer.unref();
  };
  arm();
  console.log(`[Warehouse] Daily ETL scheduled at ${String(hour).padStart(2, "0")}:00 Africa/Tunis`);
  return () => clearTimeout(timer);
}

module.exports = { ensureWarehouseRows, ensureCalendar, runWarehouseEtl, scheduleWarehouseEtl };
