#!/bin/bash
# Creates UnifiedBox1 and UnifiedBoxDW from the two SSMS scripts in schema/,
# unaltered except for one thing: the scripts put the data and log files in the
# Windows default-instance folder, which is replaced by this server's default
# data folder. A database that already exists is left as it is.
#
# Then (idempotent, rows and principals only, never schema):
#  - the warehouse's unknown members and statuses (warehouse-rows.sql);
#  - read access to UnifiedBoxDW for powerbi_reader (db_datareader);
#  - with UNIFIEDBOX_APP_PASSWORD set, the backend's login unifiedbox_app
#    (app-login.sql).
#
# Runs inside the SQL Server container (it needs sqlcmd and MSSQL_SA_PASSWORD):
#   docker cp database/sqlserver/. <container>:/tmp/unifiedbox-schema
#   docker exec [-e UNIFIEDBOX_APP_PASSWORD=...] <container> bash /tmp/unifiedbox-schema/deploy.sh
# (the "/." copies the folder's content, replacing an earlier copy in place)
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
sqlcmd() { /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "${MSSQL_SA_PASSWORD}" -C -b -I -f 65001 "$@"; }
scalar() { sqlcmd -h -1 -W -Q "SET NOCOUNT ON; $1" | head -n 1 | tr -d '[:space:]'; }

data_dir="$(sqlcmd -h -1 -W -Q "SET NOCOUNT ON; SELECT CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath'))" | head -n 1 | tr -d '\r')"

# dwunifiedbox.sql creates the user powerbi_reader FOR LOGIN powerbi_reader. The
# login is server-level, so no script creates it: make one with a random
# password nobody knows. Set a real one with ALTER LOGIN before using it.
if [ "$(scalar "SELECT CASE WHEN SUSER_ID(N'powerbi_reader') IS NULL THEN 0 ELSE 1 END")" = "0" ]; then
  password="Pb1!$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  sqlcmd -Q "CREATE LOGIN [powerbi_reader] WITH PASSWORD = N'${password}'"
  echo "Login powerbi_reader created with a random password (ALTER LOGIN to set one)."
fi

for pair in "UnifiedBox1:dbunifedbox.sql" "UnifiedBoxDW:dwunifiedbox.sql"; do
  db="${pair%%:*}"
  file="${pair#*:}"
  if [ "$(scalar "SELECT COUNT(*) FROM sys.databases WHERE name = N'${db}'")" != "0" ]; then
    echo "${db} already exists, left as it is."
    continue
  fi
  sed "s|C:\\\\Program Files\\\\Microsoft SQL Server\\\\MSSQL17.MSSQLSERVER\\\\MSSQL\\\\DATA\\\\|${data_dir}|g" \
    "${dir}/schema/${file}" > "/tmp/${file}"
  sqlcmd -i "/tmp/${file}"
  rm -f "/tmp/${file}"
  echo "${db} created from schema/${file}."
done

sqlcmd -i "${dir}/warehouse-rows.sql"
echo "Warehouse unknown members and statuses ensured."

# The script creates the user powerbi_reader but grants it nothing, so Power
# BI would be refused every SELECT (decision D15). Read-only on the warehouse
# only: a role membership, idempotent, no schema change.
sqlcmd -Q "USE [UnifiedBoxDW];
IF IS_ROLEMEMBER(N'db_datareader', N'powerbi_reader') = 0
  ALTER ROLE [db_datareader] ADD MEMBER [powerbi_reader];"
echo "powerbi_reader can read UnifiedBoxDW."

if [ -n "${UNIFIEDBOX_APP_PASSWORD:-}" ]; then
  # Letters and digits only (it is written into a quoted SQL literal), and
  # upper case, lower case and digits (SQL Server's password policy)
  pw="${UNIFIEDBOX_APP_PASSWORD}"
  if ! [[ "${pw}" =~ ^[A-Za-z0-9]{16,}$ && "${pw}" =~ [A-Z] && "${pw}" =~ [a-z] && "${pw}" =~ [0-9] ]]; then
    echo "UNIFIEDBOX_APP_PASSWORD: 16+ characters, letters and digits only, with upper case, lower case and digits." >&2
    echo "Generate one with: openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32" >&2
    exit 1
  fi
  sqlcmd -i "${dir}/app-login.sql"
  echo "Login unifiedbox_app ready (read/write and EXECUTE on UnifiedBox1 and UnifiedBoxDW)."
fi
