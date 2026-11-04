import 'dotenv/config';
import * as argon2 from 'argon2';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const name = process.env.OWNER_NAME?.trim();
  const password = process.env.OWNER_PASSWORD;
  if (!connectionString || !email || !name || !password) {
    throw new Error(
      'DATABASE_URL, OWNER_EMAIL, OWNER_NAME, and OWNER_PASSWORD are required.',
    );
  }
  if (password.length < 14) {
    throw new Error('OWNER_PASSWORD must be at least 14 characters.');
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
  });
  try {
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
    });
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'owner')
       ON CONFLICT DO NOTHING
       RETURNING id, email`,
      [email, passwordHash, name],
    );
    if (!result.rowCount) {
      throw new Error(
        'An account with that email already exists. Owner creation made no changes.',
      );
    }
    console.log(`Provisioned owner ${result.rows[0].email}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
