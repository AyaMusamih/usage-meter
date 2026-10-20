
# Usage Meter

A TypeScript REST API for tracking and enforcing monthly usage limits for accounts and their users. It uses Express, PostgreSQL, and Docker Compose.

## Features

- API-key authentication for accounts.
- Account and user monthly usage limits.
- Per-request unit limits.
- Usage recording with request IDs to prevent duplicate consumption.
- Account monthly usage summary.
- Account and user plan creation.
- Persistent PostgreSQL storage.
- Health check endpoint.

## Requirements

- Docker Desktop with Docker Compose.

## Run with Docker Compose

Build and start the API and database:

```bash
docker compose up --build -d
```

Check the running services:

```bash
docker compose ps
```

Check API and database health:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok","database":"connected"}
```

Stop the services:

```bash
docker compose down
```

The database uses a named Docker volume. Data remains after stopping the services. Avoid `docker compose down -v` unless you intend to delete the database volume.


## Authentication

Create an account:

```bash
curl -X POST http://localhost:3000/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"Example App"}'
```

The response includes the account ID and a generated API key. Save the key securely because the service stores its hash.

Authenticated requests must include the account's API key in the `x-api-key` header.

Do not commit API keys or `.env` files.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Check API and database health |
| POST | `/accounts` | Create an account and default plans |
| POST | `/accounts/:accountId/plans` | Create and assign an account plan |
| POST | `/accounts/:accountId/user-plans` | Create a user plan |
| POST | `/accounts/:accountId/users` | Create a user |
| POST | `/accounts/:accountId/usage` | Record usage |
| GET | `/accounts/:accountId/usage/summary` | Get current-month account usage |

All endpoints except `/health` and account creation require authentication.

## Create a User Plan

```bash
curl -X POST http://localhost:3000/accounts/ACCOUNT_ID/user-plans \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "name": "Basic User",
    "monthlyLimit": 5000,
    "maxRequestUnits": 100
  }'
```

Use the returned plan ID to create a user:

```bash
curl -X POST http://localhost:3000/accounts/ACCOUNT_ID/users \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "externalUserId": "user-001",
    "planId": "USER_PLAN_ID"
  }'
```

## Record Usage

```bash
curl -X POST http://localhost:3000/accounts/ACCOUNT_ID/usage \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "externalUserId": "user-001",
    "requestId": "request-001",
    "units": 25
  }'
```

Each request requires an external user ID, a request ID, and a positive integer number of units.

- `201 Created`: usage was recorded.
- `200 OK`: the same request was already recorded.
- `400 Bad Request`: invalid input.
- `401 Unauthorized`: missing or invalid API key.
- `404 Not Found`: account, user, or plan not found.
- `409 Conflict`: request ID reused with different data.
- `429 Too Many Requests`: a usage limit was exceeded.

Rejected requests do not consume usage. Repeating a request with the same request ID and payload does not count the usage twice.

## Usage Summary

```bash
curl http://localhost:3000/accounts/ACCOUNT_ID/usage/summary \
  -H "x-api-key: YOUR_API_KEY"
```

The response reports the current UTC month, accepted usage, monthly limit, remaining units, and usage percentage.

## Usage Rules

- Monthly periods follow UTC calendar months.
- Both account and user limits must be satisfied.
- Per-request unit limits are enforced.
- Usage events are stored in PostgreSQL.

## Testing

Run the automated test suite:

```bash
npm test
```

The suite includes API validation tests, authentication tests, usage input validation tests, and a PostgreSQL integration test covering usage recording, duplicate request handling, and monthly limit enforcement.

The integration test uses a separate `usage_meter_test` database. Ensure that this database exists and has been initialized with `db/schema.sql` before running the integration tests.

## Performance Testing

Build the application and run the sequential performance test:

```bash
npm run build
node scripts/performance.mjs
```

The test uses the `usage_meter_test` database by default and sends 1,000 sequential usage requests. You can change the request count using `PERF_REQUESTS`, for example:

```bash
PERF_REQUESTS=500 node scripts/performance.mjs
```

The script reports successful and failed requests, throughput, average latency, and P95 latency.

The initial local run processed 1,000 requests with 100% success, 188.29 requests/second, 5.31 ms average latency, and 7.85 ms P95 latency. These are baseline results from a sequential local test, not a production capacity guarantee.

Detailed results are documented in [`docs/performance-results.md`](docs/performance-results.md).

## Limitations

- Dedicated endpoints for listing and updating plans are not implemented.
- Changing an existing user's plan through a dedicated endpoint is not implemented.
- Historical usage reports, request outcome history, and pagination are not implemented.
- Performance testing currently covers sequential requests; concurrent-load and sustained-load testing remain to be done.
- The example client is available through the optional Docker Compose `demo` profile. It requires a valid account ID, API key, and an existing user configured for the demo.

## Technology

- TypeScript and Node.js
- Express
- PostgreSQL
- Docker Compose
