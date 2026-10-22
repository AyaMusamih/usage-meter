import { Router } from "express";
import type { Request, Response } from "express";

import { pool } from "../db.js";
import { authenticateAccount } from "../middleware/authenticateAccount.js";

export const usageRouter = Router({ mergeParams: true });

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// "2026-10" -> [2026-10-01T00:00Z, 2026-11-01T00:00Z).
// Defaults to the current UTC month.
function monthRange(month?: string) {
  const now = new Date();
  let year = now.getUTCFullYear();
  let monthIndex = now.getUTCMonth();

  if (month !== undefined) {
    const match = MONTH_PATTERN.exec(month);
    if (!match) return null;
    year = Number(match[1]);
    monthIndex = Number(match[2]) - 1;
  }

  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));

  return { period: start.toISOString().slice(0, 7), start, end };
}

function remaining(limit: bigint, used: bigint): number {
  return Number(limit > used ? limit - used : 0n);
}

function serverError(res: Response, message: string, error: unknown) {
  console.error(`${message}:`, error);
  res.status(500).json({ error: message });
}

// Remaining is measured against the plans applied right now.
async function loadUsage(
  accountId: string,
  month: string | undefined,
  externalUserId?: string,
) {
  const range = monthRange(month);
  if (!range) return { error: "invalid_month" as const };

  const accountResult = await pool.query(
    `SELECT p.id, p.name, p.monthly_limit::text AS monthly_limit,
            p.max_request_units::text AS max_request_units,
            (SELECT COALESCE(SUM(units), 0)::text FROM usage_events
              WHERE account_id = $1 AND created_at >= $2 AND created_at < $3
            ) AS used
     FROM account_plan_assignments apa
     JOIN plans p ON p.id = apa.plan_id
     WHERE apa.account_id = $1`,
    [accountId, range.start, range.end],
  );

  if (accountResult.rowCount === 0) {
    return { error: "not_found" as const };
  }

  const userResult = await pool.query(
    `SELECT u.external_user_id, p.id AS plan_id, p.name AS plan_name,
            p.monthly_limit::text AS monthly_limit,
            p.max_request_units::text AS max_request_units,
            COALESCE(SUM(e.units), 0)::text AS used
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     LEFT JOIN usage_events e
       ON e.account_id = u.account_id AND e.user_id = u.id
      AND e.created_at >= $2 AND e.created_at < $3
     WHERE u.account_id = $1
       AND ($4::text IS NULL OR u.external_user_id = $4)
     GROUP BY u.id, p.id
     ORDER BY u.created_at`,
    [accountId, range.start, range.end, externalUserId ?? null],
  );

  if (externalUserId !== undefined && userResult.rowCount === 0) {
    return { error: "user_not_found" as const };
  }

  const account = accountResult.rows[0];
  const accountLimit = BigInt(account.monthly_limit);
  const accountUsed = BigInt(account.used);

  return {
    data: {
      period: range.period,
      account: {
        plan: {
          id: account.id,
          name: account.name,
          monthlyLimit: Number(account.monthly_limit),
          maxRequestUnits: Number(account.max_request_units),
        },
        used: Number(accountUsed),
        remaining: remaining(accountLimit, accountUsed),
      },
      users: userResult.rows.map((row) => ({
        externalUserId: row.external_user_id,
        plan: {
          id: row.plan_id,
          name: row.plan_name,
          monthlyLimit: Number(row.monthly_limit),
          maxRequestUnits: Number(row.max_request_units),
        },
        used: Number(row.used),
        remaining: remaining(BigInt(row.monthly_limit), BigInt(row.used)),
      })),
    },
  };
}

function sendUsage(
  res: Response,
  result: Awaited<ReturnType<typeof loadUsage>>,
) {
  if ("data" in result) {
    res.json(result.data);
  } else if (result.error === "invalid_month") {
    res.status(400).json({ error: "month must look like 2026-10" });
  } else if (result.error === "user_not_found") {
    res.status(404).json({ error: "User not found" });
  } else {
    res.status(404).json({ error: "Account plan not found" });
  }
}

// Account and all users: consumed and remaining.
usageRouter.get("/usage", authenticateAccount, async (req, res) => {
  try {
    sendUsage(
      res,
      await loadUsage(param(req, "accountId"), queryString(req, "month")),
    );
  } catch (error) {
    serverError(res, "Failed to get usage", error);
  }
});

// Same data, limited to one user (account totals are still included).
usageRouter.get(
  "/users/:externalUserId/usage",
  authenticateAccount,
  async (req, res) => {
    try {
      sendUsage(
        res,
        await loadUsage(
          param(req, "accountId"),
          queryString(req, "month"),
          param(req, "externalUserId").trim(),
        ),
      );
    } catch (error) {
      serverError(res, "Failed to get user usage", error);
    }
  },
);

// Request history (accepted and rejected), newest first.
usageRouter.get("/requests", authenticateAccount, async (req, res) => {
  const limitText = queryString(req, "limit");
  const offsetText = queryString(req, "offset");
  const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);
  const offset = offsetText === undefined ? 0 : Number(offsetText);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    res.status(400).json({
      error: `limit must be 1-${MAX_LIMIT} and offset must be 0 or more`,
    });
    return;
  }

  const monthText = queryString(req, "month");
  const range = monthText === undefined ? null : monthRange(monthText);

  if (monthText !== undefined && !range) {
    res.status(400).json({ error: "month must look like 2026-10" });
    return;
  }

  const filters = [
    range?.start ?? null,
    range?.end ?? null,
    queryString(req, "externalUserId") ?? null,
  ];

  const where = `r.account_id = $1
    AND ($2::timestamptz IS NULL OR r.created_at >= $2)
    AND ($3::timestamptz IS NULL OR r.created_at < $3)
    AND ($4::text IS NULL OR u.external_user_id = $4)`;

  const accountId = param(req, "accountId");

  try {
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT r.request_id, u.external_user_id, r.units::text AS units,
                r.accepted, r.rejection_level, r.rejection_rule,
                r.rejection_limit::text AS rejection_limit,
                r.account_remaining::text AS account_remaining,
                r.user_remaining::text AS user_remaining, r.created_at
         FROM request_log r
         JOIN users u ON u.account_id = r.account_id AND u.id = r.user_id
         WHERE ${where}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT $5 OFFSET $6`,
        [accountId, ...filters, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM request_log r
         JOIN users u ON u.account_id = r.account_id AND u.id = r.user_id
         WHERE ${where}`,
        [accountId, ...filters],
      ),
    ]);

    res.json({
      total: count.rows[0].total,
      limit,
      offset,
      requests: rows.rows.map((row) => ({
        requestId: row.request_id,
        externalUserId: row.external_user_id,
        units: Number(row.units),
        accepted: row.accepted,
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
      })),
    });
  } catch (error) {
    serverError(res, "Failed to get request history", error);
  }
});