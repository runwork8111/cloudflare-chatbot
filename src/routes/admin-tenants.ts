import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../types";
import { generateApiKey, hashApiKey } from "../lib/crypto";

const app = new Hono<AppEnv>();

const createTenantSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1).max(255),
  model: z.string().min(1).max(100).default("gpt-4o-mini"),
  system_prompt: z.string().max(4000).default(""),
  brand_config: z.record(z.string(), z.unknown()).default({}),
});

app.post("/", zValidator("json", createTenantSchema), async (c) => {
  const body = c.req.valid("json");
  const id = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, slug, name, model, system_prompt, brand_config) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(id, body.slug, body.name, body.model, body.system_prompt, JSON.stringify(body.brand_config))
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      return c.json({ error: "A tenant with this slug already exists" }, 409);
    }
    throw err;
  }

  return c.json({ id, slug: body.slug, name: body.name }, 201);
});

const createApiKeySchema = z.object({
  label: z.string().max(255).optional(),
});

// Returns the raw key exactly once — only its hash is ever persisted, so
// there's no way to recover it later if the caller doesn't save it now.
app.post("/:tenantId/api-keys", zValidator("json", createApiKeySchema), async (c) => {
  const tenantId = c.req.param("tenantId");

  const tenant = await c.env.DB.prepare(`SELECT id FROM tenants WHERE id = ?1`)
    .bind(tenantId)
    .first();
  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const { label } = c.req.valid("json");
  const rawKey = generateApiKey();
  const keyHash = await hashApiKey(rawKey);
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, tenant_id, key_hash, label) VALUES (?1, ?2, ?3, ?4)`
  )
    .bind(id, tenantId, keyHash, label ?? "")
    .run();

  return c.json({ id, key: rawKey }, 201);
});

app.post("/:tenantId/api-keys/:keyId/revoke", async (c) => {
  const { tenantId, keyId } = c.req.param();

  const result = await c.env.DB.prepare(
    `UPDATE api_keys SET revoked_at = unixepoch() WHERE id = ?1 AND tenant_id = ?2 AND revoked_at IS NULL`
  )
    .bind(keyId, tenantId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "API key not found or already revoked" }, 404);
  }

  return c.json({ revoked: true });
});

export default app;
