
const BASE_URL =
  process.env.USAGE_METER_BASE_URL ?? "http://localhost:3000";

async function call(method, path, apiKey, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = {};
  }

  return { status: response.status, body: responseBody };
}

async function waitForApi() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const { status } = await call("GET", "/health");
      if (status === 200) return;
    } catch {
      // The API may not be ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Usage Meter API not reachable at ${BASE_URL}`);
}

function must(result, expectedStatus, what) {
  if (result.status !== expectedStatus) {
    throw new Error(
      `${what} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
    );
  }

  return result.body;
}

async function main() {
  await waitForApi();

  // Create a fresh demo account.
  const created = must(
    await call("POST", "/accounts", null, {
      name: `Demo App ${Date.now()}`,
    }),
    201,
    "Create account",
  );

  const accountId = created.account.id;
  const apiKey = created.apiKey;
  const base = `/accounts/${accountId}`;

  // Create and assign an account plan.
  const accountPlan = must(
    await call("POST", `${base}/plans`, apiKey, {
      name: "Demo Account Plan",
      monthlyLimit: 100,
      maxRequestUnits: 50,
    }),
    201,
    "Create account plan",
  ).plan;

  must(
    await call("PUT", `${base}/plan`, apiKey, {
      planId: accountPlan.id,
    }),
    200,
    "Assign account plan",
  );

  // Create Basic and Premium user plans.
  const basic = must(
    await call("POST", `${base}/user-plans`, apiKey, {
      name: "Demo Basic",
      monthlyLimit: 60,
      maxRequestUnits: 20,
    }),
    201,
    "Create Basic plan",
  ).plan;

  const premium = must(
    await call("POST", `${base}/user-plans`, apiKey, {
      name: "Demo Premium",
      monthlyLimit: 100,
      maxRequestUnits: 50,
    }),
    201,
    "Create Premium plan",
  ).plan;

  // Register two users on different plans.
  for (const [externalUserId, planId] of [
    ["alice", basic.id],
    ["bob", premium.id],
  ]) {
    must(
      await call("POST", `${base}/users`, apiKey, {
        externalUserId,
        planId,
      }),
      201,
      `Create ${externalUserId}`,
    );
  }

  console.log("Account plan: 100 units/month, max 50 per request");
  console.log("alice: Demo Basic - 60 units/month, max 20 per request");
  console.log("bob: Demo Premium - 100 units/month, max 50 per request\n");

  let counter = 0;

  async function processDocument(user, units, label, requestId) {
    const id = requestId ?? `doc-${++counter}`;

    const { status, body } = await call(
      "POST",
      `${base}/usage`,
      apiKey,
      {
        externalUserId: user,
        requestId: id,
        units,
      },
    );

    if (![200, 201, 429].includes(status)) {
      throw new Error(
        `${label} failed: HTTP ${status} ${JSON.stringify(body)}`,
      );
    }

    const outcome = body.accepted
      ? "ACCEPTED"
      : `REJECTED by ${body.rejection.level} ${body.rejection.rule} (limit ${body.rejection.limit})`;

    console.log(label);
    console.log(`  ${user} processes a ${units}-unit document -> ${outcome}`);
    console.log(
      `  remaining: account=${body.remaining.account}, ${user}=${body.remaining.user}` +
        (body.duplicate ? " (duplicate retry, not counted again)" : ""),
    );
    console.log("");
  }

  await processDocument("alice", 10, "1. Accepted action", "doc-alice-1");
  await processDocument(
    "alice",
    10,
    "2. Safe retry (same request ID)",
    "doc-alice-1",
  );
  await processDocument(
    "alice",
    25,
    "3. Rejected by the USER per-request limit",
  );
  await processDocument("bob", 50, "4. Accepted for bob (Demo Premium)");

  await processDocument(
    "bob",
    45,
    "5. Rejected by the shared ACCOUNT limit",
  );

  // Upgrade Alice, then retry the same request from step 3.
  must(
    await call("PUT", `${base}/users/alice/plan`, apiKey, {
      planId: premium.id,
    }),
    200,
    "Switch alice to Premium",
  );

  console.log(">>> alice switched from Demo Basic to Demo Premium\n");

  await processDocument(
    "alice",
    25,
    "6. Same 25-unit request, now accepted (alice on Demo Premium)",
  );

  const summary = must(
    await call("GET", `${base}/usage/summary`, apiKey),
    200,
    "Get account summary",
  ).summary;

  console.log(
    `Account summary: used=${summary.used}, remaining=${summary.remaining}, limit=${summary.monthlyLimit} (${summary.period})`,
  );
}

main().catch((error) => {
  console.error("Demo failed:", error.message);
  process.exitCode = 1;
});