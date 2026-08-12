import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { hashApiKey } from "../lib/crypto";

// Shared-secret auth for the internal tenant-management API (/admin/*),
// separate from tenant-scoped API keys. Compares SHA-256 digests rather
// than the raw strings so a failed match doesn't leak timing information
// about ADMIN_SECRET itself. Good enough for an internal control-plane
// route; the Day 11 admin dashboard will sit behind Cloudflare Access
// instead of this shared secret.
export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;

  if (!token) {
    return c.json({ error: "Missing admin token" }, 401);
  }

  const [providedHash, expectedHash] = await Promise.all([
    hashApiKey(token),
    hashApiKey(c.env.ADMIN_SECRET),
  ]);

  if (providedHash !== expectedHash) {
    return c.json({ error: "Invalid admin token" }, 401);
  }

  await next();
};
