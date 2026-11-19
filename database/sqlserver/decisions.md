# SQL Server migration: decision log

Every entry says who decided and what follows from it. **Do not reverse an
owner decision in code without a new entry here.**

D1 to D4 and E1 to E8 were first recorded on 15 Sept 2026 in the gitignored
`docs/migration/decisions.md`; they are copied here unchanged, with D5 to D8
(24 Sept 2026) superseding parts of them, D9 (6 Oct 2026) replacing the
scripts with their revision, D10 and D11 (29 Oct 2026) bringing back the
stages and the 22 Oct features, and D12 to D15 (17 Nov 2026) the next update.

---

## Owner decisions

### D1. Scope: SQL Server replaces MongoDB as the operational database
*Decided by the project owner, 15 Sept 2026.*

MongoDB is removed as the application's database. The target schema is section 2
of `docs/SCHEMA-NERMINE.md` (Nermine Benabderrahmen). The React frontend is
adapted to it afterwards. **(Target superseded by D5.)**

- Supersedes the scope of `docs/PLAN-PILOTAGE-COMMERCIAL.md` §5, which fed a
  warehouse from MongoDB.
- **Exception:** the Better Call Fedi support desk keeps its external MongoDB.
  That cluster belongs to another party under a shared contract, so the
  `mongodb` driver and `BCF_URI` stay, for that integration only.

### D2. Local development database
*Decided by the project owner, 15 Sept 2026.*

SQL Server 2025 **Express** in Docker. Microsoft's SQL Server license terms were
accepted by the owner for local development. LocalDB was rejected as the app's
dev database because Node cannot reach it with the installed drivers.

### D3. Message table follows the document strictly
*Decided by the project owner, 15 Sept 2026, after being shown what is lost.*

No extension tables or columns are added to `message`. The following data is
**deliberately not migrated**, and the features that depend on it are **removed**
during the frontend phase:

| Dropped data | Feature removed |
|---|---|
| `Message.context`: the ad, post or story a customer replied to, including the Click-to-WhatsApp click id | "Replied to your ad" card in threads, and the ad-attribution dashboard panel as it works today |
| Attachments beyond the first, and each attachment's name and MIME type | Multi-attachment messages and file names |
| Delivery status `sent` / `delivered` / `failed` (only `is_read` remains) | Failed-send indicator |
| Per-message sender name | Name shown on each bubble; names come from the contact instead |
| Email subject and HTML body (plain `content` remains) | Subject line and rich email rendering |
| Raw sender and recipient platform ids on each message | Per-message key repair logic |

**What still works:** one attachment per message through `attachment_url`, with
its kind from `message_type`. For WhatsApp that URL keeps the media proxy path
`/api/whatsapp/media/:mediaId`, so a single inbound photo, voice note or video
still displays.

### D4. Mapping of today's six classifications
*Decided by the project owner, 15 Sept 2026: the proposed mapping.*
**(The `is_priority` column is withdrawn by D5; priority is removed by D6; the
mapping is replaced by E25, under D9.)**

| Today | classification | qualification | motif | is_priority | appointment_at |
|---|---|---|---|---|---|
| `non_classifie` | Non ouvert | Nouveau lead | Non renseigné | 0 | NULL |
| `cible` | Contact établi | En cours | Non renseigné | 0 | NULL |
| `hors_cible` | Contact établi | Hors cible | Non renseigné | 0 | NULL |
| `suivi` | Contact établi | En réflexion | Non renseigné | 0 | NULL |
| `priorite` | Contact établi | En cours | Non renseigné | **1** | NULL |
| `rdv` | Contact établi | En cours | Non renseigné | 0 | **kept** |

New conversations default to **Non ouvert + Nouveau lead + Non renseigné**.

### D5. The two SSMS scripts are the schema, unaltered
*Decided by the project owner, 24 Sept 2026. Supersedes the target of D1 and
the additions of D4.*

The schema is no longer section 2 of `docs/SCHEMA-NERMINE.md` but the two
scripts generated from SSMS on 23 Sept 2026, kept verbatim in
`database/sqlserver/schema/`: `dbunifedbox.sql` (UnifiedBox1, the operational
database) and `dwunifiedbox.sql` (UnifiedBoxDW, the warehouse). They are **not
altered**: no table, column, constraint, index, view or procedure is added or
changed. The app adapts to them. The databases only receive rows (reference
values, the warehouse calendar and unknown members), never schema changes.
**(The scripts are now their 5 Oct 2026 revision: D9.)**

- D4's additions are withdrawn: there is no `conversations.is_priority`. The
  "Non renseigné" motif is a row, so it stays.
- E1, E2, E3, E7 and E8 are withdrawn: the scripts store UTC dates as a `date`
  plus a `time(0)` (second precision), use the database collation, have no
  alias table (the customer id is the canonical conversation key and a `t_…`
  thread id is kept in the row's own `external_id`, see E11), and have no
  `legacy_mongo_id` columns (the data migration maps ids in memory).
- E5 stands: the scripts' CHECK allows `admin`, `manager`, `agent`.
- D3 stands: the scripts' `message` table is the document's.
- The stage pipeline (12 steps) lives in `qualifications`; the typologie in
  `motifs_contact` (the document's list of motifs is the typologie list); the
  coarse funnel in `classifications` (the document's values), derived from the
  stage. The frein stays in `contact_custom_fields`. **(The pipeline is
  replaced by Étape + Qualification: D9.)**
- The warehouse procedures keep their behaviour, including the defects listed
  in the 23 Sept analysis; the app supplies the rows they need and accepts the
  rest.

### D6. Features without a table are removed
*Decided by the project owner, 24 Sept 2026.*

The priority flag, the invoice reference, dossier documents, message templates
and the agencies & partners directory have no table in the scripts. They are
removed from the app and their data is not migrated. Files already stored under
`server/uploads/dossiers/` stay on the volume, untouched.

### D7. Production data is migrated
*Decided by the project owner, 24 Sept 2026.*

A one-time script copies MongoDB into SQL Server, dry-run on a copy first. Data
the scripts have no place for (D3, D6) is left behind. Every user logs in again,
because user ids change type.

### D8. Production host: a SQL Server container on the VPS
*Decided by the project owner, 24 Sept 2026.*

SQL Server runs in Docker next to the app on the Hostinger VPS. Both databases
sit on that one instance (the warehouse reads UnifiedBox1 through
cross-database synonyms). Still to confirm: at least 2 GB of RAM to spare.

### D9. The revised scripts of 5 Oct 2026, unaltered, and the lead model they define
*Decided by the project owner, 6 Oct 2026, after the compatibility report on
the revision.*

`schema/` now holds the SSMS revision dated 5 Oct 2026 of both scripts,
verbatim. D5 applies to it unchanged: rows only, never schema. Tables, keys
and indexes are those of 23 Sept. What changed:

- CHECKs on the reference labels. `classifications.label` allows a 7-step
  funnel: Nouveau lead, Contact établi, Offre présentée, Devis envoyé,
  Réservation passée, Paiement en cours, Dossier confirmé.
  `qualifications.label` allows 10 statuses: Nouveau lead, En attente de
  réponse, En cours, En réflexion, Dossier confirmé, Injoignable, Non
  intéressé, Prix trop élevé, Offre concurrente, Réservation annulée; each in
  a group, Nouveau, En cours, Gagné or Perdu.
- `conversations.status` allows open, pending and resolved;
  `call_log.call_status` BUSY, NO ANSWER and ANSWERED.
- The warehouse loaders: a lead is answered by an agent message or an
  answered call; `message_count` keeps the import's count when it is larger;
  "classified" means a label other than "Non classifié"; "won" means the
  qualification's group is Gagné.

The app adopts the revision's lead model instead of the 12-stage pipeline:
two fields, set independently by the agent in the dossier panel and read by
the inbox, the Leads sheet, the exports, the maturity rules and the filters.

- **Étape**, where the customer is in the funnel: `conversations.classification_id`.
- **Qualification**, how the lead stands, with the reason when it is lost:
  `conversations.qualification_id`, each change appended to
  `conversation_qualification_history`.

The "Non ouvert" classification and the "Non renseigné" motif of D4 and D5
are gone: the CHECKs refuse the first, and the scripts' own import uses "Non
spécifié" (E24).

Four defects of the revision cannot be absorbed by the app with rows alone.
They are the schema owner's to fix in the scripts (open item 8).
**(The two fields stay in the database, but the agents work with stages
again: D10.)**

### D10. The stages of production, each stored as a fixed (Étape, Qualification) pair
*Decided by the project owner, 29 Oct 2026, when production main (22 Oct)
was merged into the port.*

The agents keep main's stage pipeline (16 stages then, 19 since D12). The
database keeps D9's two fields: each stage is written as one fixed, distinct
pair (`STAGE_TO_PAIR` in `server/constants/pipeline.js`) and read back from it
(`PAIR_TO_STAGE`). A pair no stage owns — one the scripts' lead import wrote,
or a hand edit — reads as its qualification when that settles it (won, lost,
unreachable), else as the first stage of its Étape (`stageOfPair`). Power BI
reads the two fields; the warehouse's won and lost flags follow the
qualification's group as before. Replaces E25's mapping for the migration.

### D11. Features without a table come back as rows, or read-only
*Decided by the project owner, 29 Oct 2026. Partly reverses D6.*

- The dossier extras of 22 Oct (PAX, comment, RDV place / agency / agent),
  the priority flag and the invoice reference: one JSON value, the "dossier"
  custom field of the customer's contact. The prospect phone recorded by the
  agent: `contacts.phone`.
- Phone leads ("Appel entrant"): a conversation on platform `call` with the
  customer id `appel-<digits>`, and one `dbo.call_log` row per call.
- Message templates and the agencies & partners directory: read from the seed
  files in `server/data/`, read-only (the pages hide their editors; writes
  answer 405).
- Dossier documents stay removed (D6).

*(D10 and D11 were first written on 29 Oct in a working copy that was lost
before it was committed; they are recorded again here on 17 Nov 2026 from the
session notes, unchanged.)*

### D12. Pairs of the three stages added after the port
*Decided by the project owner, 17 Nov 2026 ("set A").*

Main added "En attente du numéro de téléphone" (31 Oct), "Opportunité"
(5 Nov) and "HOPE" (6 Nov). Each takes a pair no stage owned, all three in the
qualification group "En cours":

| Stage | Étape | Qualification |
|---|---|---|
| En attente du numéro de téléphone | Nouveau lead | En cours |
| HOPE | Contact établi | En réflexion |
| Opportunité | Offre présentée | En cours |

The first keeps the Étape "Nouveau lead" although it sits after "Contact
établi" on the line: it was the only free in-progress pair before it. The
other set offered (B) followed the line exactly but put HOPE in the group
Nouveau.

### D13. The dispatch board, as rows
*Decided by the project owner, 17 Nov 2026.*

Main's dispatch board (an admin hands a discussion to an agent with a note,
followed open / done / cancelled, with the agent's first reply) is kept
without a table:

- the agent in charge is the conversation's lock holder and
  `assigned_to_user_id` (`utils/dispatching.js`, the same move as an admin's
  reassignment from the Leads sheet);
- each dispatch is an item of the JSON "dispatch" custom field of the
  customer's contact (`server/db/dispatches.js`): `{"seq": n, "items": [...]}`,
  each item naming its platform and customer id; ids are
  `<contact_id>.<seq>`; writes are serialized per contact with
  `sp_getapplock`; lists read every item with `OPENJSON`; every open item and
  the 50 most recent closed ones are kept per contact.

The API and its JSON are main's, so the client is main's.

### D14. Dashboards count by the time a message was sent
*Decided by the project owner, 17 Nov 2026. Closes open item 4.*

The client counts of the dashboards and the ad-attribution panel filter and
group on `message.sent_date/sent_time`, not `created_*`: opening an old thread
syncs its history today, and must not count as today's clients. The same
change was made on MongoDB (PR #20). No index covers `sent_date` without the
conversation id, and none can be added (D5): these counts scan `message`, as
they did on `created_*`.

### D15. Power BI may read the warehouse
*Decided by the project owner, 17 Nov 2026.*

The scripts create the user `powerbi_reader` in UnifiedBoxDW but grant it
nothing, so every SELECT was refused. `deploy.sh` adds it to `db_datareader`
on UnifiedBoxDW only: a role membership, not a schema change. Who receives
its password stays open item 6.

---

## Engineering decisions and assumptions

These follow from the owner decisions or are needed for the schema to run at
all. The owner may override any of them.

| # | Decision | Why |
|---|---|---|
| E1 | ~~`DATETIME2(3)` UTC for every timestamp~~ Withdrawn by D5 | |
| E2 | ~~Filtered unique indexes for nullable unique columns~~ Withdrawn by D5: the scripts already have them for `contacts.email` and `phone` | |
| E3 | ~~BIN2 collation on platform id columns~~ Withdrawn by D5 | |
| E4 | Portable T-SQL only in application queries: features common to SQL Server 2022 and 2025 | Production runs 2025 in a container (D8) |
| E5 | `users.role` follows the scripts (`admin`, `manager`, `agent`); the code renames `marketing` to `agent` in the same release | A partial rename would lock agents out or loop the router |
| E6 | Lock expiry stays unenforced, as today | Enforcing it would silently unlock threads agents rely on |
| E7 | ~~Alias table for secondary keys~~ Withdrawn by D5; see E11 | |
| E8 | ~~`legacy_mongo_id` columns~~ Withdrawn by D5: the migration keeps the ObjectId map in memory | |
| E9 | SQL Server **Express** in production unless the owner licenses Standard | Express is free for production; it has no SQL Agent, so the app schedules `usp_run_etl` itself |
| E10 | Attachment URLs longer than `message.attachment_url` (500) are re-hosted under `/uploads`; only Meta CDN hosts are fetched, and a media-only message whose file cannot be copied reads "[Pièce jointe indisponible]". Avatars longer than 500 are not stored (they are fetched again from Meta). The migration does not re-host: old Meta URLs have expired | Signed Meta CDN URLs exceed 500 characters and expire anyway |
| E11 | One `conversations` row per customer per platform. `participant_external_id` is the customer id; `external_id` is Meta's thread id once a Graph list or history sync reveals it, the customer id until then; every lookup accepts either key. Creation is serialized per customer with `sp_getapplock` | Replaces E7: the thread id is stored on the row itself, so no alias table and no in-memory map; the schema has no unique key on `participant_external_id` |
| E12 | Deleting a conversation deletes its messages and stage history, resets its dossier and lock, and keeps the row with `deleted_date` set (the warehouse's `deleted_flag`); the customer writing again reopens it. Deleting a user releases their locks and clears every reference to them (reply author, stage-change author, creator) before the row goes | Foreign keys forbid orphans; this mirrors what MongoDB's dangling references did. Answers open item 5 provisionally |
| E13 | A send the platform refuses is not stored (no delivery status, D3). WhatsApp now stores its row after the API accepts it, with the `wamid`, so read receipts set `is_read` | Instagram, Facebook and email already worked this way |
| E14 | The first ad a customer came from (a referral of kind "ad") becomes a `campaigns` row and `conversations.campaign_id`, never overwritten. The prospect sheet's "Source" and the warehouse's campaign dimension read it; the migration derives it from the earliest ad `Message.context` | The schema's own place for ad attribution; the per-message context is still dropped (D3) |
| E15 | Qualification history: a `conversation_qualification_history` row when a conversation is created (Nouveau lead) and at every qualification change. `classified_by_user_id` / `classified_date` record the last dossier edit, as `Classification.classifiedBy` / `updatedAt` did. Revised by D9: `classification_id` is the Étape the agent sets, no longer derived | `usp_load_fact_qualification_duration` needs the start of each qualification |
| E16 | The warehouse's unknown members (-1) and statuses are seeded by `deploy.sh` (as sa) and ensured again at startup; the calendar is extended before each run; the backend runs `usp_run_etl` daily at `WAREHOUSE_ETL_HOUR` | The procedures expect these rows and no script creates them |
| E17 | The backend connects as `unifiedbox_app`: read/write on both databases and EXECUTE on their `dbo` schema, nothing else (`app-login.sql`). The `sa` password lives only in the SQL Server container (`sqlserver.env`) | Least privilege; `usp_run_etl`'s dynamic EXEC needs EXECUTE on each loader |
| E18 | Email threads keep their subject line and HTML rendering: the inbox reads them live from IMAP. The stored copy is plain text only | D3 removes what depended on stored data; this does not |
| E19 | Message sender names are derived: the customer's name for incoming messages, "Page" for Meta replies, the agent's name for WhatsApp CRM replies (`sender_user_id`), `EMAIL_FROM_NAME` for email | D3 drops the per-message name; the bubbles keep a name |
| E20 | `unread_count` grows with each customer message and returns to 0 when an agent's message is the newest; `message_count` and the contact's totals and first/last contact follow every insert | The warehouse reads them; nothing in the app read the MongoDB counters |
| E21 | Timestamps have one-second precision. A thread page is extended to every message of its oldest second, so the next page (strictly before that second) skips nothing | Two messages in the same second would otherwise straddle a page boundary |
| E22 | The scripts fix the 10 qualification labels and the 4 groups, not which label goes in which group. The app's: Nouveau lead → Nouveau; En attente de réponse, En cours, En réflexion → En cours; Dossier confirmé → Gagné, terminal; Injoignable → Perdu, not terminal (the customer may still answer); Non intéressé, Prix trop élevé, Offre concurrente, Réservation annulée → Perdu, terminal. Sort orders follow the funnel (1 to 7) and this list (1 to 10) | The warehouse's `is_won_flag` reads the group; a lost qualification makes a lead Froid in the maturity rules, a Gagné one or an Étape from Réservation passée on makes it Chaud |
| E23 | At every start, and before each warehouse load, the app inserts the reference labels that are missing and puts back the group, terminal flag and sort order of the ones it knows when they differ. Rows only | `usp_load_leads_from_staging` inserts a label it does not know yet with group Nouveau and sort order 99: a won lead imported before the app's first start would otherwise never count as won |
| E24 | The motif of an unknown typologie is "Non spécifié", the label `usp_load_leads_from_staging` creates and uses, instead of D4's "Non renseigné" | One row for both writers |
| E25 | **Replaced by D10: the migration now writes each stage's fixed pair (`STAGE_TO_PAIR`).** Old dossiers mapped onto Étape + Qualification (`PREVIOUS_STAGE_TO_MODEL`, used by the migration): Nouveau lead → Nouveau lead / Nouveau lead; À contacter → Nouveau lead / En cours; Contact établi and Qualifié → Contact établi / En cours; Offre envoyée and Relance → Offre présentée / En attente de réponse; En réflexion → Offre présentée / En réflexion; Réservation → Réservation passée / En cours; Paiement → Paiement en cours / En cours; Dossier confirmé and Départ → Dossier confirmé / Dossier confirmé; Perdu → Nouveau lead / Non intéressé, or Prix trop élevé / Offre concurrente when the customer's last frein is Prix / Comparaison. The six classifications older than the pipeline first take the stage the pipeline's own migration gave them (`LEGACY_TO_STAGE`: Cible and RDV → Qualifié, Hors cible → Perdu, Suivi → Relance, Priorité → À contacter, Non classifié → Nouveau lead) | MongoDB recorded no step reached before a loss, so a lost lead starts the funnel again; the frein is the only recorded loss reason |
| E26 | The warehouse's `dim_status` holds the three statuses `CK_conv_status` allows (open, pending, resolved); the app writes only open | The 23 Sept rows for snoozed and spam can no longer occur |
| E27 | Every (Étape, Qualification) pair a conversation takes — at creation, at each dossier edit and in the migration — is registered in `classification_qualification_matrix` when new. Rows only | The scripts' lead import fills that table with the pairs it imports; a reader of it (Power BI) would otherwise never see the app's pairs |

---

## Still open: owner decisions needed later

These do not block code work, but they block production cutover.

1. **VPS memory.** SQL Server needs at least 2 GB; confirm the VPS has it free
   (`free -h`), and plan backups of the SQL Server volume (README.md, step 7).
2. **Cutover strategy.** The migration script assumes a maintenance window
   (old backend stopped, one transaction, then the new images). A dual-write
   period is not built.
3. **Access to production data** for the dry-run migration, and the rules for
   handling that personal data. The script is tested on synthetic data only.
4. ~~**KPI definition changes.** Analytics counts still use ingestion time
   (`message.created_*`), which inflates numbers for synced history.~~
   Closed by D14.
5. **Deletes.** E12 is the provisional answer; confirm or override it.
6. **Power BI access.** Who gets the `powerbi_reader` password, and how the
   reports reach port 1433 (SSH tunnel or gateway). It can read the warehouse
   since D15.
7. **Project notes.** `CLAUDE.md` §5–§11, §17, §18 and
   `docs/migration/decisions.md` in the main checkout still describe MongoDB;
   they are the owner's files to update.
8. **Defects in the 5 Oct scripts** (D9), for the schema owner to fix:
   - `usp_load_fact_call` writes `lead_key = -1` for a call without a
     conversation, and `fact_lead` has no -1 row, so `FK_fact_call_lead`
     rejects it: no call loads and `usp_run_etl` ends FAILED on that last
     step (the steps before it stay committed). Nothing sets
     `call_log.conversation_id` today, so this hits every call. A placeholder
     lead -1 would be counted as a lead, so the app adds none. Fix: write NULL
     (the column is nullable).
   - `is_classified_flag` is always 1: the CHECK refuses "Non classifié", the
     only label the loader treats as unclassified.
   - `usp_load_leads_from_staging` gives a blank classification "Non
     classifié" and a blank qualification "Nouveau"; both CHECKs refuse them,
     so one blank cell cancels the whole import.
   - The UnifiedBox1 script also creates `usp_load_fact_call`, which reads
     warehouse tables and cannot run there. Harmless to the app.
9. **More defects in the 5 Oct scripts**, found on 17 Nov 2026 (not in item 8):
   - `usp_load_leads_from_staging` also cancels the whole import when two
     staging rows share a phone or an email (`UQ_contacts_phone` /
     `UQ_contacts_email`), when a creation date is not `dd/mm/yyyy`
     (`created_date` is NOT NULL), or when a platform is outside
     `CK_channels_platform` (`telephone`, `messenger`). Contacts without a
     phone are matched on the display name alone, so two namesakes become one.
   - `usp_load_fact_call` takes the agent from the destination extension
     only: an outbound call's agent is the caller (the source), so outbound
     calls fall to the default agent or -1.
   - `usp_load_fact_qualification_duration` numbers the history by date and
     merges on that number, but never updates `entered_at` nor removes rows
     that no longer exist: a history row inserted earlier, or history deleted
     with its conversation (E12), shifts the numbers and leaves stale durations.
   - Minor: the fact loaders build date keys with `FORMAT()` row by row, slow
     on large tables.

---

## Proposed answers to the open items (not decided)

*Proposed by Claude on 19 Nov 2026 at the owner's request. Nothing here is a
decision until the owner confirms it; a confirmed answer becomes a D entry
above and its open item is struck through.*

| Item | Proposal | Why |
|---|---|---|
| 1. VPS memory | Check `free -h`. With 4 GB or more in total, run SQL Server Express beside the app and cap it at about 1.5 GB (`mssql-conf set memory.memorylimitmb 1536`); with less, upgrade the plan before the cutover. Nightly `BACKUP DATABASE` of both databases to the data volume, copied off the server | The app and nginx need room too. Express is limited to about 1.4 GB of buffer pool and **10 GB per database**: enough today, `message` is the table to watch |
| 2. Cutover | A maintenance window at a quiet hour (e.g. Sunday night, Tunis time), no dual-write: stop the backend, `mongodump`, `migrate-from-mongodb.js --commit`, start the new images. Keep the MongoDB container stopped, not deleted, for about two weeks as the rollback | Dual-write costs much more code for little gain. Meta retries undelivered webhooks and the Graph history sync fills gaps, so a window under an hour loses nothing |
| 3. Production data for the dry run | `mongodump` on the VPS, restored into a local container on the owner's machine; dry run there; the copy deleted afterwards. Never sent to a third-party service | It is customers' personal data: it stays under the owner's control |
| 4. KPI definitions | Closed by D14 | |
| 5. Deletes | Confirm E12 as it stands: a deleted conversation loses its messages and history but keeps its row with `deleted_date` (the warehouse's `deleted_flag`); users are suspended by default, hard delete for mistakes only | It is how the app behaves today, and the warehouse keeps counting deleted leads |
| 6. Power BI | The `powerbi_reader` password to the report author only. Port 1433 is never opened to the internet: Power BI Desktop reaches it through an SSH tunnel; if the Power BI Service must refresh on a schedule, the on-premises data gateway on an office PC | The warehouse holds the whole customer base |
| 7. Project notes | Update `CLAUDE.md` and `docs/migration/decisions.md` in the same change as the cutover, not before | Until then they correctly describe production, which runs MongoDB |
| 8. Script defects (5 Oct) | Fix in the scripts before the cutover: `usp_load_fact_call` writes NULL instead of -1 for a call without a lead; `is_classified_flag` tests something real (e.g. `classified_date IS NOT NULL`); the import's blank defaults become labels the CHECKs allow ("Nouveau lead" for both fields); `usp_load_fact_call` is removed from the UnifiedBox1 script | The first one keeps every call out of the warehouse and ends `usp_run_etl` FAILED; the next two make the classified and import figures wrong |
| 9. Script defects (17 Nov) | Before the cutover: `usp_load_fact_call` takes the agent from the source extension when the call is outbound. If the spreadsheet import (`stg.leads_import`) will be used: deduplicate staging rows by phone and email, map `telephone` → `call` and `messenger` → `facebook`, skip rows with an unreadable date instead of failing the run. Later: `usp_load_fact_qualification_duration` also updates `entered_at` and deletes rows whose history is gone (`WHEN NOT MATCHED BY SOURCE`); `FORMAT()` replaced by `CONVERT(int, CONVERT(char(8), d, 112))` | Calls per agent are wrong without the first. The import fixes matter only if the import is used, the app being the usual writer. The last two affect durations after deletes and speed on large tables |

**Proposed order:** free disk space and test the port on SQL Server → fix the
script defects (8, and the outbound-call one of 9) → dry run on a copy of
production data (3) → RAM and backups on the VPS (1) → cutover in a window (2),
with the project notes updated in the same change (7). Items 5 and 6 can be
confirmed at any time.
