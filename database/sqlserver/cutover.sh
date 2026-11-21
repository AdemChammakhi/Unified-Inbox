#!/bin/bash
# cutover.sh — moves production from MongoDB to SQL Server, on the VPS.
#
# Run on the HOST, as root, from the app folder, with this repo's database/
# folder copied next to the compose file (/opt/unified-inbox/database/…):
#
#   bash database/sqlserver/cutover.sh prepare     now: everything that can be done and
#                                                  tested WITHOUT touching production
#   bash database/sqlserver/cutover.sh schedule    plan the switch for the next midnight
#                                                  (Africa/Tunis), or: schedule '2026-11-20 00:00'
#   bash database/sqlserver/cutover.sh cutover     the switch itself (what the timer runs)
#   bash database/sqlserver/cutover.sh rollback    back to MongoDB and the previous images
#   bash database/sqlserver/cutover.sh status      where things stand
#   bash database/sqlserver/cutover.sh unschedule  cancel the planned switch
#
# prepare   starts SQL Server (a standalone container named "sqlserver" on the
#           app's network: the compose file is NOT edited, and the pipeline's
#           `up -d --remove-orphans` leaves it alone), creates both databases,
#           pulls the new images, then REHEARSES on the real data: full
#           migration, a temporary new backend, the smoke test, a warehouse
#           load and a backup with a restore test. Production keeps running on
#           MongoDB the whole time, untouched (MongoDB is only read).
# cutover   dumps MongoDB to a file, stops the backend, recreates the
#           databases empty, migrates ALL the data, adds the SQLSERVER_*
#           settings to the backend's env file, starts the new backend and
#           frontend, runs the smoke test and a warehouse load, takes a first
#           backup and schedules the nightly one. ANY failure puts the previous
#           backend back on MongoDB automatically.
#
# After a successful cutover MongoDB keeps running, untouched: it is the way
# back. `rollback` returns to it, but messages received after the switch
# exist only in SQL Server. Every user signs in again (ids change type).
#
# The new images must be the SQL Server build. By default they are the tags the
# compose file already uses (…:latest), pulled during prepare; override with
# NEW_BACKEND_IMAGE / NEW_FRONTEND_IMAGE (e.g. a commit tag), or SKIP_PULL=1.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_DIR="$(dirname "${SCRIPT_DIR}")"
APP_DIR="${APP_DIR:-$(dirname "${DB_DIR}")}"
# Files copied from Windows arrive readable by root only; the backend image does not run as root.
chmod -R a+rX "${DB_DIR}" 2> /dev/null || true
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKEND_SERVICE="${BACKEND_SERVICE:-backend}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-frontend}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:5000/}"
SQLSERVER_CONTAINER="${SQLSERVER_CONTAINER:-sqlserver}"
SQLSERVER_IMAGE="${SQLSERVER_IMAGE:-mcr.microsoft.com/mssql/server:2025-latest}"
SQLSERVER_MEMORY="${SQLSERVER_MEMORY:-2g}"
SQLSERVER_BIND="${SQLSERVER_BIND:-127.0.0.1:1433}"
SQLSERVER_VOLUME="${SQLSERVER_VOLUME:-unifiedbox-sqlserver-data}"
STATE_DIR="${STATE_DIR:-${APP_DIR}/cutover}"
STATE_FILE="${STATE_DIR}/state.env"
SA_ENV="${APP_DIR}/sqlserver.env"
APP_PW_FILE="${STATE_DIR}/app-login.pw"
REHEARSAL_CONTAINER="unifiedbox-rehearsal"
TIMER_UNIT="unifiedbox-cutover"
MARK_BEGIN="# >>> SQL Server (added by cutover.sh) >>>"
MARK_END="# <<< SQL Server (added by cutover.sh) <<<"

cd "${APP_DIR}"
mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"

cmd="${1:-status}"
if [ "${cmd}" != "status" ]; then
  LOG="${STATE_DIR}/${cmd}-$(date -u +%Y%m%d-%H%M%S).log"
  exec > >(tee -a "${LOG}") 2>&1
fi

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { log "ERROR: $*"; exit 1; }
compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }
random_pw() { printf 'Aa1%s' "$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 29)"; }
tsql() {
  docker exec -e "SQL=$1" "${SQLSERVER_CONTAINER}" bash -c \
    '/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -b -h -1 -W -Q "SET NOCOUNT ON; $SQL"'
}

# ── State (plain KEY=value, no secrets) ──────────────────────────────────────
state_get() { [ -f "${STATE_FILE}" ] && sed -n "s/^$1=//p" "${STATE_FILE}" | tail -n 1 || true; }
state_set() {
  touch "${STATE_FILE}"
  grep -v "^$1=" "${STATE_FILE}" > "${STATE_FILE}.tmp" || true
  echo "$1=$2" >> "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "${STATE_FILE}"
}

# ── Discovery ────────────────────────────────────────────────────────────────
backend_container() { compose ps -a -q "${BACKEND_SERVICE}" | head -n 1; }
frontend_container() { compose ps -a -q "${FRONTEND_SERVICE}" | head -n 1; }

discover() {
  BACKEND_CID="$(backend_container)"
  [ -n "${BACKEND_CID}" ] || die "no ${BACKEND_SERVICE} container (compose file ${APP_DIR}/${COMPOSE_FILE})"
  NETWORK="$(docker inspect "${BACKEND_CID}" --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | head -n 1)"
  [ -n "${NETWORK}" ] || die "could not find the backend's network"
  PROD_BACKEND_IMAGE="$(docker inspect "${BACKEND_CID}" --format '{{.Config.Image}}')"
  FRONTEND_CID="$(frontend_container)"
  [ -n "${FRONTEND_CID}" ] || die "no ${FRONTEND_SERVICE} container"
  PROD_FRONTEND_IMAGE="$(docker inspect "${FRONTEND_CID}" --format '{{.Config.Image}}')"
  NEW_BACKEND_IMAGE="${NEW_BACKEND_IMAGE:-$(state_get NEW_BACKEND_IMAGE)}"
  NEW_BACKEND_IMAGE="${NEW_BACKEND_IMAGE:-${PROD_BACKEND_IMAGE}}"
  NEW_FRONTEND_IMAGE="${NEW_FRONTEND_IMAGE:-$(state_get NEW_FRONTEND_IMAGE)}"
  NEW_FRONTEND_IMAGE="${NEW_FRONTEND_IMAGE:-${PROD_FRONTEND_IMAGE}}"
  # The env file compose gives the backend: the one that holds JWT_SECRET
  if [ -z "${ENV_FILE:-}" ]; then
    for f in .env .env.production; do
      if [ -f "$f" ] && grep -q '^JWT_SECRET=' "$f"; then ENV_FILE="$f"; break; fi
    done
  fi
  [ -n "${ENV_FILE:-}" ] && [ -f "${ENV_FILE}" ] || die "could not find the backend's env file (.env or .env.production with JWT_SECRET); set ENV_FILE"
}

# The running backend's environment, as a docker --env-file (mode 600), with
# the MongoDB address the migration reads. Deleted on exit.
RUNTIME_ENV=""
STOPPED=0
on_exit() {
  local code=$?
  trap - EXIT
  set +e
  if [ "${code}" != "0" ]; then
    log "FAILED (exit ${code})."
    if [ "${cmd}" = "cutover" ] && [ "${STOPPED}" = "1" ]; then do_rollback; fi
    docker rm -f "${REHEARSAL_CONTAINER}" > /dev/null 2>&1
  fi
  [ -n "${RUNTIME_ENV}" ] && rm -f "${RUNTIME_ENV}"
  exit "${code}"
}
trap on_exit EXIT
capture_backend_env() {
  local source_cid="$1"
  RUNTIME_ENV="$(mktemp "${STATE_DIR}/.runtime-env.XXXXXX")"
  chmod 600 "${RUNTIME_ENV}"
  docker inspect "${source_cid}" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -Ev '^(PATH|HOME|HOSTNAME|NODE_VERSION|YARN_VERSION|PORT|NODE_ENV|SQLSERVER_[A-Z_]*|MIGRATION_MONGO_URI)=' \
    | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > "${RUNTIME_ENV}" || true
  local uri
  uri="$(sed -n 's/^MONGODB_URI=//p' "${RUNTIME_ENV}" | head -n 1)"
  [ -n "${uri}" ] || uri="$(sed -n 's/^MONGO_URI=//p' "${RUNTIME_ENV}" | head -n 1)"
  [ -n "${uri}" ] || die "the running backend has neither MONGODB_URI nor MONGO_URI: is it still the MongoDB build?"
  echo "MIGRATION_MONGO_URI=${uri}" >> "${RUNTIME_ENV}"
}
sql_env() {
  local pw
  pw="$(cat "${APP_PW_FILE}")"
  printf '%s\n' -e SQLSERVER_HOST="${SQLSERVER_CONTAINER}" -e SQLSERVER_PORT=1433 -e SQLSERVER_USER=unifiedbox_app \
    -e "SQLSERVER_PASSWORD=${pw}" -e SQLSERVER_DATABASE=UnifiedBox1 -e SQLSERVER_DW_DATABASE=UnifiedBoxDW \
    -e SQLSERVER_TRUST_SERVER_CERTIFICATE=true
}

# ── SQL Server ───────────────────────────────────────────────────────────────
ensure_sqlserver() {
  if [ ! -f "${SA_ENV}" ]; then
    (umask 077; echo "MSSQL_SA_PASSWORD=$(random_pw)" > "${SA_ENV}")
    log "Created ${SA_ENV} (the sa password; mode 600)."
  fi
  [ -f "${APP_PW_FILE}" ] || (umask 077; random_pw > "${APP_PW_FILE}")
  if ! docker inspect "${SQLSERVER_CONTAINER}" > /dev/null 2>&1; then
    log "Starting SQL Server (${SQLSERVER_IMAGE}) on network ${NETWORK}…"
    docker run -d --name "${SQLSERVER_CONTAINER}" --network "${NETWORK}" --network-alias "${SQLSERVER_CONTAINER}" \
      --env-file "${SA_ENV}" -e ACCEPT_EULA=Y -e MSSQL_PID=Express -e TZ=UTC \
      -p "${SQLSERVER_BIND}:1433" -v "${SQLSERVER_VOLUME}:/var/opt/mssql" \
      --memory "${SQLSERVER_MEMORY}" --restart unless-stopped \
      --log-opt max-size=10m --log-opt max-file=3 "${SQLSERVER_IMAGE}" > /dev/null
  elif [ "$(docker inspect "${SQLSERVER_CONTAINER}" --format '{{.State.Running}}')" != "true" ]; then
    docker start "${SQLSERVER_CONTAINER}" > /dev/null
  fi
  local i
  for i in $(seq 1 60); do
    if tsql "SELECT 1" > /dev/null 2>&1; then log "SQL Server is up."; return 0; fi
    sleep 3
  done
  die "SQL Server did not answer within 3 minutes (docker logs ${SQLSERVER_CONTAINER})"
}

deploy_databases() { # $1 = fresh → drop both databases first
  if [ "${1:-}" = "fresh" ]; then
    log "Dropping UnifiedBox1 / UnifiedBoxDW (rehearsal data) to start empty…"
    tsql "IF DB_ID(N'UnifiedBoxDW') IS NOT NULL BEGIN ALTER DATABASE UnifiedBoxDW SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE UnifiedBoxDW; END;
          IF DB_ID(N'UnifiedBox1') IS NOT NULL BEGIN ALTER DATABASE UnifiedBox1 SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE UnifiedBox1; END;" > /dev/null
  fi
  docker exec -u 0 "${SQLSERVER_CONTAINER}" rm -rf /tmp/unifiedbox-schema
  docker cp "${SCRIPT_DIR}/." "${SQLSERVER_CONTAINER}:/tmp/unifiedbox-schema"
  docker exec -u 0 "${SQLSERVER_CONTAINER}" chmod -R a+rX /tmp/unifiedbox-schema
  docker exec -e "UNIFIEDBOX_APP_PASSWORD=$(cat "${APP_PW_FILE}")" "${SQLSERVER_CONTAINER}" \
    bash /tmp/unifiedbox-schema/deploy.sh | grep -v '^Changed database context' | sed 's/^/    /'
}

# ── Images ───────────────────────────────────────────────────────────────────
is_sql_build() { docker run --rm --entrypoint sh "$1" -c 'test -f server/db/sql.js' > /dev/null 2>&1; }

prepare_images() {
  # Keep the running images under a tag: the way back, safe from `image prune`
  local old_be old_fe
  docker inspect "${BACKEND_CID}" --format '{{.State.Running}}' | grep -q true || die "the backend is not running: prepare needs the live MongoDB build"
  old_be="$(docker inspect "${BACKEND_CID}" --format '{{.Image}}')"
  old_fe="$(docker inspect "${FRONTEND_CID}" --format '{{.Image}}')"
  if [ -z "$(state_get OLD_BACKEND_ID)" ]; then
    is_sql_build "${old_be}" && die "the running backend is already the SQL Server build: nothing to cut over"
    docker tag "${old_be}" "${PROD_BACKEND_IMAGE%:*}:pre-sqlserver"
    docker tag "${old_fe}" "${PROD_FRONTEND_IMAGE%:*}:pre-sqlserver"
    state_set OLD_BACKEND_ID "${old_be}"
    state_set OLD_FRONTEND_ID "${old_fe}"
    state_set PROD_BACKEND_IMAGE "${PROD_BACKEND_IMAGE}"
    state_set PROD_FRONTEND_IMAGE "${PROD_FRONTEND_IMAGE}"
    log "Current images kept as …:pre-sqlserver."
  fi
  if [ "${SKIP_PULL:-0}" != "1" ]; then
    log "Pulling ${NEW_BACKEND_IMAGE} and ${NEW_FRONTEND_IMAGE}… (the running containers keep their images)"
    docker pull -q "${NEW_BACKEND_IMAGE}" > /dev/null
    docker pull -q "${NEW_FRONTEND_IMAGE}" > /dev/null
  fi
  is_sql_build "${NEW_BACKEND_IMAGE}" || die "${NEW_BACKEND_IMAGE} is not the SQL Server build (no server/db/sql.js in it). Build and push it first: open the pull request of the port branch and wait for the pipeline's \"Build Images\" stage, then run prepare again."
  # Pin exactly what was rehearsed
  state_set NEW_BACKEND_IMAGE "${NEW_BACKEND_IMAGE}"
  state_set NEW_FRONTEND_IMAGE "${NEW_FRONTEND_IMAGE}"
  state_set NEW_BACKEND_ID "$(docker inspect "${NEW_BACKEND_IMAGE}" --format '{{.Id}}')"
  state_set NEW_FRONTEND_ID "$(docker inspect "${NEW_FRONTEND_IMAGE}" --format '{{.Id}}')"
  # Until the cutover, the tags the compose file uses point at the RUNNING
  # images again: a stray `docker compose up -d` then changes nothing.
  docker tag "$(state_get OLD_BACKEND_ID)" "$(state_get PROD_BACKEND_IMAGE)"
  docker tag "$(state_get OLD_FRONTEND_ID)" "$(state_get PROD_FRONTEND_IMAGE)"
  log "New backend image verified: SQL Server build ($(state_get NEW_BACKEND_ID | cut -c8-19))."
}

# ── Migration, smoke test ────────────────────────────────────────────────────
run_migration() { # $1 = "" (dry run) or --commit
  local image
  image="$(state_get NEW_BACKEND_ID)"
  # shellcheck disable=SC2046
  docker run --rm --network "${NETWORK}" --env-file "${RUNTIME_ENV}" $(sql_env) \
    -v "${DB_DIR}:/app/database:ro" -w /app "${image}" \
    node database/sqlserver/migrate-from-mongodb.js $1
}

smoke_test() { # $1 = container, $2… = flags
  local c="$1"; shift
  docker cp "${SCRIPT_DIR}/smoke-test.js" "${c}:/tmp/smoke-test.js"
  docker exec -w /app "${c}" node /tmp/smoke-test.js "$@"
}

mongo_dump() {
  local out="${STATE_DIR}/mongodb-before-cutover-$(date -u +%Y%m%d-%H%M%S).archive.gz"
  local image
  image="$(docker ps --format '{{.Image}}' | grep -E '^mongo(:|$)' | head -n 1 || true)"
  image="${image:-mongo:7}"
  log "Dumping MongoDB to ${out}…"
  (umask 077; docker run --rm --network "${NETWORK}" --env-file "${RUNTIME_ENV}" "${image}" \
    sh -c 'mongodump --quiet --uri "$MIGRATION_MONGO_URI" --archive --gzip' > "${out}")
  [ -s "${out}" ] || die "the MongoDB dump is empty"
  state_set MONGO_DUMP "${out}"
  log "MongoDB dump: $(du -h "${out}" | cut -f1)."
}

wait_healthy() { # the live backend, through the host port
  local i
  for i in $(seq 1 40); do
    if curl -sf --connect-timeout 3 --max-time 5 -o /dev/null "${BACKEND_URL}"; then return 0; fi
    sleep 3
  done
  return 1
}

# ── Env file ─────────────────────────────────────────────────────────────────
strip_sql_block() { # prints $1 without our block
  awk -v b="${MARK_BEGIN}" -v e="${MARK_END}" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$1"
}
write_sql_env() {
  local backup="${STATE_DIR}/env-before-cutover"
  [ -f "${backup}" ] || (umask 077; cp -p "${ENV_FILE}" "${backup}")
  local tmp
  tmp="$(mktemp "${STATE_DIR}/.env-new.XXXXXX")"
  chmod 600 "${tmp}"
  strip_sql_block "${ENV_FILE}" > "${tmp}"
  {
    echo "${MARK_BEGIN}"
    echo "SQLSERVER_HOST=${SQLSERVER_CONTAINER}"
    echo "SQLSERVER_PORT=1433"
    echo "SQLSERVER_USER=unifiedbox_app"
    echo "SQLSERVER_PASSWORD=$(cat "${APP_PW_FILE}")"
    echo "SQLSERVER_DATABASE=UnifiedBox1"
    echo "SQLSERVER_DW_DATABASE=UnifiedBoxDW"
    echo "SQLSERVER_TRUST_SERVER_CERTIFICATE=true"
    echo "${MARK_END}"
  } >> "${tmp}"
  cat "${tmp}" > "${ENV_FILE}" # keeps the file's owner and mode
  rm -f "${tmp}"
}
remove_sql_env() {
  local tmp
  tmp="$(mktemp "${STATE_DIR}/.env-new.XXXXXX")"
  chmod 600 "${tmp}"
  strip_sql_block "${ENV_FILE}" > "${tmp}"
  cat "${tmp}" > "${ENV_FILE}"
  rm -f "${tmp}"
}

# ── Rollback ─────────────────────────────────────────────────────────────────
do_rollback() {
  log "ROLLBACK: back to MongoDB and the previous images…"
  set +e
  local be fe old_be old_fe
  be="$(state_get PROD_BACKEND_IMAGE)"; fe="$(state_get PROD_FRONTEND_IMAGE)"
  old_be="$(state_get OLD_BACKEND_ID)"; old_fe="$(state_get OLD_FRONTEND_ID)"
  remove_sql_env
  [ -n "${old_be}" ] && docker tag "${old_be}" "${be}"
  [ -n "${old_fe}" ] && docker tag "${old_fe}" "${fe}"
  compose up -d --no-deps "${BACKEND_SERVICE}"
  if wait_healthy; then
    compose up -d --no-deps "${FRONTEND_SERVICE}"
    state_set CUTOVER_DONE ""
    state_set ROLLED_BACK "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    log "ROLLBACK DONE: the previous backend answers again, on MongoDB."
  else
    log "ROLLBACK FAILED: the previous backend does not answer. Check: docker compose -f ${COMPOSE_FILE} logs --tail 100 ${BACKEND_SERVICE}"
  fi
  set -e
}

# ── Commands ─────────────────────────────────────────────────────────────────
do_prepare() {
  log "=== PREPARE: production is not touched ==="
  discover
  [ -z "$(state_get CUTOVER_DONE)" ] || die "the cutover is already done ($(state_get CUTOVER_DONE))"
  # A new rehearsal starts: the previous one no longer vouches for anything
  state_set REHEARSAL_OK ""
  systemctl stop "${TIMER_UNIT}.timer" > /dev/null 2>&1 && log "A planned cutover was cancelled: schedule it again after this rehearsal." || true
  if command -v free > /dev/null 2>&1; then
    local avail
    avail="$(free -m | awk '/^Mem:/ {print $7}')"
    log "Memory available: ${avail} MB (SQL Server is capped at ${SQLSERVER_MEMORY})."
    if ! docker inspect "${SQLSERVER_CONTAINER}" > /dev/null 2>&1 && [ "${avail}" -lt 2300 ] && [ "${FORCE:-0}" != "1" ]; then
      die "less than 2300 MB available: SQL Server would starve the app. Free memory, or rerun with FORCE=1."
    fi
  fi
  log "Disk free in ${APP_DIR}: $(df -h "${APP_DIR}" | awk 'NR==2 {print $4}')."
  grep -q '^PUBLIC_URL=' "${ENV_FILE}" || log "NOTE: PUBLIC_URL is not set in ${ENV_FILE}: media re-hosted for customers will have no public address."
  capture_backend_env "${BACKEND_CID}"
  ensure_sqlserver
  prepare_images
  deploy_databases fresh

  log "--- Rehearsal 1/4: migration of the real data (MongoDB is only read) ---"
  run_migration --commit
  log "--- Rehearsal 2/4: a temporary new backend on the migrated data ---"
  docker rm -f "${REHEARSAL_CONTAINER}" > /dev/null 2>&1 || true
  # shellcheck disable=SC2046
  docker run -d --name "${REHEARSAL_CONTAINER}" --network "${NETWORK}" $(sql_env) \
    -e JWT_SECRET="rehearsal-$(random_pw)" -e NODE_ENV=production -e PORT=5000 -e WAREHOUSE_ETL_DISABLED=true \
    "$(state_get NEW_BACKEND_ID)" > /dev/null
  local i ok=0
  for i in $(seq 1 40); do
    if docker exec "${REHEARSAL_CONTAINER}" wget -qO- http://127.0.0.1:5000/ > /dev/null 2>&1; then ok=1; break; fi
    sleep 3
  done
  if [ "${ok}" != "1" ]; then docker logs --tail 40 "${REHEARSAL_CONTAINER}" || true; docker rm -f "${REHEARSAL_CONTAINER}" > /dev/null; die "the new backend did not start on the migrated data"; fi
  log "--- Rehearsal 3/4: smoke test and warehouse load ---"
  local result
  if ! result="$(smoke_test "${REHEARSAL_CONTAINER}" --etl)"; then
    echo "    ${result}"; docker rm -f "${REHEARSAL_CONTAINER}" > /dev/null; die "the smoke test failed on the migrated data"
  fi
  echo "    ${result}"
  docker rm -f "${REHEARSAL_CONTAINER}" > /dev/null
  log "--- Rehearsal 4/4: backup with a restore test ---"
  SQLSERVER_CONTAINER="${SQLSERVER_CONTAINER}" BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups/sqlserver}" \
    bash "${SCRIPT_DIR}/backup.sh" --verify-restore | sed 's/^/    /'
  state_set REHEARSAL_OK "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "=== PREPARE DONE: the rehearsal passed. Production still runs on MongoDB. ==="
  log "Next: bash ${SCRIPT_DIR}/cutover.sh schedule"
}

do_cutover() {
  log "=== CUTOVER ==="
  discover
  [ -z "$(state_get CUTOVER_DONE)" ] || die "the cutover is already done ($(state_get CUTOVER_DONE)); the live data is in SQL Server and will not be dropped"
  [ -n "$(state_get REHEARSAL_OK)" ] || [ "${FORCE:-0}" = "1" ] || die "no successful rehearsal: run prepare first"
  local new_be new_fe
  new_be="$(state_get NEW_BACKEND_ID)"; new_fe="$(state_get NEW_FRONTEND_ID)"
  docker inspect "${new_be}" > /dev/null 2>&1 || die "the rehearsed backend image is gone: run prepare again"
  docker inspect "${new_fe}" > /dev/null 2>&1 || die "the rehearsed frontend image is gone: run prepare again"
  is_sql_build "$(docker inspect "${BACKEND_CID}" --format '{{.Image}}')" && die "the running backend is already the SQL Server build"
  capture_backend_env "${BACKEND_CID}"
  ensure_sqlserver
  mongo_dump

  log "Stopping the backend (maintenance window starts)…"
  STOPPED=1
  compose stop "${BACKEND_SERVICE}"
  deploy_databases fresh
  log "Migrating ALL the data…"
  run_migration --commit

  log "Switching to the new images…"
  write_sql_env
  docker tag "${new_be}" "$(state_get PROD_BACKEND_IMAGE)"
  docker tag "${new_fe}" "$(state_get PROD_FRONTEND_IMAGE)"
  compose up -d --no-deps "${BACKEND_SERVICE}"
  wait_healthy || die "the new backend does not answer on ${BACKEND_URL}"
  local cid result
  cid="$(backend_container)"
  docker logs "${cid}" 2>&1 | grep -q "SQL Server connected" || die "the new backend did not report \"SQL Server connected\""
  result="$(smoke_test "${cid}" --etl)" || { echo "    ${result}"; die "the smoke test failed on the live backend"; }
  echo "    ${result}"
  compose up -d --no-deps "${FRONTEND_SERVICE}"
  STOPPED=0
  state_set CUTOVER_DONE "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "=== CUTOVER DONE: production runs on SQL Server. ==="

  # From here on a failure must NOT roll back: the switch is made
  set +e
  SQLSERVER_CONTAINER="${SQLSERVER_CONTAINER}" BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups/sqlserver}" \
    bash "${SCRIPT_DIR}/backup.sh" | sed 's/^/    /'
  SQLSERVER_CONTAINER="${SQLSERVER_CONTAINER}" BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups/sqlserver}" \
    bash "${SCRIPT_DIR}/backup.sh" --install-cron | sed 's/^/    /'
  log "MongoDB is left running, untouched (the way back: cutover.sh rollback). Its dump: $(state_get MONGO_DUMP)"
  log "Every user must sign in again."
  set -e
}

case "${cmd}" in
  prepare) do_prepare ;;
  cutover) do_cutover ;;
  rollback)
    discover
    [ -n "$(state_get OLD_BACKEND_ID)" ] || die "nothing to roll back to (prepare never ran)"
    do_rollback
    ;;
  schedule)
    [ -n "$(state_get REHEARSAL_OK)" ] || die "no successful rehearsal: run prepare first"
    [ -z "$(state_get CUTOVER_DONE)" ] || die "the cutover is already done"
    command -v systemd-run > /dev/null 2>&1 || die "systemd-run not found; run \"cutover\" by hand at the chosen time"
    when="${2:-$(TZ=Africa/Tunis date -d 'tomorrow 00:00' '+%Y-%m-%d %H:%M:%S')}"
    systemctl stop "${TIMER_UNIT}.timer" > /dev/null 2>&1 || true
    systemctl reset-failed "${TIMER_UNIT}.service" > /dev/null 2>&1 || true
    systemd-run --unit="${TIMER_UNIT}" --description="Unified Inbox: MongoDB to SQL Server cutover" \
      --on-calendar="${when} Africa/Tunis" --timer-property=AccuracySec=1s \
      --setenv=APP_DIR="${APP_DIR}" --setenv=COMPOSE_FILE="${COMPOSE_FILE}" --setenv=BACKEND_URL="${BACKEND_URL}" \
      --setenv=HOME="${HOME:-/root}" --setenv=PATH="${PATH}" \
      /bin/bash "${SCRIPT_DIR}/cutover.sh" cutover
    state_set SCHEDULED_FOR "${when} Africa/Tunis"
    log "Cutover scheduled for ${when} (Africa/Tunis)."
    systemctl list-timers "${TIMER_UNIT}.timer" --no-pager || true
    log "Its log will be in ${STATE_DIR}/cutover-*.log — cancel with: bash ${SCRIPT_DIR}/cutover.sh unschedule"
    ;;
  unschedule)
    systemctl stop "${TIMER_UNIT}.timer" && log "Planned cutover cancelled." || log "No planned cutover."
    state_set SCHEDULED_FOR ""
    ;;
  status)
    echo "App folder:     ${APP_DIR}"
    echo "Rehearsal OK:   $(state_get REHEARSAL_OK)"
    echo "Scheduled for:  $(state_get SCHEDULED_FOR)"
    echo "Cutover done:   $(state_get CUTOVER_DONE)"
    echo "Rolled back:    $(state_get ROLLED_BACK)"
    echo "New backend:    $(state_get NEW_BACKEND_IMAGE) $(state_get NEW_BACKEND_ID | cut -c8-19)"
    echo "MongoDB dump:   $(state_get MONGO_DUMP)"
    systemctl list-timers "${TIMER_UNIT}.timer" --no-pager 2> /dev/null | sed -n '1,3p' || true
    ls -1t "${STATE_DIR}"/*.log 2> /dev/null | head -n 3 | sed 's/^/Log: /' || true
    ;;
  *) die "unknown command \"${cmd}\" (prepare | schedule | cutover | rollback | status | unschedule)" ;;
esac
