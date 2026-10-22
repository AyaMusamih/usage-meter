import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://usage_app:local_dev_password@127.0.0.1:5433/usage_meter_test";

const { app } = await import("../dist/index.js");
const { pool } = await import("../dist/db.js");

test("usage and request history endpoints", async () => {
  const server = app.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

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

    // Two accounts, so we can also check isolation.
    const a = (await api("POST", "/accounts", null, { name: `Hist A ${Date.now()}` })).body;
    const b = (await api("POST", "/accounts", null, { name: `Hist B ${Date.now()}` })).body;
    const path = `/accounts/${a.account.id}`;
    const key = a.apiKey;

    const plan = (
      await api("POST", `${path}/user-plans`, key, {
        name: "History Plan",
        monthlyLimit: 50,
        maxRequestUnits: 30,
      })
    ).body.plan;
    for (const id of ["alice", "bob"]) {
      const r = await api("POST", `${path}/users`, key, { externalUserId: id, planId: plan.id });
      assert.equal(r.status, 201);
    }

    // alice: 20 accepted, 40 rejected (over 30 per request); bob: 10 accepted.
    assert.equal((await api("POST", `${path}/usage`, key, { externalUserId: "alice", requestId: "r1", units: 20 })).status, 201);
    assert.equal((await api("POST", `${path}/usage`, key, { externalUserId: "alice", requestId: "r2", units: 40 })).status, 429);
    assert.equal((await api("POST", `${path}/usage`, key, { externalUserId: "bob", requestId: "r3", units: 10 })).status, 201);

    // Current month: account used 30, alice 20 used / 30 remaining, bob 10 / 40.
    const usage = (await api("GET", `${path}/usage`, key)).body;
    assert.equal(usage.account.used, 30);
    const alice = usage.users.find((u) => u.externalUserId === "alice");
    const bob = usage.users.find((u) => u.externalUserId === "bob");
    assert.deepEqual([alice.used, alice.remaining], [20, 30]);
    assert.deepEqual([bob.used, bob.remaining], [10, 40]);

    // One user.
    const single = await api("GET", `${path}/users/alice/usage`, key);
    assert.equal(single.status, 200);
    assert.equal(single.body.users.length, 1);
    assert.equal((await api("GET", `${path}/users/nobody/usage`, key)).status, 404);

    // A previous month is queryable and empty.
    const old = (await api("GET", `${path}/usage?month=2020-01`, key)).body;
    assert.equal(old.period, "2020-01");
    assert.equal(old.account.used, 0);
    assert.equal((await api("GET", `${path}/usage?month=2020-13`, key)).status, 400);

    // History: newest first, includes the rejection, paginates.
    const page1 = (await api("GET", `${path}/requests?limit=2`, key)).body;
    assert.equal(page1.total, 3);
    assert.equal(page1.requests.length, 2);
    assert.equal(page1.requests[0].requestId, "r3");
    const page2 = (await api("GET", `${path}/requests?limit=2&offset=2`, key)).body;
    assert.equal(page2.requests.length, 1);
    assert.equal(page2.requests[0].requestId, "r1");

    const rejected = (await api("GET", `${path}/requests?externalUserId=alice`, key)).body.requests.find((r) => r.requestId === "r2");
    assert.equal(rejected.accepted, false);
    assert.deepEqual(rejected.rejection, { level: "user", rule: "max_units_per_request", limit: 30 });
    assert.equal((await api("GET", `${path}/requests?limit=0`, key)).status, 400);

    // Isolation: wrong key or missing key cannot read this account's data.
    assert.equal((await api("GET", `${path}/usage`, b.apiKey)).status, 401);
    assert.equal((await api("GET", `${path}/requests`, b.apiKey)).status, 401);
    assert.equal((await api("GET", `${path}/requests`)).status, 401);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  }
});
