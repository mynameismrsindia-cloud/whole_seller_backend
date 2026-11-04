import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required.');

  const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
  });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [738194220]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const directory = join(__dirname, '..', 'migrations');
    const files = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (rowCount) continue;

      await client.query('BEGIN');
      try {
        await client.query(await readFile(join(directory, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          name,
        ]);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [738194220]);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
