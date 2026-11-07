import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database';

const testUrl = process.env.API_TEST_DATABASE_URL;
const testSuite = test('API integration', { skip: !testUrl }, async (t) => {
  const parsedUrl = new URL(testUrl!);
  const dbName = decodeURIComponent(parsedUrl.pathname.slice(1));
  assert.match(dbName, /test/i, 'API_TEST_DATABASE_URL must target a test database');

  const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: testUrl });
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  let baseUrl = '';
  let sellerEmail = '';

  try {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.JWT_ACCESS_SECRET = randomUUID() + randomUUID();

    await admin.query(`CREATE SCHEMA "${schema}"`);
    const schemaUrl = new URL(testUrl!);
    schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = schemaUrl.toString();
    const appPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const migrationsDirectory = resolve(process.cwd(), 'migrations');
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const migrationFile of migrationFiles) {
      await appPool.query(
        await readFile(resolve(migrationsDirectory, migrationFile), 'utf8'),
      );
    }
    await appPool.end();

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {},
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.idempotencyKey
          ? { 'Idempotency-Key': options.idempotencyKey }
          : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = response.status === 204 ? null : await response.json();
    return { status: response.status, body };
  }

  await t.test('registration, login, role enforcement, and sale integrity', async () => {
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok' });

    const unique = randomUUID();
    sellerEmail = `seller-${unique}@example.test`;
    const registration = await request('/auth/register', {
      method: 'POST',
      body: {
        name: 'Test Seller',
        email: sellerEmail,
        password: 'seller-password-123',
      },
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.body.user.role, 'seller');

    const forbiddenRole = await request('/auth/register', {
      method: 'POST',
      body: {
        name: 'Attempted Owner',
        email: `attacker-${unique}@example.test`,
        password: 'seller-password-123',
        role: 'owner',
      },
    });
    assert.equal(forbiddenRole.status, 400);

    const database = app!.get(Database);
    const ownerEmail = `registered-owner-${unique}@example.test`;
    const ownerRegistration = await request('/auth/register-owner', {
      method: 'POST',
      body: {
        name: 'Registered Owner',
        email: ownerEmail,
        password: 'owner-password-123',
      },
    });
    assert.equal(ownerRegistration.status, 201);
    assert.equal(ownerRegistration.body.user.role, 'owner');
    const duplicateOwnerRegistration = await request('/auth/register-owner', {
      method: 'POST',
      body: {
        name: 'Duplicate Owner',
        email: ownerEmail,
        password: 'owner-password-456',
      },
    });
    assert.equal(duplicateOwnerRegistration.status, 401);

    const badLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: sellerEmail, password: 'incorrect-password' },
    });
    assert.equal(badLogin.status, 401);

    const sellerLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: sellerEmail, password: 'seller-password-123' },
    });
    assert.equal(sellerLogin.status, 200);
    const sellerToken = sellerLogin.body.accessToken as string;
    const sellerUserId = sellerLogin.body.user.id as string;

    const argon2 = await import('argon2');
    const provisionedOwnerEmail = `owner-${unique}@example.test`;
    const ownerHash = await argon2.hash('owner-password-12345', {
      type: argon2.argon2id,
    });
    await database.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, 'Test Owner', 'owner')`,
      [provisionedOwnerEmail, ownerHash],
    );
    const ownerLogin = await request('/auth/login', {
      method: 'POST',
      body: {
        email: provisionedOwnerEmail,
        password: 'owner-password-12345',
      },
    });
    assert.equal(ownerLogin.status, 200);
    assert.equal(ownerLogin.body.user.role, 'owner');
    const ownerToken = ownerLogin.body.accessToken as string;

    const sellerProductWrite = await request('/products', {
      method: 'POST',
      token: sellerToken,
      body: { id: `seller-product-${unique}`, name: 'Nope', quantity: 1 },
    });
    assert.equal(sellerProductWrite.status, 403);

    const productId = `stock-${unique}`;
    const product = await request('/products', {
      method: 'POST',
      token: ownerToken,
      body: { id: productId, name: 'Test Rice', quantity: 5 },
    });
    assert.equal(product.status, 201);

    const firstKey = randomUUID();
    const saleBody = {
      productId,
      quantity: 2,
      rate: 73,
      store: 'Test Store',
      contact: '1234567890',
      location: 'Test City',
    };
    const sale = await request('/sales', {
      method: 'POST',
      token: sellerToken,
      idempotencyKey: firstKey,
      body: saleBody,
    });
    assert.equal(sale.status, 201);
    assert.equal(sale.body.totalAmount, 146);
    assert.equal(sale.body.sellerId, sellerUserId);

    const duplicate = await request('/sales', {
      method: 'POST',
      token: sellerToken,
      idempotencyKey: firstKey,
      body: saleBody,
    });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.body.id, sale.body.id);

    const changedDuplicate = await request('/sales', {
      method: 'POST',
      token: sellerToken,
      idempotencyKey: firstKey,
      body: { ...saleBody, quantity: 1 },
    });
    assert.equal(changedDuplicate.status, 409);

    const raceProductId = `race-${unique}`;
    await request('/products', {
      method: 'POST',
      token: ownerToken,
      body: { id: raceProductId, name: 'Concurrent Rice', quantity: 3 },
    });
    const concurrentBody = { ...saleBody, productId: raceProductId, quantity: 2 };
    const results = await Promise.all([
      request('/sales', {
        method: 'POST',
        token: sellerToken,
        idempotencyKey: randomUUID(),
        body: concurrentBody,
      }),
      request('/sales', {
        method: 'POST',
        token: sellerToken,
        idempotencyKey: randomUUID(),
        body: concurrentBody,
      }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [201, 409],
    );
    const remaining = await request(`/products?limit=100`, { token: ownerToken });
    assert.equal(
      remaining.body.items.find((item: { id: string }) => item.id === raceProductId)
        .quantity,
      1,
    );

    const approved = await request(`/sales/${sale.body.id}/approve`, {
      method: 'PATCH',
      token: ownerToken,
      body: {},
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.orderStatus, 'approved');
    const reapproved = await request(`/sales/${sale.body.id}/approve`, {
      method: 'PATCH',
      token: ownerToken,
      body: {},
    });
    assert.equal(reapproved.status, 409);
  });

  await t.test('refresh tokens rotate and logout revokes the session', async () => {
    const email = `session-${randomUUID()}@example.test`;
    const login = await request('/auth/register', {
      method: 'POST',
      body: { name: 'Session Seller', email, password: 'session-password-123' },
    });
    assert.equal(login.status, 201);

    const rotated = await request('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.body.refreshToken },
    });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refreshToken, login.body.refreshToken);

    const replay = await request('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.body.refreshToken },
    });
    assert.equal(replay.status, 401);
    const revokedFamily = await request('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: rotated.body.refreshToken },
    });
    assert.equal(revokedFamily.status, 401);

    const secondLogin = await request('/auth/login', {
      method: 'POST',
      body: { email, password: 'session-password-123' },
    });
    const logout = await request('/auth/logout', {
      method: 'POST',
      body: { refreshToken: secondLogin.body.refreshToken },
    });
    assert.equal(logout.status, 204);
    const afterLogout = await request('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: secondLogin.body.refreshToken },
    });
    assert.equal(afterLogout.status, 401);
  });
  } finally {
    if (app) await app.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

void testSuite;
