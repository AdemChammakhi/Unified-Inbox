-- The backend's own login, so it never runs as sa. A login and database users
-- are security principals, not schema: no table, column, constraint, index,
-- view or procedure changes (decision D5). Idempotent; re-running resets the
-- password.
--
-- Rights, all the app needs and nothing more:
--  - UnifiedBox1: read and write every table; EXECUTE for dbo.fn_DateTimeCombine.
--  - UnifiedBoxDW: read and write (the calendar rows, etl_log) and EXECUTE for
--    dbo.usp_run_etl, whose dynamic EXEC runs each loader with the caller's
--    rights. The loaders read UnifiedBox1 through the src_* synonyms with the
--    same login's rights there (cross-database ownership chaining is off).
--
-- The password comes from the sqlcmd variable UNIFIEDBOX_APP_PASSWORD, which
-- sqlcmd also reads from the environment (deploy.sh passes it that way). Use
-- letters and digits only, mixing upper case, lower case and digits (SQL
-- Server's password policy), e.g.
--   openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32
USE [master];
IF SUSER_ID(N'unifiedbox_app') IS NULL
  CREATE LOGIN [unifiedbox_app] WITH PASSWORD = N'$(UNIFIEDBOX_APP_PASSWORD)', DEFAULT_DATABASE = [UnifiedBox1];
ELSE
  ALTER LOGIN [unifiedbox_app] WITH PASSWORD = N'$(UNIFIEDBOX_APP_PASSWORD)';
GO

USE [UnifiedBox1];
IF USER_ID(N'unifiedbox_app') IS NULL CREATE USER [unifiedbox_app] FOR LOGIN [unifiedbox_app];
ALTER ROLE [db_datareader] ADD MEMBER [unifiedbox_app];
ALTER ROLE [db_datawriter] ADD MEMBER [unifiedbox_app];
GRANT EXECUTE ON SCHEMA::[dbo] TO [unifiedbox_app];
GO

USE [UnifiedBoxDW];
IF USER_ID(N'unifiedbox_app') IS NULL CREATE USER [unifiedbox_app] FOR LOGIN [unifiedbox_app];
ALTER ROLE [db_datareader] ADD MEMBER [unifiedbox_app];
ALTER ROLE [db_datawriter] ADD MEMBER [unifiedbox_app];
GRANT EXECUTE ON SCHEMA::[dbo] TO [unifiedbox_app];
GO
