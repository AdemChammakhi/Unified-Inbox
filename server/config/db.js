const { getPool } = require("../db/sql");
const { ensureReferenceRows } = require("../db/reference");
const {
  ensureWarehouseRows,
  scheduleWarehouseEtl,
} = require("../db/warehouse");

// A SQL Server container that starts alongside the backend can take half a
// minute to accept logins: keep trying for about a minute before giving up.
const CONNECT_ATTEMPTS = 30;
const CONNECT_RETRY_MS = 2000;

/**
 * Connect to SQL Server (UnifiedBox1) and load what every request needs.
 * The schema itself is never touched (database/sqlserver/decisions.md, D5):
 * only missing reference rows are inserted. Exits the process when the
 * operational database stays unreachable; the warehouse is optional.
 */
const connectDB = async () => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const pool = await getPool();
      console.log(
        `SQL Server connected: ${pool.config.server}/${pool.config.database}`,
      );
      // Idempotent: stages, typologies and the funnel as lookup rows, and
      // the code <-> id maps the routes use.
      await ensureReferenceRows();
      break;
    } catch (error) {
      if (attempt >= CONNECT_ATTEMPTS) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      console.warn(
        `[Startup] SQL Server not ready (${error.message}), retry ${attempt}/${CONNECT_ATTEMPTS - 1}`,
      );
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
  // The warehouse's unknown members and statuses, then its daily load.
  // Never blocks or fails startup.
  ensureWarehouseRows().catch((e) =>
    console.error("[Startup] Warehouse rows not ensured:", e.message),
  );
  scheduleWarehouseEtl();
};

module.exports = connectDB;
