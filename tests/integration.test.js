
import { test } from "node:test";
import assert from "node:assert/strict";

// Use a separate database for integration tests.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://usage_app:local_dev_password@127.0.0.1:5433/usage_meter_test";

const { app } = await import("../dist/index.js");
const { pool } = await import("../dist/db.js");

test("usage is recorded once and monthly limits are enforced", async () => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Create a test account.
    const accountResponse = await fetch(`${baseUrl}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Integration Test ${Date.now()}` }),
    });

    assert.equal(accountResponse.status, 201);

    const { account, apiKey } = await accountResponse.json();
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    };
    const accountPath = `${baseUrl}/accounts/${account.id}`;

    // 2. Create a user plan with a monthly limit of 40 units.
    const planResponse = await fetch(`${accountPath}/user-plans`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Integration Test Plan",
        monthlyLimit: 40,
        maxRequestUnits: 30,
      }),
    });

    assert.equal(planResponse.status, 201);
    const { plan } = await planResponse.json();

    // 3. Create a user on that plan.
    const userResponse = await fetch(`${accountPath}/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        externalUserId: "integration-user",
        planId: plan.id,
      }),
    });

    assert.equal(userResponse.status, 201);

    // 4. Record 20 units.
    const usagePayload = {
      externalUserId: "integration-user",
      requestId: "integration-request-1",
      units: 20,
    };

    const firstResponse = await fetch(`${accountPath}/usage`, {
      method: "POST",
      headers,
      body: JSON.stringify(usagePayload),
    });

    assert.equal(firstResponse.status, 201);

    // 5. Repeat the exact request: it must not count twice.
    const duplicateResponse = await fetch(`${accountPath}/usage`, {
      method: "POST",
      headers,
      body: JSON.stringify(usagePayload),
    });

    assert.equal(duplicateResponse.status, 200);
    assert.equal((await duplicateResponse.json()).duplicate, true);

    // 6. Another 21 units would exceed the monthly limit (40).
    const overLimitResponse = await fetch(`${accountPath}/usage`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        externalUserId: "integration-user",
        requestId: "integration-request-2",
        units: 21,
      }),
    });

    assert.equal(overLimitResponse.status, 429);

    // 7. Confirm only the original 20 units were counted.
    const summaryResponse = await fetch(
      `${accountPath}/usage/summary`,
      { headers },
    );

    assert.equal(summaryResponse.status, 200);
    const { summary } = await summaryResponse.json();
    assert.equal(Number(summary.used), 20);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("accounts cannot access each other's plans", async () => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function createAccount(name) {
      const response = await fetch(`${baseUrl}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      assert.equal(response.status, 201);
      return response.json();
    }

    const first = await createAccount(`Account A ${Date.now()}`);
    const second = await createAccount(`Account B ${Date.now()}`);

    const firstPath = `${baseUrl}/accounts/${first.account.id}`;
    const secondPath = `${baseUrl}/accounts/${second.account.id}`;

    const firstHeaders = { "x-api-key": first.apiKey };
    const secondHeaders = { "x-api-key": second.apiKey };

    // Account B requests its own plans.
    const ownPlansResponse = await fetch(`${secondPath}/plans`, {
      headers: secondHeaders,
    });

    assert.equal(ownPlansResponse.status, 200);

    const { plans } = await ownPlansResponse.json();
    assert.ok(plans.length > 0);

    // Account A cannot view a plan owned by Account B.
    const planId = plans[0].id;

    const crossAccountResponse = await fetch(
      `${firstPath}/plans/${planId}`,
      { headers: firstHeaders },
    );

    assert.equal(crossAccountResponse.status, 404);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

// Close the PostgreSQL pool after the test finishes.
test("close integration test database connection", async () => {
  await pool.end();
});