\getenv migrator_password MIGRATOR_PASSWORD
\getenv app_password APP_PASSWORD

SELECT format('CREATE ROLE wager_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wager_migrator') \gexec
SELECT format('CREATE ROLE wager_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wager_app') \gexec
ALTER DATABASE wager_ledger OWNER TO wager_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
