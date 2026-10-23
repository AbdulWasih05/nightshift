import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

let pool: pg.Pool | undefined;

// Tiger Cloud presents a certificate chain rooted in Timescale's own CA (CN=ca.timescale.com), which Node does
// not trust by default. Pin that CA (certs/tiger-ca.pem, public) and keep full verification, rather than
// turning verification off. Override with DATABASE_SSL_CA=<path to PEM>.
const DEFAULT_TIGER_CA = join(import.meta.dirname, '..', '..', '..', 'certs', 'tiger-ca.pem');

/** Connection config for a URL: plain for local Postgres, CA-pinned TLS for Tiger Cloud. */
export function pgConfig(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  const caPath = process.env.DATABASE_SSL_CA || (url.hostname.endsWith('.timescale.com') ? DEFAULT_TIGER_CA : '');
  if (!caPath) return { connectionString };
  // sslmode in the URL would override the explicit ssl object; drop it and set TLS here.
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  return { connectionString: url.toString(), ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true } };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ ...pgConfig(connectionString), max: 5, connectionTimeoutMillis: 20_000 });
    // An idle-client error (DB restart, laptop sleep, network blip to Tiger) must not crash the worker.
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
