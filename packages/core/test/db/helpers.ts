// Recreates a `<db>_test` database next to DATABASE_URL and applies all migrations to it.
// Returns null (tests no-op) if Postgres is unreachable, so `pnpm test` still runs on a laptop without Docker.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', '..', 'db', 'migrations');

export async function freshTestDb(): Promise<pg.Pool | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const admin = new URL(url);
  const testName = `${admin.pathname.slice(1)}_test`;
  const adminClient = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await adminClient.connect();
  } catch {
    console.warn('[test] Postgres unreachable; skipping DB tests');
    return null;
  }
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS ${testName} WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE ${testName}`);
  } finally {
    await adminClient.end();
  }
  const testUrl = new URL(url);
  testUrl.pathname = `/${testName}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 3 });
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(await readFile(join(MIGRATIONS, f), 'utf8'));
  }
  return pool;
}
