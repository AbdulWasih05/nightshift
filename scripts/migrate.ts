// Applies db/migrations/*.sql in order, once each, inside a transaction per file.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { pgConfig } from '../packages/core/src/db.ts';

const dir = join(import.meta.dirname, '..', 'db', 'migrations');
// MIGRATE_URL lets the same script migrate a second database (e.g. Tiger) without changing DATABASE_URL.
const target = process.env.MIGRATE_URL || process.env.DATABASE_URL;
if (!target) throw new Error('DATABASE_URL is not set');
const client = new pg.Client(pgConfig(target));

await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  console.log('migrations up to date');
} finally {
  await client.end();
}
