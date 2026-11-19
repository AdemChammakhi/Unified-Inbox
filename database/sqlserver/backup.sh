#!/bin/bash
# Backs up UnifiedBox1 and UnifiedBoxDW out of the SQL Server container.
# Runs on the HOST (the VPS), as root or a user allowed to use docker.
#
#   backup.sh                   back up both databases now
#   backup.sh --verify-restore  the same, then restore UnifiedBox1's backup into
#                               a scratch database, count its rows and drop it
#   backup.sh --install-cron    schedule a nightly run (03:30, server time)
#
# Each run: BACKUP DATABASE … WITH CHECKSUM, RESTORE VERIFYONLY, then the file
# is copied out of the container, gzipped into BACKUP_DIR and removed from the
# container. Files older than KEEP_DAYS are deleted. Express has no SQL Agent
# and no backup compression, hence this script and gzip.
#
# The files stay ON THIS SERVER unless BACKUP_COPY_CMD is set: a command run
# once per finished file with its path as last argument, e.g.
#   BACKUP_COPY_CMD='rclone copy --quiet {} remote:unifiedbox'   ({} = the file)
#   BACKUP_COPY_CMD='scp -q {} backup@other-host:/backups/'
# A server that dies takes its local backups with it: set one.
#
# Not covered: the uploads volume (media agents sent) and the .env files.
set -euo pipefail

SQLSERVER_CONTAINER="${SQLSERVER_CONTAINER:-sqlserver}"
BACKUP_DIR="${BACKUP_DIR:-/opt/unified-inbox/backups/sqlserver}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DATABASES="${DATABASES:-UnifiedBox1 UnifiedBoxDW}"
IN_CONTAINER_DIR="/var/opt/mssql/backup"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
# Runs one T-SQL batch as sa; the password never leaves the container.
tsql() {
  docker exec -e "SQL=$1" "${SQLSERVER_CONTAINER}" bash -c \
    '/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -b -h -1 -W -Q "SET NOCOUNT ON; $SQL"'
}

if [ "${1:-}" = "--install-cron" ]; then
  cron="/etc/cron.d/unifiedbox-backup"
  {
    echo "# Nightly SQL Server backup (database/sqlserver/backup.sh). After the 02:00 warehouse load."
    echo "SHELL=/bin/bash"
    echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "30 3 * * * root SQLSERVER_CONTAINER='${SQLSERVER_CONTAINER}' BACKUP_DIR='${BACKUP_DIR}' KEEP_DAYS='${KEEP_DAYS}' BACKUP_COPY_CMD='${BACKUP_COPY_CMD:-}' /bin/bash '${self}' >> /var/log/unifiedbox-backup.log 2>&1"
  } > "${cron}"
  chmod 644 "${cron}"
  log "Nightly backup scheduled: ${cron} (03:30 server time, log /var/log/unifiedbox-backup.log)"
  exit 0
fi

docker inspect "${SQLSERVER_CONTAINER}" > /dev/null 2>&1 || { log "ERROR: container ${SQLSERVER_CONTAINER} not found"; exit 1; }
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}" 2> /dev/null || true
docker exec "${SQLSERVER_CONTAINER}" mkdir -p "${IN_CONTAINER_DIR}"

stamp="$(date -u +%Y%m%d-%H%M%S)"
made=()
for db in ${DATABASES}; do
  file="${db}-${stamp}.bak"
  log "Backing up ${db}…"
  tsql "BACKUP DATABASE [${db}] TO DISK = N'${IN_CONTAINER_DIR}/${file}' WITH INIT, CHECKSUM, NAME = N'${db} ${stamp}';" > /dev/null
  tsql "RESTORE VERIFYONLY FROM DISK = N'${IN_CONTAINER_DIR}/${file}' WITH CHECKSUM;" > /dev/null
  docker cp "${SQLSERVER_CONTAINER}:${IN_CONTAINER_DIR}/${file}" "${BACKUP_DIR}/${file}"
  if [ "${1:-}" = "--verify-restore" ] && [ "${db}" = "UnifiedBox1" ]; then
    log "Restore test: ${db} → ${db}_restoretest"
    tsql "
      IF DB_ID(N'${db}_restoretest') IS NOT NULL BEGIN ALTER DATABASE [${db}_restoretest] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}_restoretest]; END;
      DECLARE @dir nvarchar(260) = CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath')), @sql nvarchar(max);
      SELECT @sql = N'RESTORE DATABASE [${db}_restoretest] FROM DISK = N''${IN_CONTAINER_DIR}/${file}'' WITH CHECKSUM, '
        + STRING_AGG(N'MOVE N''' + name + N''' TO N''' + @dir + N'${db}_restoretest_' + CAST(file_id AS nvarchar(10)) + CASE type WHEN 1 THEN N'.ldf' ELSE N'.mdf' END + N'''', N', ')
      FROM sys.master_files WHERE database_id = DB_ID(N'${db}');
      EXEC (@sql);" > /dev/null
    counts="$(tsql "SELECT CONCAT('users=', (SELECT COUNT(*) FROM [${db}_restoretest].dbo.users), ' conversations=', (SELECT COUNT(*) FROM [${db}_restoretest].dbo.conversations), ' messages=', (SELECT COUNT(*) FROM [${db}_restoretest].dbo.message));" | head -n 1 | tr -d '\r')"
    live="$(tsql "SELECT CONCAT('users=', (SELECT COUNT(*) FROM [${db}].dbo.users), ' conversations=', (SELECT COUNT(*) FROM [${db}].dbo.conversations), ' messages=', (SELECT COUNT(*) FROM [${db}].dbo.message));" | head -n 1 | tr -d '\r')"
    tsql "ALTER DATABASE [${db}_restoretest] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}_restoretest];" > /dev/null
    log "Restored copy holds: ${counts} (live: ${live})"
    [ -n "${counts}" ] || { log "ERROR: the restore test returned nothing"; exit 1; }
  fi
  docker exec "${SQLSERVER_CONTAINER}" rm -f "${IN_CONTAINER_DIR}/${file}"
  gzip -f "${BACKUP_DIR}/${file}"
  chmod 600 "${BACKUP_DIR}/${file}.gz" 2> /dev/null || true
  made+=("${BACKUP_DIR}/${file}.gz")
  log "OK ${file}.gz ($(du -h "${BACKUP_DIR}/${file}.gz" | cut -f1))"
done

if [ -n "${BACKUP_COPY_CMD:-}" ]; then
  for f in "${made[@]}"; do
    if bash -c "${BACKUP_COPY_CMD//\{\}/\"$f\"}"; then log "Copied off-server: $(basename "$f")"; else log "ERROR: off-server copy failed for $(basename "$f")"; exit 1; fi
  done
else
  log "NOTE: backups are on this server only (BACKUP_COPY_CMD is not set)."
fi

find "${BACKUP_DIR}" -name '*.bak.gz' -type f -mtime "+${KEEP_DAYS}" -delete
log "Done. ${BACKUP_DIR} holds $(find "${BACKUP_DIR}" -name '*.bak.gz' -type f | wc -l) backup file(s)."
