import "dotenv/config";
import express from "express";
import { pool } from "./db.js";
import { generateApiKey, hashApiKey } from "./utils/apiKey.js";
import { authenticateAccount } from "./middleware/authenticateAccount.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.post("/accounts", async (req, res) => {
  const { name } = req.body;

  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({
      error: "Account name is required",
    });
    return;
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  try {
    const result = await pool.query(
      `INSERT INTO accounts (name, api_key_hash)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [name.trim(), apiKeyHash],
    );

    res.status(201).json({
      account: result.rows[0],
      apiKey,
    });
  } catch (error) {
    console.error("Failed to create account:", error);

    res.status(500).json({
      error: "Failed to create account",
    });
  }
});

app.post(
  "/accounts/:accountId/plans",
  authenticateAccount,
  async (req, res) => {
    const { accountId } = req.params;
    const { name, monthlyLimit, maxRequestUnits } = req.body;

    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      !Number.isSafeInteger(monthlyLimit) ||
      monthlyLimit < 0 ||
      !Number.isSafeInteger(maxRequestUnits) ||
      maxRequestUnits <= 0
    ) {
      res.status(400).json({
        error: "Invalid plan name or limits",
      });
      return;
    }

    try {
      const accountResult = await pool.query(
        "SELECT id FROM accounts WHERE id = $1",
        [accountId],
      );

      if (accountResult.rowCount === 0) {
        res.status(404).json({
          error: "Account not found",
        });
        return;
      }

      const planResult = await pool.query(
        `INSERT INTO plans (
           owner_account_id,
           scope,
           name,
           monthly_limit,
           max_request_units
         )
         VALUES ($1, 'account', $2, $3, $4)
         RETURNING id, owner_account_id, scope, name,
                   monthly_limit, max_request_units, created_at`,
        [accountId, name.trim(), monthlyLimit, maxRequestUnits],
      );

      const plan = planResult.rows[0];

      await pool.query(
        `INSERT INTO account_plan_assignments (account_id, plan_id)
         VALUES ($1, $2)
         ON CONFLICT (account_id)
         DO UPDATE SET plan_id = EXCLUDED.plan_id`,
        [accountId, plan.id],
      );

      res.status(201).json({ plan });
    } catch (error) {
      console.error("Failed to create account plan:", error);

      res.status(500).json({
        error: "Failed to create account plan",
      });
    }
  },
);


app.post(
  "/accounts/:accountId/user-plans",
  authenticateAccount,
  async (req, res) => {
    const { accountId } = req.params;
    const { name, monthlyLimit, maxRequestUnits } = req.body;

    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      !Number.isSafeInteger(monthlyLimit) ||
      monthlyLimit < 0 ||
      !Number.isSafeInteger(maxRequestUnits) ||
      maxRequestUnits <= 0
    ) {
      res.status(400).json({
        error: "Invalid plan name or limits",
      });
      return;
    }

    try {
      const result = await pool.query(
        `INSERT INTO plans (
           owner_account_id,
           scope,
           name,
           monthly_limit,
           max_request_units
         )
         VALUES ($1, 'user', $2, $3, $4)
         RETURNING id, owner_account_id, scope, name,
                   monthly_limit, max_request_units, created_at`,
        [accountId, name.trim(), monthlyLimit, maxRequestUnits],
      );

      res.status(201).json({
        plan: result.rows[0],
      });
    } catch (error) {
      console.error("Failed to create user plan:", error);

      res.status(500).json({
        error: "Failed to create user plan",
      });
    }
  },
);


app.post(
  "/accounts/:accountId/users",
  authenticateAccount,
  async (req, res) => {
    const { accountId } = req.params;
    const { externalUserId, planId } = req.body;

    if (
      typeof externalUserId !== "string" ||
      externalUserId.trim().length === 0 ||
      typeof planId !== "string" ||
      planId.trim().length === 0
    ) {
      res.status(400).json({
        error: "External user ID and plan ID are required",
      });
      return;
    }

    try {
      const planResult = await pool.query(
        `SELECT id
         FROM plans
         WHERE id = $1
           AND owner_account_id = $2
           AND scope = 'user'`,
        [planId, accountId],
      );

      if (planResult.rowCount === 0) {
        res.status(400).json({
          error: "Invalid user plan for this account",
        });
        return;
      }

      const userResult = await pool.query(
        `INSERT INTO users (account_id, external_user_id, plan_id)
         VALUES ($1, $2, $3)
         RETURNING id, account_id, external_user_id, plan_id, created_at`,
        [accountId, externalUserId.trim(), planId],
      );

      res.status(201).json({
        user: userResult.rows[0],
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        res.status(409).json({
          error: "User already exists in this account",
        });
        return;
      }

      console.error("Failed to create user:", error);

      res.status(500).json({
        error: "Failed to create user",
      });
    }
  },
);


app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("Database connection failed:", error);

    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

app.listen(port, () => {
  console.log(`Usage Meter API listening on port ${port}`);
});