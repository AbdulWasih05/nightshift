// Recreates a `<db>_test_<suite>` database next to TEST_DATABASE_URL (a LOCAL Postgres) and applies all migrations.
// Never touches DATABASE_URL, which may be the shared Tiger database. Returns null (tests no-op) if
// TEST_DATABASE_URL is unset or unreachable, so `pnpm test` still runs on a laptop without Docker.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', '..', 'db', 'migrations');

export async function freshTestDb(suite: string): Promise<pg.Pool | null> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  const admin = new URL(url);
  if (!['localhost', '127.0.0.1', '::1'].includes(admin.hostname)) throw new Error('TEST_DATABASE_URL must point at a local Postgres');
  if (!/^[a-z0-9_]+$/.test(suite)) throw new Error(`bad suite name ${suite}`);
  // One database per test file: vitest runs files in parallel.
  const testName = `${admin.pathname.slice(1)}_test_${suite}`;
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
