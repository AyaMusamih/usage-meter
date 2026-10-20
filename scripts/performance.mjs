import { performance } from "node:perf_hooks";

// Always use the separate test database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://usage_app:local_dev_password@127.0.0.1:5433/usage_meter_test";

const { app } = await import("../dist/index.js");
const { pool } = await import("../dist/db.js");

const REQUEST_COUNT = Number(process.env.PERF_REQUESTS ?? 1000);

async function main() {
  if (
    !Number.isSafeInteger(REQUEST_COUNT) ||
    REQUEST_COUNT < 1 ||
    REQUEST_COUNT > 50000
  ) {
    throw new Error("PERF_REQUESTS must be an integer from 1 to 50000.");
  }

  const server = app.listen(0);

  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // Create a fresh test account and obtain its API key.
    let response = await fetch(`${baseUrl}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Performance Test ${Date.now()}` }),
    });

    if (response.status !== 201) {
      throw new Error(`Account creation failed: HTTP ${response.status}`);
    }

    const { account, apiKey } = await response.json();
    const accountUrl = `${baseUrl}/accounts/${account.id}`;
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    };

    // Create a user plan with a high monthly limit.
    response = await fetch(`${accountUrl}/user-plans`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Performance Test Plan",
        monthlyLimit: 1000000,
        maxRequestUnits: 10,
      }),
    });

    if (response.status !== 201) {
      throw new Error(`User plan creation failed: HTTP ${response.status}`);
    }

    const { plan } = await response.json();

    // Create a test user.
    response = await fetch(`${accountUrl}/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        externalUserId: "performance-test-user",
        planId: plan.id,
      }),
    });

    if (response.status !== 201) {
      throw new Error(`User creation failed: HTTP ${response.status}`);
    }

    console.log(`Running ${REQUEST_COUNT} sequential usage requests...`);

    const latencies = [];
    let succeeded = 0;
    let failed = 0;

    const start = performance.now();

    for (let i = 0; i < REQUEST_COUNT; i++) {
      const requestStart = performance.now();

      try {
        const result = await fetch(`${accountUrl}/usage`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            externalUserId: "performance-test-user",
            requestId: `perf-${Date.now()}-${i}`,
            units: 1,
          }),
        });

        await result.arrayBuffer();
        latencies.push(performance.now() - requestStart);

        if (result.status === 201) {
          succeeded++;
        } else {
          failed++;
        }
      } catch {
        latencies.push(performance.now() - requestStart);
        failed++;
      }
    }

    const durationMs = performance.now() - start;
    latencies.sort((a, b) => a - b);

    const averageMs =
      latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

    const p95Index = Math.ceil(latencies.length * 0.95) - 1;
    const p95Ms = latencies[p95Index];

    console.log("\n--- Performance Results ---");
    console.log(`Total requests: ${REQUEST_COUNT}`);
    console.log(`Successful requests: ${succeeded}`);
    console.log(`Failed requests: ${failed}`);
    console.log(`Duration: ${(durationMs / 1000).toFixed(2)} seconds`);
    console.log(
      `Throughput: ${(REQUEST_COUNT / (durationMs / 1000)).toFixed(2)} requests/second`,
    );
    console.log(`Average latency: ${averageMs.toFixed(2)} ms`);
    console.log(`P95 latency: ${p95Ms.toFixed(2)} ms`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Performance test failed:", error.message);
  process.exitCode = 1;
});
