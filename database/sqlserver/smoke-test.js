#!/usr/bin/env node
/**
 * smoke-test.js — is this backend alive on SQL Server?
 *
 * Runs INSIDE a backend container (cutover.sh copies it there), with the
 * container's own environment:
 *
 *   docker cp database/sqlserver/smoke-test.js backend:/tmp/
 *   docker exec -w /app backend node /tmp/smoke-test.js [--etl]
 *
 * Checks the HTTP server, that a login reaches the database (a made-up
 * account must be refused with 401), the row counts, that the prospect sheet
 * builds from the data, and with --etl a full warehouse load. Reads only,
 * except the warehouse load. Prints one JSON line and exits 0 when all pass.
 */

"use strict";

const path = require("path");
const root = process.cwd();
const mod = (p) => require(path.join(root, p));

async function main() {
  const out = { ok: false };
  const base = `http://127.0.0.1:${process.env.PORT || 5000}`;

  out.health = (await fetch(`${base}/`)).status;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "smoke-test@invalid.example", password: "not-a-real-account" }),
  });
  out.loginRefused = login.status;

  const { db, closePool } = mod("server/db/sql");
  const { ensureReferenceRows } = mod("server/db/reference");
  await ensureReferenceRows();
  out.counts = await db.one(
    `SELECT users = (SELECT COUNT(*) FROM dbo.users),
            contacts = (SELECT COUNT(*) FROM dbo.contacts),
            conversations = (SELECT COUNT(*) FROM dbo.conversations),
            messages = (SELECT COUNT(*) FROM dbo.message),
            calls = (SELECT COUNT(*) FROM dbo.call_log),
            locked = (SELECT COUNT(*) FROM dbo.conversations WHERE locked_by_user_id IS NOT NULL)`,
  );

  const { buildProspectRows } = mod("server/routes/exports");
  const rows = await buildProspectRows({ platform: null, since: null });
  out.sheetRows = rows.length;
  out.stages = {};
  for (const r of rows) out.stages[r.classification] = (out.stages[r.classification] || 0) + 1;

  if (process.argv.includes("--etl")) {
    const { runWarehouseEtl } = mod("server/db/warehouse");
    const etl = await runWarehouseEtl();
    out.etl = { steps: etl.steps.length, failed: etl.steps.filter((s) => s.status !== "SUCCESS").map((s) => s.step_name) };
  }

  out.ok =
    out.health === 200 &&
    out.loginRefused === 401 &&
    out.counts.users > 0 &&
    (!out.etl || (out.etl.steps === 10 && out.etl.failed.length === 0));
  console.log(JSON.stringify(out));
  await closePool();
  process.exit(out.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
