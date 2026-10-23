// Dev check: connect to a database URL (default TIGER_DATABASE_URL) and report version, extensions and table
// count. Never prints the URL or credentials.
import 'dotenv/config';
import pg from 'pg';
import { pgConfig } from '../../packages/core/src/db.ts';

const url = process.env[process.argv[2] ?? 'TIGER_DATABASE_URL'];
if (!url) throw new Error(`${process.argv[2] ?? 'TIGER_DATABASE_URL'} is not set`);
const timer = setTimeout(() => {
  console.error('timed out after 30s');
  process.exit(2);
}, 30_000);
const c = new pg.Client({ ...pgConfig(url), connectionTimeoutMillis: 20_000 });
const t0 = Date.now();
await c.connect();
console.log(`connected in ${Date.now() - t0} ms, TLS verified against pinned CA`);
console.log((await c.query('SELECT version()')).rows[0].version.slice(0, 60));
console.log(
  (await c.query("SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('vector','vectorscale','timescaledb') ORDER BY name")).rows,
);
const tables = (await c.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")).rows;
for (const t of tables) {
  const n = (await c.query(`SELECT count(*)::int n FROM public.${pg.escapeIdentifier(t.table_name)}`)).rows[0].n;
  console.log(`  ${t.table_name}: ${n} rows`);
}
console.log('public tables:', tables.length);
await c.end();
clearTimeout(timer);
