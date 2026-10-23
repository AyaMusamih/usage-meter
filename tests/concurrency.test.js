import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://usage_app:local_dev_password@127.0.0.1:5433/usage_meter_test";

const { app } = await import("../dist/index.js");
const { pool } = await import("../dist/db.js");

let server;
let baseUrl;

async function api(method, path, apiKey, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

// Creates an account (monthly/perRequest limits) with the given users on a big user plan.
async function setup(name, accountMonthly, accountPerRequest, userIds) {
  const created = (await api("POST", "/accounts", null, { name })).body;
  const path = `/accounts/${created.account.id}`;
  const key = created.apiKey;

  const accountPlan = (
    await api("POST", `${path}/plans`, key, {
      name: "Concurrency Account Plan",
      monthlyLimit: accountMonthly,
      maxRequestUnits: accountPerRequest,
    })
  ).body.plan;
  await api("PUT", `${path}/plan`, key, { planId: accountPlan.id });

  const userPlan = (
    await api("POST", `${path}/user-plans`, key, {
      name: "Concurrency User Plan",
      monthlyLimit: 100000,
      maxRequestUnits: accountPerRequest,
    })
  ).body.plan;
  for (const id of userIds) {
    const r = await api("POST", `${path}/users`, key, {
      externalUserId: id,
      planId: userPlan.id,
    });
    assert.equal(r.status, 201);
  }
  return { path, key };
}

test("start server", async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test("60 parallel requests never exceed the shared account allowance", async () => {
  // Account allows 100 units. 60 requests x 5 units = 300 demanded.
  // Exactly 20 requests (100 units) may be accepted.
  const { path, key } = await setup(`Race ${Date.now()}`, 100, 10, ["alice", "bob"]);

  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      api("POST", `${path}/usage`, key, {
        externalUserId: i % 2 === 0 ? "alice" : "bob",
        requestId: `race-${i}`,
        units: 5,
      }),
    ),
  );

  const accepted = results.filter((r) => r.body.accepted);
  const rejected = results.filter((r) => !r.body.accepted);

  assert.equal(accepted.length, 20);
  assert.equal(rejected.length, 40);
  for (const r of rejected) {
    assert.equal(r.status, 429);
    assert.equal(r.body.rejection.level, "account");
    assert.equal(r.body.rejection.rule, "monthly_allowance");
  }

  const usage = (await api("GET", `${path}/usage`, key)).body;
  assert.equal(usage.account.used, 100);
  assert.equal(usage.account.remaining, 0);
  const userTotal = usage.users.reduce((sum, u) => sum + u.used, 0);
  assert.equal(userTotal, 100);
});

test("the same request ID sent 10 times in parallel is counted once", async () => {
  const { path, key } = await setup(`Retry ${Date.now()}`, 1000, 50, ["alice"]);

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      api("POST", `${path}/usage`, key, {
        externalUserId: "alice",
        requestId: "same-request",
        units: 7,
      }),
    ),
  );

  assert.ok(results.every((r) => r.body.accepted));
  assert.equal(results.filter((r) => r.body.duplicate === false).length, 1);
  assert.equal(results.filter((r) => r.body.duplicate === true).length, 9);

  const usage = (await api("GET", `${path}/usage`, key)).body;
  assert.equal(usage.account.used, 7);
});

test("stop server and close database pool", async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});
