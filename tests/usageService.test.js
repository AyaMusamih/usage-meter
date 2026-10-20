import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidUsageInput } from "../dist/services/usageService.js";

test("valid usage input is accepted", () => {
  assert.equal(
    isValidUsageInput({
      accountId: "account-1",
      externalUserId: "student-001",
      requestId: "request-001",
      units: 30,
    }),
    true,
  );
});

test("zero units are rejected", () => {
  assert.equal(
    isValidUsageInput({
      accountId: "account-1",
      externalUserId: "student-001",
      requestId: "request-002",
      units: 0,
    }),
    false,
  );
});

test("negative units are rejected", () => {
  assert.equal(
    isValidUsageInput({
      accountId: "account-1",
      externalUserId: "student-001",
      requestId: "request-003",
      units: -5,
    }),
    false,
  );
});

test("decimal units are rejected", () => {
  assert.equal(
    isValidUsageInput({
      accountId: "account-1",
      externalUserId: "student-001",
      requestId: "request-004",
      units: 1.5,
    }),
    false,
  );
});

test("empty user ID and request ID are rejected", () => {
  assert.equal(
    isValidUsageInput({
      accountId: "account-1",
      externalUserId: "   ",
      requestId: "request-005",
      units: 10,
    }),
    false,
  );

  assert.equal(
    isValidUsageInput({
      accountId: "account-1",
      externalUserId: "student-001",
      requestId: "   ",
      units: 10,
    }),
    false,
  );
});
