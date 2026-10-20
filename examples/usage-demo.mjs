const BASE_URL = process.env.USAGE_METER_BASE_URL ?? "http://172.18.64.1:3000";
const ACCOUNT_ID = process.env.USAGE_METER_ACCOUNT_ID;
const USER_ID = "student-001";

async function main() {
  const apiKey = process.env.USAGE_METER_API_KEY;

  if (!apiKey || !ACCOUNT_ID) {
    console.error(
      "Please set both USAGE_METER_API_KEY and USAGE_METER_ACCOUNT_ID.",
    );
    process.exitCode = 1;
    return;
  }

  const requestId = `demo-${Date.now()}`;

  async function recordUsage(id, units) {
    const response = await fetch(`${BASE_URL}/accounts/${ACCOUNT_ID}/usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        externalUserId: USER_ID,
        requestId: id,
        units,
      }),
    });

    const body = await response.json();

    console.log(`Request ID: ${id}`);
    console.log(`Units: ${units}`);
    console.log(`HTTP status: ${response.status}`);
    console.log("Response:", body);
    console.log("---");

    return response.status;
  }

  console.log("1. Recording a valid usage request");
  await recordUsage(requestId, 30);

  console.log("2. Repeating the same request to test idempotency");
  await recordUsage(requestId, 30);

  console.log("3. Sending a request above the user's per-request limit");
  await recordUsage(`${requestId}-over-limit`, 150);
}

main().catch((error) => {
  console.error("Demo failed:", error.message);
  process.exitCode = 1;
});
