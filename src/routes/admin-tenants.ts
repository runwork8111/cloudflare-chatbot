import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../types";
import { generateApiKey, hashApiKey } from "../lib/crypto";
import { getTenantUsageByDay, getTenantUsageSummary } from "../lib/usage";

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

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  plan: string;
  model: string;
  system_prompt: string;
  brand_config: string;
  created_at: number;
  updated_at: number;
}

function serializeTenant(row: TenantRow) {
  return { ...row, brand_config: JSON.parse(row.brand_config) };
}

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

app.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tenants ORDER BY created_at DESC`
  ).all<TenantRow>();
  return c.json({ tenants: results.map(serializeTenant) });
});

app.get("/:tenantId", async (c) => {
  const tenant = await c.env.DB.prepare(`SELECT * FROM tenants WHERE id = ?1`)
    .bind(c.req.param("tenantId"))
    .first<TenantRow>();
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  return c.json(serializeTenant(tenant));
});

const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  model: z.string().min(1).max(100).optional(),
  system_prompt: z.string().max(4000).optional(),
  brand_config: z.record(z.string(), z.unknown()).optional(),
});

app.patch("/:tenantId", zValidator("json", updateTenantSchema), async (c) => {
  const tenantId = c.req.param("tenantId");
  const updates = c.req.valid("json");

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = ?${paramIndex}`);
    values.push(key === "brand_config" ? JSON.stringify(value) : value);
    paramIndex += 1;
  }
  setClauses.push(`updated_at = unixepoch()`);
  values.push(tenantId);

  const result = await c.env.DB.prepare(
    `UPDATE tenants SET ${setClauses.join(", ")} WHERE id = ?${paramIndex}`
  )
    .bind(...values)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const tenant = await c.env.DB.prepare(`SELECT * FROM tenants WHERE id = ?1`)
    .bind(tenantId)
    .first<TenantRow>();
  return c.json(serializeTenant(tenant as TenantRow));
});

app.get("/:tenantId/usage", async (c) => {
  const tenantId = c.req.param("tenantId");
  const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 30));
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const [summary, daily] = await Promise.all([
    getTenantUsageSummary(c.env, tenantId, since),
    getTenantUsageByDay(c.env, tenantId, since),
  ]);

  return c.json({ days, summary, daily });
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

app.get("/:tenantId/api-keys", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, label, last_used_at, revoked_at, created_at FROM api_keys WHERE tenant_id = ?1 ORDER BY created_at DESC`
  )
    .bind(c.req.param("tenantId"))
    .all();
  return c.json({ api_keys: results });
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
