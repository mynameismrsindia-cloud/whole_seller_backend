# Wholesale API

NestJS API for the Seller Android and Owner Desktop apps. This directory is a
self-contained GitHub repository root for `whole_seller_backend`.

## Deploy to Railway

1. Create a Railway project and add a PostgreSQL service. The `Postgres` name in
   Railway variable references must match the database service's exact name.
2. Deploy this repository as a separate Node.js service. Railway detects
   `package.json`, installs dependencies, and runs the build script. The start
   command applies pending SQL migrations before starting the API on Railway's
   injected `PORT`. No Dockerfile or container setup is needed.
3. Add these variables to the API service:

   ```text
   DATABASE_URL=${{ Postgres.DATABASE_PRIVATE_URL }}
   DATABASE_SSL=false
   JWT_ACCESS_SECRET=<at-least-32-random-bytes>
   JWT_ACCESS_TTL=15m
   REFRESH_TOKEN_DAYS=30
   NODE_ENV=production
   ```

   Generate the JWT secret locally with `openssl rand -base64 48`; enter it
   directly in Railway and do not commit it. Check the PostgreSQL template's
   connection instructions before changing `DATABASE_SSL`; if its private URL
   requires TLS, configure TLS as required by that template.
4. Generate a public HTTPS domain for the API service. Verify its
   `/api/v1/health` endpoint returns `{"status":"ok"}`. This endpoint checks
   database connectivity.
5. Set the Flutter build environment to this API's URL ending in `/api/v1`.

The app's private connection string stays on the server. Never place
`DATABASE_PRIVATE_URL` in the Flutter app or public GitHub variables.

## Provision the first Owner

After first deployment and migrations, use Railway's service shell to provide
`OWNER_EMAIL`, `OWNER_NAME`, and `OWNER_PASSWORD` as temporary variables, then
run:

```sh
node dist/scripts/create-owner.js
```

Use an administrator-controlled password of at least 14 characters. The
password is Argon2id-hashed. Remove the temporary variables afterward. Public
registration creates Sellers only.

## Local development

Requirements: Node.js 20+ and PostgreSQL 15+.

```sh
npm ci
cp .env.example .env
npm run migrate
npm run start:dev
```

Set `DATABASE_URL` in `.env` to a local development database and generate a
local `JWT_ACCESS_SECRET`. Never use production credentials or data for local
development.

## Checks

```sh
npm test
API_TEST_DATABASE_URL=postgresql://.../wholesale_test npm test
```

Integration tests run only when `API_TEST_DATABASE_URL` points to a separate
database whose name includes `test`.
