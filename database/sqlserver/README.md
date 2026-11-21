# SQL Server: UnifiedBox1 and UnifiedBoxDW

The app's database is SQL Server. The schema is the two SSMS scripts in
`schema/` (revision of 5 Oct 2026), **used as they are**: the app adapts to
them, the two files are never altered (decisions D5 and D9 in
[decisions.md](decisions.md)). The defects of their stored procedures are
fixed on top of them by `schema-fixes.sql` (D16): procedures only, no table,
column, constraint or index.

| File | What it is |
|---|---|
| `schema/dbunifedbox.sql` | UnifiedBox1, the operational database the app reads and writes |
| `schema/dwunifiedbox.sql` | UnifiedBoxDW, the warehouse, fed by its own procedures (`dbo.usp_run_etl`) |
| `deploy.sh` | Creates both databases from the scripts (only the data-file folder is adapted to Linux), seeds the warehouse's unknown members, optionally creates the app's login |
| `schema-fixes.sql` | The fixes to the scripts' stored procedures (D16), applied by `deploy.sh` after the scripts; idempotent |
| `warehouse-rows.sql` | The rows the warehouse procedures expect and no script creates (run by `deploy.sh`) |
| `app-login.sql` | The least-privilege login `unifiedbox_app` (run by `deploy.sh`) |
| `migrate-from-mongodb.js` | One-time copy of the MongoDB data (decision D7) |
| `cutover.sh` | The production switch on the VPS: rehearsal, scheduled cutover with automatic rollback (D17) |
| `backup.sh` | Backs both databases up out of the container, with a restore test and a nightly cron (D17) |
| `smoke-test.js` | Run inside a backend container: is it alive on SQL Server? Used by `cutover.sh` |
| `decisions.md` | Every owner and engineering decision behind this |

Both databases must live on **one instance**: the warehouse reads UnifiedBox1
through cross-database synonyms (so not Azure SQL Database).

## How the app uses the schema

- `server/db/sql.js`: connection pool (`SQLSERVER_*` variables) and helpers.
  Timestamps are stored as UTC `date` + `time(0)` pairs, read back with the
  schema's `dbo.fn_DateTimeCombine`.
- `server/db/reference.js`: at startup, inserts the missing lookup rows, puts
  back the group, terminal flag and sort order of the ones it knows, and loads
  the code ↔ id maps. The labels are the scripts' CHECK lists (decision D9):
  the 7 funnel steps (Étape) are `classifications`, the 10 statuses
  (Qualification) `qualifications`, and the typologies `motifs_contact`, plus
  "Non spécifié" when it is not known yet.
- `server/db/conversations.js`: one row per customer per platform.
  `participant_external_id` is the customer id; `external_id` is Meta's thread
  id once known (else the customer id). Every lookup accepts either. The
  (Étape, Qualification) pairs in use are registered in
  `classification_qualification_matrix`, as the scripts' lead import does.
- `server/db/messages.js`: the document's `message` table; direction, sender
  names and ids are derived when reading. Dedupe on the platform message id
  per conversation.
- `server/db/warehouse.js`: extends the calendar, then runs
  `dbo.usp_run_etl` daily (Express has no SQL Agent).

## Local development

```bash
docker run -d --name unifiedbox-sql -e ACCEPT_EULA=Y -e MSSQL_PID=Express \
  -e MSSQL_SA_PASSWORD='<a strong password>' -p 127.0.0.1:1433:1433 \
  mcr.microsoft.com/mssql/server:2025-latest
docker cp database/sqlserver/. unifiedbox-sql:/tmp/unifiedbox-schema
docker exec unifiedbox-sql bash /tmp/unifiedbox-schema/deploy.sh
```

Then in `.env`: `SQLSERVER_HOST=localhost`, `SQLSERVER_USER=sa` (or the app
login), `SQLSERVER_PASSWORD`, `SQLSERVER_TRUST_SERVER_CERTIFICATE=true`
(see `.env.example`). `npm run server:dev` connects, inserts the reference
rows and starts listening once they are loaded.

## Production cutover, scripted (decision D17)

`cutover.sh` does the whole switch on the VPS. It never edits the compose
file: SQL Server runs as a standalone container named `sqlserver` on the
app's network, which the pipeline's `up -d --remove-orphans` leaves alone.

1. **The new images.** The backend and frontend images must be the SQL Server
   build. The pipeline builds and pushes them (`…:latest` and a commit tag) for
   a pull request to `main`, without deploying. Do not merge before the
   cutover: a merge deploys.
2. **Copy this repo's `database/` folder** to `/opt/unified-inbox/database`.
3. **Rehearse, on the real data, without touching production:**
   `bash database/sqlserver/cutover.sh prepare`. It starts SQL Server, creates
   the databases, pulls and checks the new images, then migrates everything,
   starts a temporary new backend on the result, runs the smoke test and a
   warehouse load, and takes a backup with a restore test. MongoDB is only
   read. Read the migration report it prints.
4. **Schedule the switch:** `bash database/sqlserver/cutover.sh schedule` (the
   next midnight, Africa/Tunis; or `schedule '2026-11-20 00:00'`). At that
   time it dumps MongoDB, stops the backend, migrates all the data into empty
   databases, starts the new images, checks them, takes a first backup and
   installs the nightly one. Any failure puts the previous backend back on
   MongoDB by itself. `status` shows where things stand; the logs are in
   `/opt/unified-inbox/cutover/`. The timer does not survive a reboot.
5. **Afterwards:** every user signs in again. MongoDB keeps running, untouched:
   `cutover.sh rollback` returns to it (messages received since the switch
   exist only in SQL Server). Merge the pull request once satisfied. Set
   `BACKUP_COPY_CMD` so the nightly backups leave the server (see `backup.sh`).

The steps below describe the same thing done by hand, for reference.

## Production by hand (VPS, decision D8)

The VPS compose file `/opt/unified-inbox/docker-compose.prod.yml` is the
source of truth and is **never** replaced by the repo copy (CLAUDE.md §14).
Apply these changes to it by hand; the repo's `docker-compose.prod.yml` shows
them in place.

1. **Memory.** SQL Server refuses to start with less than 2 GB. Check
   `free -h` on the VPS: the `sqlserver` service is capped at 2 GB, on top of
   the backend's 512 MB.
2. **The service.** Add the `sqlserver` service and the `sqlserver-data`
   volume, and `depends_on: sqlserver: condition: service_healthy` to the
   backend. Create `/opt/unified-inbox/sqlserver.env` (mode 600) with one line,
   `MSSQL_SA_PASSWORD=<strong password>`; it is the SQL Server container's
   only env file, so `sa` never reaches the backend. Start it:
   `docker compose -f docker-compose.prod.yml up -d sqlserver`.
3. **The databases and the app login.** Copy this folder to the VPS (not the
   compose file), then:
   ```bash
   docker cp database/sqlserver/. sqlserver:/tmp/unifiedbox-schema
   docker exec -e UNIFIEDBOX_APP_PASSWORD='<letters+digits, upper and lower case>' \
     sqlserver bash /tmp/unifiedbox-schema/deploy.sh
   ```
   Generate the password with
   `openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32`.
4. **The backend's environment** (the VPS `.env`): `SQLSERVER_HOST=sqlserver`,
   `SQLSERVER_USER=unifiedbox_app`, `SQLSERVER_PASSWORD=<the same password>`,
   `SQLSERVER_TRUST_SERVER_CERTIFICATE=true`, and `PUBLIC_URL`. `MONGO_URI` is
   no longer read; `BCF_URI` stays (the support desk keeps its MongoDB).
5. **The data** (decision D7), during a maintenance window with the old
   backend stopped so no message arrives meanwhile. The new backend image has
   Node and every module the script needs; run it on the compose network with
   the backend's environment (the `SQLSERVER_*` variables, and the production
   `FACEBOOK_PAGE_ID`, `INSTAGRAM_ACCOUNT_ID`, `WHATSAPP_PHONE_NUMBER_ID` and
   `EMAIL_USER`, which tell our messages from the customers'):
   ```bash
   cd /opt/unified-inbox   # with this repo's database/ folder copied next to the compose file
   # 1. a dry run: everything is written, reported, then rolled back
   docker compose -f docker-compose.prod.yml run --rm --no-deps \
     -v "$PWD/database:/app/database:ro" backend \
     node database/sqlserver/migrate-from-mongodb.js --mongo-uri "$MONGODB_URI"   # the address the current backend uses
   # 2. the real copy, into an empty UnifiedBox1: the same with --commit at the end
   ```
   MongoDB is only read. Run the dry run against a copy first. The report
   lists everything left behind (D3, D6). Users keep their passwords but must
   sign in again.
6. **Deploy** the new backend and frontend images, then check the logs for
   `SQL Server connected` and `[Warehouse] Daily ETL scheduled`. Keep the
   MongoDB container stopped but not removed until the owner signs off:
   going back means redeploying the previous images, and messages received
   since the switch exist only in SQL Server.
7. **Backups.** `bash database/sqlserver/backup.sh --install-cron` (see the
   script; the cutover installs it). By hand it would be, for each database,
   `docker exec sqlserver bash -c '/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -b -Q "BACKUP DATABASE UnifiedBox1 TO DISK = N'"'"'/var/opt/mssql/data/UnifiedBox1.bak'"'"' WITH INIT"'`
   and copying the `.bak` files off the VPS.
8. **Power BI.** `deploy.sh` creates the login `powerbi_reader` with a random
   password; set one with `ALTER LOGIN powerbi_reader WITH PASSWORD = …`.
   Port 1433 is bound to 127.0.0.1 only: reach it through an SSH tunnel or a
   gateway, never by opening it to the internet.
