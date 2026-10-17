import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): string {
  return `um_${randomBytes(32).toString("hex")}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}
