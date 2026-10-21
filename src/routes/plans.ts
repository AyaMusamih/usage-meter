import { Router } from "express";
import type { Request, Response } from "express";
import { pool } from "../db.js";
import { authenticateAccount } from "../middleware/authenticateAccount.js";

export const plansRouter = Router({ mergeParams: true });

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PLAN_COLUMNS =
  "id, scope, name, monthly_limit, max_request_units, is_predefined";

function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

function toPlan(row: any) {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    monthlyLimit: Number(row.monthly_limit),
    maxRequestUnits: Number(row.max_request_units),
    isPredefined: row.is_predefined,
  };
}

function serverError(res: Response, message: string, error: unknown) {
  console.error(`${message}:`, error);
  res.status(500).json({ error: message });
}

// List all plans owned by the account.
plansRouter.get("/plans", authenticateAccount, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${PLAN_COLUMNS} FROM plans
       WHERE owner_account_id = $1
       ORDER BY scope, created_at`,
      [param(req, "accountId")],
    );
    res.json({ plans: result.rows.map(toPlan) });
  } catch (error) {
    serverError(res, "Failed to list plans", error);
  }
});

// View one plan.
plansRouter.get("/plans/:planId", authenticateAccount, async (req, res) => {
  const planId = param(req, "planId");

  if (!UUID_PATTERN.test(planId)) {
    res.status(400).json({ error: "Invalid plan ID" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT ${PLAN_COLUMNS} FROM plans
       WHERE id = $1 AND owner_account_id = $2`,
      [planId, param(req, "accountId")],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    res.json({ plan: toPlan(result.rows[0]) });
  } catch (error) {
    serverError(res, "Failed to get plan", error);
  }
});

// Update a custom plan. Predefined plans are read-only.
plansRouter.patch("/plans/:planId", authenticateAccount, async (req, res) => {
  const accountId = param(req, "accountId");
  const planId = param(req, "planId");
  const { name, monthlyLimit, maxRequestUnits } = req.body ?? {};

  if (!UUID_PATTERN.test(planId)) {
    res.status(400).json({ error: "Invalid plan ID" });
    return;
  }

  if (
    name === undefined &&
    monthlyLimit === undefined &&
    maxRequestUnits === undefined
  ) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  if (
    (name !== undefined &&
      (typeof name !== "string" || name.trim().length === 0)) ||
    (monthlyLimit !== undefined &&
      !(Number.isSafeInteger(monthlyLimit) && monthlyLimit >= 0)) ||
    (maxRequestUnits !== undefined &&
      !(Number.isSafeInteger(maxRequestUnits) && maxRequestUnits > 0))
  ) {
    res.status(400).json({ error: "Invalid plan name or limits" });
    return;
  }

  try {
    const existing = await pool.query(
      `SELECT is_predefined FROM plans
       WHERE id = $1 AND owner_account_id = $2`,
      [planId, accountId],
    );

    if (existing.rowCount === 0) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    if (existing.rows[0].is_predefined) {
      res.status(403).json({ error: "Predefined plans are read-only" });
      return;
    }

    const result = await pool.query(
      `UPDATE plans
       SET name = COALESCE($3, name),
           monthly_limit = COALESCE($4, monthly_limit),
           max_request_units = COALESCE($5, max_request_units)
       WHERE id = $1 AND owner_account_id = $2
       RETURNING ${PLAN_COLUMNS}`,
      [
        planId,
        accountId,
        name?.trim() ?? null,
        monthlyLimit ?? null,
        maxRequestUnits ?? null,
      ],
    );

    res.json({ plan: toPlan(result.rows[0]) });
  } catch (error) {
    serverError(res, "Failed to update plan", error);
  }
});

// View the account's current plan.
plansRouter.get("/plan", authenticateAccount, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${PLAN_COLUMNS}
       FROM account_plan_assignments apa
       JOIN plans p ON p.id = apa.plan_id
       WHERE apa.account_id = $1`,
      [param(req, "accountId")],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Account plan not found" });
      return;
    }

    res.json({ plan: toPlan(result.rows[0]) });
  } catch (error) {
    serverError(res, "Failed to get account plan", error);
  }
});

// Switch the account to another account-scope plan.
plansRouter.put("/plan", authenticateAccount, async (req, res) => {
  const accountId = param(req, "accountId");
  const { planId } = req.body ?? {};

  if (typeof planId !== "string" || !UUID_PATTERN.test(planId)) {
    res.status(400).json({ error: "A valid planId is required" });
    return;
  }

  try {
    const planResult = await pool.query(
      `SELECT ${PLAN_COLUMNS} FROM plans
       WHERE id = $1 AND owner_account_id = $2 AND scope = 'account'`,
      [planId, accountId],
    );

    if (planResult.rowCount === 0) {
      res.status(404).json({ error: "Account plan not found" });
      return;
    }

    await pool.query(
      `INSERT INTO account_plan_assignments (account_id, plan_id)
       VALUES ($1, $2)
       ON CONFLICT (account_id)
       DO UPDATE SET plan_id = EXCLUDED.plan_id`,
      [accountId, planId],
    );

    res.json({ plan: toPlan(planResult.rows[0]) });
  } catch (error) {
    serverError(res, "Failed to assign account plan", error);
  }
});

// List users with the plan applied to each.
plansRouter.get("/users", authenticateAccount, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.external_user_id, p.id AS plan_id, p.name AS plan_name,
              p.monthly_limit, p.max_request_units
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       WHERE u.account_id = $1
       ORDER BY u.created_at`,
      [param(req, "accountId")],
    );

    res.json({
      users: result.rows.map((row) => ({
        externalUserId: row.external_user_id,
        plan: {
          id: row.plan_id,
          name: row.plan_name,
          monthlyLimit: Number(row.monthly_limit),
          maxRequestUnits: Number(row.max_request_units),
        },
      })),
    });
  } catch (error) {
    serverError(res, "Failed to list users", error);
  }
});

// Switch a user to another user-scope plan.
plansRouter.put(
  "/users/:externalUserId/plan",
  authenticateAccount,
  async (req, res) => {
    const accountId = param(req, "accountId");
    const externalUserId = param(req, "externalUserId").trim();
    const { planId } = req.body ?? {};

    if (typeof planId !== "string" || !UUID_PATTERN.test(planId)) {
      res.status(400).json({ error: "A valid planId is required" });
      return;
    }

    try {
      const planResult = await pool.query(
        `SELECT ${PLAN_COLUMNS} FROM plans
         WHERE id = $1 AND owner_account_id = $2 AND scope = 'user'`,
        [planId, accountId],
      );

      if (planResult.rowCount === 0) {
        res.status(404).json({ error: "User plan not found" });
        return;
      }

      const userResult = await pool.query(
        `UPDATE users SET plan_id = $3
         WHERE account_id = $1 AND external_user_id = $2
         RETURNING external_user_id`,
        [accountId, externalUserId, planId],
      );

      if (userResult.rowCount === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json({
        externalUserId: userResult.rows[0].external_user_id,
        plan: toPlan(planResult.rows[0]),
      });
    } catch (error) {
      serverError(res, "Failed to assign user plan", error);
    }
  },
);