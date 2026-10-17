import type { RequestHandler } from "express";
import { pool } from "../db.js";
import { hashApiKey } from "../utils/apiKey.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const authenticateAccount: RequestHandler = async (
  req,
  res,
  next,
) => {
  const accountId = req.params.accountId;
  if (typeof accountId !== "string") {
  res.status(400).json({
    error: "Invalid account ID",
  });
  return;
}
  const apiKey = req.header("x-api-key");

  if (!UUID_PATTERN.test(accountId)) {
    res.status(400).json({
      error: "Invalid account ID",
    });
    return;
  }

  if (!apiKey) {
    res.status(401).json({
      error: "API key is required",
    });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id
       FROM accounts
       WHERE id = $1 AND api_key_hash = $2`,
      [accountId, hashApiKey(apiKey)],
    );

    if (result.rowCount === 0) {
      res.status(401).json({
        error: "Invalid API key for this account",
      });
      return;
    }

    next();
  } catch (error) {
    console.error("Account authentication failed:", error);

    res.status(500).json({
      error: "Authentication failed",
    });
  }
};
