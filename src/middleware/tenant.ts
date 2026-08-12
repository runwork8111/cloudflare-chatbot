import type { MiddlewareHandler } from "hono";
import type { AppEnv, Tenant } from "../types";
import { hashApiKey } from "../lib/crypto";

// Resolves the tenant from `Authorization: Bearer <api-key>`, hashes the
// key to look it up (raw keys are never stored), and attaches the tenant
// to context. Revoked keys fail closed.
export const tenantAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  const apiKey = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;

  if (!apiKey) {
    return c.json({ error: "Missing API key" }, 401);
  }

  const keyHash = await hashApiKey(apiKey);
  const tenant = await c.env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.plan, t.model, t.system_prompt
     FROM api_keys k
     JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = ?1 AND k.revoked_at IS NULL`
  )
    .bind(keyHash)
    .first<Tenant>();

  if (!tenant) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("tenant", tenant);

  // Fire-and-forget: don't block the request on the usage-tracking write.
  c.executionCtx.waitUntil(
    c.env.DB.prepare(`UPDATE api_keys SET last_used_at = unixepoch() WHERE key_hash = ?1`)
      .bind(keyHash)
      .run()
  );

  await next();
};
