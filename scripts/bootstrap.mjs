import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.BOOTSTRAP_DATABASE_URL,
  appPassword = process.env.APP_DB_PASSWORD,
  migrationPassword = process.env.MIGRATOR_DB_PASSWORD;
if (!url || !appPassword || !migrationPassword)
  throw new Error('BOOTSTRAP_DATABASE_URL, APP_DB_PASSWORD, MIGRATOR_DB_PASSWORD required');
const c = new pg.Client({
  connectionString: url,
  ssl:
    process.env.DB_SSL_ENABLED === 'false'
      ? false
      : {
          rejectUnauthorized: true,
          ...(process.env.DB_SSL_CA_PATH
            ? { ca: readFileSync(process.env.DB_SSL_CA_PATH, 'utf8') }
            : {}),
        },
});
await c.connect();
try {
  await c.query('BEGIN');
  for (const [role, password] of [
    ['notification_app', appPassword],
    ['notification_migrator', migrationPassword],
  ]) {
    if (!(await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
      const sql = await c.query(
        "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L',$1::text,$2::text)",
        [role, password],
      );
      await c.query(sql.rows[0].format);
    }
  }
  // Managed PostgreSQL administrators may have CREATEROLE without SUPERUSER.
  // Schema ownership and default privileges require membership in this role.
  const membership = await c.query(
    "SELECT format('GRANT notification_migrator TO %I', current_user)",
  );
  await c.query(membership.rows[0].format);
  await c.query('CREATE SCHEMA IF NOT EXISTS notification AUTHORIZATION notification_migrator');
  await c.query('GRANT USAGE ON SCHEMA notification TO notification_app');
  await c.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE notification_migrator IN SCHEMA notification GRANT SELECT,INSERT,UPDATE ON TABLES TO notification_app',
  );
  await c.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE notification_migrator IN SCHEMA notification GRANT USAGE,SELECT ON SEQUENCES TO notification_app',
  );
  await c.query('COMMIT');
  console.log('Bootstrap complete; no passwords printed');
} catch {
  await c.query('ROLLBACK');
  throw new Error('Bootstrap failed; check administrator privileges and configuration');
} finally {
  await c.end();
}
