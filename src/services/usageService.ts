
import { pool } from "../db.js";

export interface ConsumeUsageInput {
  accountId: string;
  externalUserId: string;
  requestId: string;
  units: number;
}

export interface ConsumeUsageResult {
  status: "recorded" | "duplicate" | "rejected";
  reason?: string;
  usage?: {
    requestId: string;
    units: string;
    createdAt: Date;
  };
}

export async function consumeUsage(
  input: ConsumeUsageInput,
): Promise<ConsumeUsageResult> {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    if (
      typeof input.externalUserId !== "string" ||
      input.externalUserId.trim().length === 0 ||
      typeof input.requestId !== "string" ||
      input.requestId.trim().length === 0 ||
      !Number.isSafeInteger(input.units) ||
      input.units <= 0
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return { status: "rejected", reason: "Invalid usage input" };
    }

    // Lock the account to serialize usage requests for this account.
    const accountResult = await client.query(
      `SELECT a.id, p.monthly_limit, p.max_request_units
       FROM accounts a
       JOIN account_plan_assignments apa ON apa.account_id = a.id
       JOIN plans p ON p.id = apa.plan_id
       WHERE a.id = $1
       FOR UPDATE OF a`,
      [input.accountId],
    );

    if (accountResult.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return {
        status: "rejected",
        reason: "Account or account plan not found",
      };
    }

    // Find the user and their plan within this account.
    const userResult = await client.query(
      `SELECT u.id, p.monthly_limit, p.max_request_units
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       WHERE u.account_id = $1
         AND u.external_user_id = $2
         AND p.scope = 'user'
         AND p.owner_account_id = u.account_id
       FOR UPDATE OF u`,
      [input.accountId, input.externalUserId.trim()],
    );

    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return { status: "rejected", reason: "User or user plan not found" };
    }

    const account = accountResult.rows[0];
    const user = userResult.rows[0];
    const requestedUnits = BigInt(input.units);

    // Check whether this request was already recorded.
    const existingResult = await client.query(
      `SELECT user_id, request_id, units::text AS units, created_at
       FROM usage_events
       WHERE account_id = $1 AND request_id = $2`,
      [input.accountId, input.requestId.trim()],
    );

    if (existingResult.rowCount && existingResult.rowCount > 0) {
      const existing = existingResult.rows[0];

      await client.query("ROLLBACK");
      transactionStarted = false;

      if (
        existing.user_id === user.id &&
        BigInt(existing.units) === requestedUnits
      ) {
        return {
          status: "duplicate",
          usage: {
            requestId: existing.request_id,
            units: existing.units,
            createdAt: existing.created_at,
          },
        };
      }

      return {
        status: "rejected",
        reason: "Request ID already used with different data",
      };
    }

    const accountRequestLimit = BigInt(account.max_request_units);
    const userRequestLimit = BigInt(user.max_request_units);

    if (
      requestedUnits > accountRequestLimit ||
      requestedUnits > userRequestLimit
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return { status: "rejected", reason: "Request limit exceeded" };
    }

    // Calculate usage since the start of the current UTC month.
    const accountUsageResult = await client.query(
      `SELECT COALESCE(SUM(units), 0)::text AS used
       FROM usage_events
       WHERE account_id = $1
         AND created_at >= (
           date_trunc('month', NOW() AT TIME ZONE 'UTC')
           AT TIME ZONE 'UTC'
         )`,
      [input.accountId],
    );

    const userUsageResult = await client.query(
      `SELECT COALESCE(SUM(units), 0)::text AS used
       FROM usage_events
       WHERE account_id = $1
         AND user_id = $2
         AND created_at >= (
           date_trunc('month', NOW() AT TIME ZONE 'UTC')
           AT TIME ZONE 'UTC'
         )`,
      [input.accountId, user.id],
    );

    const accountUsed = BigInt(accountUsageResult.rows[0].used);
    const userUsed = BigInt(userUsageResult.rows[0].used);
    const accountMonthlyLimit = BigInt(account.monthly_limit);
    const userMonthlyLimit = BigInt(user.monthly_limit);

    if (accountUsed + requestedUnits > accountMonthlyLimit) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return {
        status: "rejected",
        reason: "Account monthly limit exceeded",
      };
    }

    if (userUsed + requestedUnits > userMonthlyLimit) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return {
        status: "rejected",
        reason: "User monthly limit exceeded",
      };
    }

    // Record usage only after all checks pass.
    const insertResult = await client.query(
      `INSERT INTO usage_events (
         account_id, user_id, request_id, units
       )
       VALUES ($1, $2, $3, $4)
       RETURNING request_id, units::text AS units, created_at`,
      [
        input.accountId,
        user.id,
        input.requestId.trim(),
        input.units,
      ],
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      status: "recorded",
      usage: insertResult.rows[0],
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}
