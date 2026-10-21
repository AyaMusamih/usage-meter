import { pool } from "../db.js";

export interface ConsumeUsageInput {
  accountId: string;
  externalUserId: string;
  requestId: string;
  units: number;
}

export interface Rejection {
  level: "account" | "user";
  rule: "max_units_per_request" | "monthly_allowance";
  limit: number;
}

export interface Decision {
  accepted: boolean;
  requestId: string;
  units: number;
  rejection?: Rejection;
  remaining: { account: number; user: number };
  createdAt: Date;
}

export type ConsumeUsageResult =
  | { status: "decided"; duplicate: boolean; decision: Decision }
  | {
      status: "error";
      code: "invalid_input" | "not_found" | "conflict";
      message: string;
    };

export function isValidUsageInput(input: ConsumeUsageInput): boolean {
  return (
    typeof input.externalUserId === "string" &&
    input.externalUserId.trim().length > 0 &&
    typeof input.requestId === "string" &&
    input.requestId.trim().length > 0 &&
    Number.isSafeInteger(input.units) &&
    input.units > 0
  );
}

const LOG_COLUMNS = `request_id, units::text AS units, accepted,
  rejection_level, rejection_rule, rejection_limit::text AS rejection_limit,
  account_remaining::text AS account_remaining,
  user_remaining::text AS user_remaining, created_at`;

function toDecision(row: any): Decision {
  return {
    accepted: row.accepted,
    requestId: row.request_id,
    units: Number(row.units),
    ...(row.accepted
      ? {}
      : {
          rejection: {
            level: row.rejection_level,
            rule: row.rejection_rule,
            limit: Number(row.rejection_limit),
          },
        }),
    remaining: {
      account: Number(row.account_remaining),
      user: Number(row.user_remaining),
    },
    createdAt: row.created_at,
  };
}

function remaining(limit: bigint, used: bigint): number {
  return Number(limit > used ? limit - used : 0n);
}

export async function consumeUsage(
  input: ConsumeUsageInput,
): Promise<ConsumeUsageResult> {
  if (!isValidUsageInput(input)) {
    return {
      status: "error",
      code: "invalid_input",
      message: "Invalid usage input",
    };
  }

  const externalUserId = input.externalUserId.trim();
  const requestId = input.requestId.trim();
  const requested = BigInt(input.units);

  const client = await pool.connect();

  const abort = async (
    code: "not_found" | "conflict",
    message: string,
  ): Promise<ConsumeUsageResult> => {
    await client.query("ROLLBACK");
    return { status: "error", code, message };
  };

  try {
    await client.query("BEGIN");

    // Lock the account row: requests for one account are processed one at a time.
    const accountResult = await client.query(
      `SELECT p.monthly_limit, p.max_request_units
       FROM accounts a
       JOIN account_plan_assignments apa ON apa.account_id = a.id
       JOIN plans p ON p.id = apa.plan_id
       WHERE a.id = $1
       FOR UPDATE OF a`,
      [input.accountId],
    );

    if (accountResult.rowCount === 0) {
      return await abort("not_found", "Account or account plan not found");
    }

    const userResult = await client.query(
      `SELECT u.id, p.monthly_limit, p.max_request_units
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       WHERE u.account_id = $1
         AND u.external_user_id = $2
         AND p.scope = 'user'
         AND p.owner_account_id = u.account_id
       FOR UPDATE OF u`,
      [input.accountId, externalUserId],
    );

    if (userResult.rowCount === 0) {
      return await abort("not_found", "User or user plan not found");
    }

    const account = accountResult.rows[0];
    const user = userResult.rows[0];

    // Retry of a request we already decided: return the stored decision.
    const existing = await client.query(
      `SELECT user_id, ${LOG_COLUMNS}
       FROM request_log
       WHERE account_id = $1 AND request_id = $2`,
      [input.accountId, requestId],
    );

    if (existing.rowCount && existing.rowCount > 0) {
      const row = existing.rows[0];

      if (row.user_id !== user.id || BigInt(row.units) !== requested) {
        return await abort(
          "conflict",
          "Request ID already used with different data",
        );
      }

      await client.query("ROLLBACK");
      return {
        status: "decided",
        duplicate: true,
        decision: toDecision(row),
      };
    }

    // Usage so far this UTC month: account total and this user's total.
    const usageResult = await client.query(
      `SELECT
         COALESCE(SUM(units), 0)::text AS account_used,
         COALESCE(SUM(units) FILTER (WHERE user_id = $2), 0)::text AS user_used
       FROM usage_events
       WHERE account_id = $1
         AND created_at >= (
           date_trunc('month', NOW() AT TIME ZONE 'UTC')
           AT TIME ZONE 'UTC'
         )`,
      [input.accountId, user.id],
    );

    const accountUsed = BigInt(usageResult.rows[0].account_used);
    const userUsed = BigInt(usageResult.rows[0].user_used);
    const accountMonthly = BigInt(account.monthly_limit);
    const userMonthly = BigInt(user.monthly_limit);
    const accountMaxRequest = BigInt(account.max_request_units);
    const userMaxRequest = BigInt(user.max_request_units);

    // Per-request limits first, then monthly allowances; account before user.
    let rejection: Rejection | undefined;

    if (requested > accountMaxRequest) {
      rejection = {
        level: "account",
        rule: "max_units_per_request",
        limit: Number(accountMaxRequest),
      };
    } else if (requested > userMaxRequest) {
      rejection = {
        level: "user",
        rule: "max_units_per_request",
        limit: Number(userMaxRequest),
      };
    } else if (accountUsed + requested > accountMonthly) {
      rejection = {
        level: "account",
        rule: "monthly_allowance",
        limit: Number(accountMonthly),
      };
    } else if (userUsed + requested > userMonthly) {
      rejection = {
        level: "user",
        rule: "monthly_allowance",
        limit: Number(userMonthly),
      };
    }

    const accepted = rejection === undefined;
    const counted = accepted ? requested : 0n;

    const logResult = await client.query(
      `INSERT INTO request_log (
         account_id, user_id, request_id, units, accepted,
         rejection_level, rejection_rule, rejection_limit,
         account_remaining, user_remaining
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${LOG_COLUMNS}`,
      [
        input.accountId,
        user.id,
        requestId,
        input.units,
        accepted,
        rejection?.level ?? null,
        rejection?.rule ?? null,
        rejection?.limit ?? null,
        remaining(accountMonthly, accountUsed + counted),
        remaining(userMonthly, userUsed + counted),
      ],
    );

    if (accepted) {
      await client.query(
        `INSERT INTO usage_events (account_id, user_id, request_id, units)
         VALUES ($1, $2, $3, $4)`,
        [input.accountId, user.id, requestId, input.units],
      );
    }

    await client.query("COMMIT");

    return {
      status: "decided",
      duplicate: false,
      decision: toDecision(logResult.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
