import "dotenv/config";
import express from "express";
import { pool } from "./db.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

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