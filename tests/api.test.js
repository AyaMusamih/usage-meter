import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../dist/index.js";

test("invalid account ID returns 400", async () => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/accounts/invalid-id/usage/summary`,
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid account ID",
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("missing API key returns 401", async () => {
  const server = app.listen(0);

  try {
    const address = server.address();

    const response = await fetch(
      `http://127.0.0.1:${address.port}/accounts/c47ba110-9e84-4055-a821-eccb85f74838/usage/summary`,
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "API key is required",
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});