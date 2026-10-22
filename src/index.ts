import "dotenv/config";
import express from "express";
import { pool } from "./db.js";
import { generateApiKey, hashApiKey } from "./utils/apiKey.js";
import { authenticateAccount } from "./middleware/authenticateAccount.js";
import { consumeUsage } from "./services/usageService.js";
import { getAccountUsageSummary } from "./services/usageSummaryService.js";
import { plansRouter } from "./routes/plans.js";
import { usageRouter } from "./routes/usage.js";

const app = express();

app.use(express.json());
app.use("/accounts/:accountId", plansRouter);
app.use("/accounts/:accountId", usageRouter);

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
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO accounts (name, api_key_hash)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [name.trim(), apiKeyHash],
    );

    const account = result.rows[0];

    const plans = [
      {
        scope: "account",
        name: "Starter",
        monthlyLimit: 100000,
        maxRequestUnits: 1000,
      },
      {
        scope: "account",
        name: "Pro",
        monthlyLimit: 200000,
        maxRequestUnits: 2000,
      },
      {
        scope: "user",
        name: "Basic User",
        monthlyLimit: 5000,
        maxRequestUnits: 100,
      },
      {
        scope: "user",
        name: "Premium User",
        monthlyLimit: 20000,
        maxRequestUnits: 500,
      },
    ];

    let starterPlanId = "";

    for (const plan of plans) {
      const planResult = await client.query(
        `INSERT INTO plans
          (owner_account_id, scope, name, monthly_limit, max_request_units, is_predefined)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id`,
        [
          account.id,
          plan.scope,
          plan.name,
          plan.monthlyLimit,
          plan.maxRequestUnits,
        ],
      );

      if (plan.name === "Starter") {
        starterPlanId = planResult.rows[0].id;
      }
    }

    await client.query(
      `INSERT INTO account_plan_assignments (account_id, plan_id)
       VALUES ($1, $2)`,
      [account.id, starterPlanId],
    );

    await client.query("COMMIT");

    res.status(201).json({
      account,
      apiKey,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to create account:", error);

    res.status(500).json({
      error: "Failed to create account",
    });
  } finally {
    client.release();
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

app.post(
  "/accounts/:accountId/usage",
  authenticateAccount,
  async (req, res) => {
    const accountId = req.params.accountId;

    if (typeof accountId !== "string") {
      res.status(400).json({
        error: "Invalid account ID",
      });
      return;
    }
    const { externalUserId, requestId, units } = req.body;

    if (
      typeof externalUserId !== "string" ||
      externalUserId.trim().length === 0 ||
      typeof requestId !== "string" ||
      requestId.trim().length === 0 ||
      !Number.isSafeInteger(units) ||
      units <= 0
    ) {
      res.status(400).json({
        error:
          "External user ID, request ID, and positive integer units are required",
      });
      return;
    }

    try {
      const result = await consumeUsage({
        accountId,
        externalUserId,
        requestId,
        units,
      });

      if (result.status === "error") {
        const status =
          result.code === "not_found"
            ? 404
            : result.code === "conflict"
              ? 409
              : 400;

        res.status(status).json({ error: result.message });
        return;
      }

      const { decision, duplicate } = result;
      const status = decision.accepted ? (duplicate ? 200 : 201) : 429;

      res.status(status).json({ duplicate, ...decision });
    } catch (error) {
      console.error("Failed to record usage:", error);

      res.status(500).json({
        error: "Failed to record usage",
      });
    }
  },
);

app.get(
  "/accounts/:accountId/usage/summary",
  authenticateAccount,
  async (req, res) => {
    const accountId = req.params.accountId;

    if (typeof accountId !== "string") {
      res.status(400).json({
        error: "Invalid account ID",
      });
      return;
    }

    try {
      const summary = await getAccountUsageSummary(accountId);

      if (!summary) {
        res.status(404).json({
          error: "Account plan not found",
        });
        return;
      }

      res.status(200).json({
        summary,
      });
    } catch (error) {
      console.error("Failed to get usage summary:", error);

      res.status(500).json({
        error: "Failed to get usage summary",
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

export { app };
