# Usage Meter

A TypeScript/Express/PostgreSQL service that other applications call to track usage and decide whether their users may perform an action. Each account has a shared monthly allowance, and each user has an individual allowance. A request is accepted only if both allow it.

## Quick start

Requires Docker Desktop with Docker Compose.

```bash
docker compose up --build
```

This starts PostgreSQL (schema applied automatically), the API on `http://localhost:3000`, and the example client. The client creates its own demo account and prints a walkthrough, then exits. The API and database keep running.

- Health check: `curl http://localhost:3000/health`
- Re-run the demo: `docker compose run --rm client`
- Stop: `docker compose down` (data is kept in a Docker volume; `docker compose down -v` deletes it)

## Example client

`examples/usage-demo.mjs` plays a document-processing app that calls the service with an account API key. It sets up one account (100 units/month, 50 per request) with two users on different plans (alice: Basic 60/month, 20 per request; bob: Premium 100/month, 50 per request) and shows:

1. an accepted action
2. a safe retry (same request ID, not counted twice)
3. a rejection caused by the **user** limit
4. an accepted action for bob
5. a rejection caused by the shared **account** limit
6. alice switched to Premium, and the same request that was rejected in step 3 is now accepted. The client code is unchanged; only the plan changed.

Each line shows the decision and the remaining allowance for the account and the user.

## Concepts

| Concept | Meaning |
|---|---|
| Account | An application calling the service. Its plan sets limits shared by all its users. |
| User | A user of that application, registered under an account (`externalUserId`). Its plan sets individual limits. |
| Plan | A named set of rules: monthly allowance and maximum units per request. |
| Units | The single resource that is metered (for example document-processing credits). |

Every request must satisfy **both** the account plan and the user plan. A user with a large plan cannot exceed the account's allowance. Accepted units count against both the user and the account.

## API keys

`POST /accounts` returns the account ID and an API key. The key is shown **once**; only its hash is stored. Send it in the `x-api-key` header on every other call. A key only works for its own account: another account's key, or a missing or invalid key, gets `401`, and plans or users from another account are never visible.

```bash
curl -X POST http://localhost:3000/accounts \
  -H "Content-Type: application/json" \
  -d '{"name":"Example App"}'
```

Do not commit API keys or `.env` files.

## Predefined plans

Every new account receives these read-only plans (changing them returns `403`). Starter is assigned to the account by default.

| Plan | Scope | Monthly allowance | Max per request |
|---|---|---:|---:|
| Starter | account | 100,000 | 1,000 |
| Pro | account | 200,000 | 2,000 |
| Basic User | user | 5,000 | 100 |
| Premium User | user | 20,000 | 500 |

Accounts can also create their own plans (see the API below), which can be edited at any time.

## API

All endpoints except `/health` and `POST /accounts` need the `x-api-key` header. In the table, `:id` is the account ID.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | API and database health |
| POST | `/accounts` | Create an account (returns the API key once) |
| GET | `/accounts/:id/plans` | List the account's plans (predefined and custom) |
| GET | `/accounts/:id/plans/:planId` | View one plan |
| POST | `/accounts/:id/plans` | Create a custom **account** plan |
| POST | `/accounts/:id/user-plans` | Create a custom **user** plan |
| PATCH | `/accounts/:id/plans/:planId` | Update a custom plan (`name`, `monthlyLimit`, `maxRequestUnits`) |
| GET | `/accounts/:id/plan` | The account plan currently applied |
| PUT | `/accounts/:id/plan` | Assign an account plan: `{"planId": "..."}` |
| POST | `/accounts/:id/users` | Register a user: `{"externalUserId": "...", "planId": "..."}` |
| GET | `/accounts/:id/users` | List users and their plans |
| PUT | `/accounts/:id/users/:externalUserId/plan` | Change a user's plan: `{"planId": "..."}` |
| POST | `/accounts/:id/usage` | **Consume units** |
| GET | `/accounts/:id/usage` | Consumed and remaining for the account and all users (optional `?month=YYYY-MM`, default is the current UTC month) |
| GET | `/accounts/:id/users/:externalUserId/usage` | Same, for one user (optional `?month=YYYY-MM`) |
| GET | `/accounts/:id/usage/summary` | Current-month account summary |
| GET | `/accounts/:id/requests` | Request history (accepted and rejected), newest first |

### Consume units

```bash
curl -X POST http://localhost:3000/accounts/ACCOUNT_ID/usage \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"externalUserId":"alice","requestId":"doc-001","units":25}'
```

Accepted (`201`):

```json
{
  "duplicate": false,
  "accepted": true,
  "requestId": "doc-001",
  "units": 25,
  "remaining": { "account": 75, "user": 35 },
  "createdAt": "2026-10-23T12:00:00.000Z"
}
```

Rejected (`429`) names the rule that prevented the request and who owns it:

```json
{
  "duplicate": false,
  "accepted": false,
  "requestId": "doc-002",
  "units": 25,
  "rejection": { "level": "user", "rule": "max_units_per_request", "limit": 20 },
  "remaining": { "account": 75, "user": 35 },
  "createdAt": "2026-10-23T12:00:01.000Z"
}
```

`rule` is `max_units_per_request` or `monthly_allowance`; `level` is `account` or `user`. A rejection consumes nothing.

| Status | Meaning |
|---|---|
| 201 | Accepted and recorded |
| 200 | Retry of a request already decided (same decision returned, `duplicate: true`) |
| 429 | Rejected by a limit (see `rejection`) |
| 400 | Invalid input |
| 401 | Missing or invalid API key |
| 404 | Account, user, or plan not found |
| 409 | Request ID reused with different user or units |

### Usage summary

```bash
curl http://localhost:3000/accounts/ACCOUNT_ID/usage/summary \
  -H "x-api-key: YOUR_API_KEY"
```

The response reports the current UTC month, accepted usage, monthly limit, remaining units, and usage percentage.

### Request history

```bash
curl "http://localhost:3000/accounts/ACCOUNT_ID/requests?limit=20&offset=0&month=2026-10&externalUserId=alice" \
  -H "x-api-key: YOUR_API_KEY"
```

All query parameters are optional.

| Parameter | Description |
|---|---|
| `limit` | Page size, 1-100 (default 20) |
| `offset` | Number of records to skip (default 0) |
| `month` | UTC month, formatted like `2026-10` |
| `externalUserId` | Only requests from this user |

The response contains `total` (number of matching records), `limit`, `offset`, and a `requests` array. Rejected requests include a `rejection` object. Invalid parameters return `400`.

## Rules and how they combine

Two rule types exist, on both account and user plans: **monthly allowance** (per UTC calendar month) and **maximum units per request**. Checks run in this order and the first failure is reported:

1. account max per request
2. user max per request
3. account monthly allowance
4. user monthly allowance

New usage belongs to the UTC month in which it is processed. Each month starts at zero for the account and every user; earlier months stay queryable.

## Plan changes

- Changes apply to **new** requests as soon as the update succeeds. Editing a custom plan affects every account or user assigned to it.
- Switching a plan keeps units already consumed this month; it does not grant a fresh allowance.
- If an allowance is lowered below existing usage, remaining shows `0` and further consumption at that level is rejected until allowance is available again.
- Request history is never rewritten. Each stored decision keeps the outcome it had at the time.

## Retries (idempotency)

`requestId` is unique per account. If the same `requestId` arrives again with the same user and units, the stored decision is returned (`200`, `duplicate: true`) and nothing is counted twice, whether the original was accepted or rejected. Reusing it with different data returns `409`. This is safe even when retries arrive concurrently.

## Design

- **Schema** (`db/schema.sql`): `accounts`, `plans`, `account_plan_assignments`, `users`, `usage_events` (accepted units only), and `request_log` (every decision). `usage_events` and `request_log` both have `UNIQUE (account_id, request_id)`. Composite foreign keys ensure a user can only appear under its own account.
- **Usage is derived, not stored as a counter.** Monthly totals are `SUM(units)` over `usage_events` for the UTC month. This keeps plan switches and month rollovers simple: there is no counter to reset or migrate.
- **Consume path** (`src/services/usageService.ts`): one transaction that locks the account row (`SELECT ... FOR UPDATE`) and the user row, loads both plans, checks for a prior decision with the same request ID, computes usage, applies the rules, then writes `request_log` and, if accepted, `usage_events`. The account lock serialises requests per account, so concurrent requests cannot overspend, while different accounts proceed in parallel.
- **API keys** are random, shown once, and stored hashed.

## Product assumptions

- One metered resource ("units"). Units are positive integers.
- Months are UTC calendar months.
- A rejected request is still logged, so retries get the same answer and history shows rejections.
- Predefined plans are copied into each account at creation and are read-only; custom plans are per account and can be shared by many users with separate usage.
- Plan changes apply only to future requests. For a past month, "remaining" is measured against the plans applied *now*, not the plans in force at the time.
- Rejections use HTTP `429`; the response body, not just the status, says why.
- Users are identified by the caller's own `externalUserId`.

## Tests

Start the database and create the test database (one-time setup). The database container publishes PostgreSQL on `localhost:5433`, which is where the tests connect by default.

```bash
docker compose up -d db
docker compose exec db psql -U usage_app -d usage_meter -c "CREATE DATABASE usage_meter_test;"
docker compose exec -T db psql -U usage_app -d usage_meter_test < db/schema.sql
```

Run the suite (this builds the project first):

```bash
npm test
```

To use a different database, set `TEST_DATABASE_URL`.

The suite covers input validation, API key checks and account isolation, duplicate and retry handling, monthly limit enforcement, usage and history endpoints (including previous months and pagination), and concurrency: 60 parallel requests against a 100-unit allowance accept exactly 20, and ten parallel retries of one request ID count once.

## Performance testing

Two scripts. Results are documented in [`docs/performance-results.md`](docs/performance-results.md).

Concurrent load test against the running stack (start it first with `docker compose up --build`):

```bash
# 1 account, 5000 requests, concurrency 50 (defaults)
npm run load

# the same load spread over 10 accounts
LOAD_ACCOUNTS=10 npm run load
```

Options: `BASE_URL`, `LOAD_REQUESTS`, `LOAD_CONCURRENCY`, `LOAD_ACCOUNTS`, `LOAD_USERS`. The script creates real accounts and data, so do not run it against production. It also checks that stored account and user totals equal the number of accepted requests, and exits with a non-zero code if the check fails or any request fails.

Sequential baseline against the test database:

```bash
npm run build
node scripts/performance.mjs
```

## Known limitations

- **Per-account throughput is limited by the account lock.** All requests for one account run one at a time, while different accounts run in parallel. A running-counter design would remove most of this limit at the cost of more complex plan-change and month-rollover handling. See `docs/performance-results.md` for measured numbers.
- Monthly usage is summed from events on each request. Behavior at very large event volumes per account has not been tested beyond the load test sizes.
- Remaining allowance for past months uses current plans (see assumptions).
- No billing, refunds, multiple resource types, roles, or end-user login (out of scope).
- Example credentials in `compose.yaml` are for local development only.
