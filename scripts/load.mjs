const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const TOTAL = Number(process.env.LOAD_REQUESTS ?? 5000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const ACCOUNTS = Number(process.env.LOAD_ACCOUNTS ?? 1);
const USERS = Number(process.env.LOAD_USERS ?? 10);
const RUN_ID = Date.now();

async function call(method, path, apiKey, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function must(result, status, what) {
  if (result.status !== status) {
    throw new Error(`${what} failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function setupAccount(index) {
  const created = must(
    await call("POST", "/accounts", null, { name: `Load ${RUN_ID}-${index}` }),
    201,
    "create account",
  );
  const path = `/accounts/${created.account.id}`;
  const key = created.apiKey;

  const accountPlan = must(
    await call("POST", `${path}/plans`, key, {
      name: "Load Account",
      monthlyLimit: 1_000_000_000,
      maxRequestUnits: 10,
    }),
    201,
    "account plan",
  ).plan;
  must(await call("PUT", `${path}/plan`, key, { planId: accountPlan.id }), 200, "assign plan");

  const userPlan = must(
    await call("POST", `${path}/user-plans`, key, {
      name: "Load User",
      monthlyLimit: 1_000_000_000,
      maxRequestUnits: 10,
    }),
    201,
    "user plan",
  ).plan;
  for (let u = 0; u < USERS; u++) {
    must(
      await call("POST", `${path}/users`, key, { externalUserId: `user-${u}`, planId: userPlan.id }),
      201,
      "create user",
    );
  }
  return { path, key, accepted: 0 };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function stats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1);
  return {
    avg,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const fmt = (ms) => ms.toFixed(1);

async function main() {
  console.log(
    `Load test: ${TOTAL} requests, concurrency ${CONCURRENCY}, ${ACCOUNTS} account(s), ${USERS} users each\n`,
  );

  const accounts = await Promise.all(Array.from({ length: ACCOUNTS }, (_, i) => setupAccount(i)));

  const latencies = new Array(TOTAL);
  let next = 0;
  let errors = 0;
  const statusCounts = {};

  async function worker() {
    while (true) {
      const n = next++;
      if (n >= TOTAL) return;
      const account = accounts[n % ACCOUNTS];
      const started = performance.now();
      try {
        const { status, body } = await call("POST", `${account.path}/usage`, account.key, {
          externalUserId: `user-${n % USERS}`,
          requestId: `load-${RUN_ID}-${n}`,
          units: 1,
        });
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
        if (body.accepted) account.accepted++;
        else errors++;
      } catch {
        errors++;
      }
      latencies[n] = performance.now() - started;
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (performance.now() - started) / 1000;

  const overall = stats(latencies);
  const quarter = Math.floor(TOTAL / 4);
  const first = stats(latencies.slice(0, quarter));
  const last = stats(latencies.slice(TOTAL - quarter));

  console.log("| Metric | Value |");
  console.log("|---|---|");
  console.log(`| Total time | ${seconds.toFixed(2)} s |`);
  console.log(`| Throughput | ${(TOTAL / seconds).toFixed(0)} requests/s |`);
  console.log(`| Latency avg / p50 | ${fmt(overall.avg)} / ${fmt(overall.p50)} ms |`);
  console.log(`| Latency p95 / p99 / max | ${fmt(overall.p95)} / ${fmt(overall.p99)} / ${fmt(overall.max)} ms |`);
  console.log(`| p95 first quarter -> last quarter | ${fmt(first.p95)} -> ${fmt(last.p95)} ms |`);
  console.log(`| HTTP statuses | ${JSON.stringify(statusCounts)} |`);
  console.log(`| Failed / unexpectedly rejected | ${errors} |`);

  // Correctness: stored totals must equal what was accepted.
  let correct = true;
  for (const account of accounts) {
    const usage = must(await call("GET", `${account.path}/usage`, account.key), 200, "usage");
    const userTotal = usage.users.reduce((sum, u) => sum + u.used, 0);
    if (usage.account.used !== account.accepted || userTotal !== account.accepted) correct = false;
  }
  console.log(`\nTotals check (account used = user sum = accepted): ${correct ? "PASS" : "FAIL"}`);
  if (!correct || errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Load test failed:", error.message);
  process.exitCode = 1;
});
