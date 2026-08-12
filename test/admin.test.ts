import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function adminRequest(path: string, init: RequestInit = {}, token: string = env.ADMIN_SECRET): Request {
  return new Request(`http://example.com${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

describe("admin auth", () => {
  it("rejects requests with no admin token", async () => {
    const res = await SELF.fetch("http://example.com/admin/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong admin token", async () => {
    const res = await SELF.fetch(
      adminRequest("/admin/tenants", { method: "POST", body: "{}" }, "wrong-secret")
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/tenants", () => {
  it("creates a tenant with default model/system_prompt applied", async () => {
    const slug = `acme-${crypto.randomUUID()}`;
    const res = await SELF.fetch(
      adminRequest("/admin/tenants", { method: "POST", body: JSON.stringify({ slug, name: "Acme Co" }) })
    );
    expect(res.status).toBe(201);

    const body = await res.json<{ id: string; slug: string }>();
    expect(body.slug).toBe(slug);

    const row = await env.DB.prepare(`SELECT model, system_prompt FROM tenants WHERE id = ?1`)
      .bind(body.id)
      .first<{ model: string; system_prompt: string }>();
    expect(row?.model).toBe("gpt-4o-mini");
    expect(row?.system_prompt).toBe("");
  });

  it("rejects an invalid slug", async () => {
    const res = await SELF.fetch(
      adminRequest("/admin/tenants", {
        method: "POST",
        body: JSON.stringify({ slug: "Not Valid!", name: "X" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 for a duplicate slug", async () => {
    const slug = `dupe-${crypto.randomUUID()}`;
    const body = JSON.stringify({ slug, name: "Dupe Co" });

    const first = await SELF.fetch(adminRequest("/admin/tenants", { method: "POST", body }));
    expect(first.status).toBe(201);

    const second = await SELF.fetch(adminRequest("/admin/tenants", { method: "POST", body }));
    expect(second.status).toBe(409);
  });
});

describe("GET/PATCH /admin/tenants", () => {
  it("lists and fetches a created tenant", async () => {
    const slug = `list-${crypto.randomUUID()}`;
    const createRes = await SELF.fetch(
      adminRequest("/admin/tenants", { method: "POST", body: JSON.stringify({ slug, name: "List Co" }) })
    );
    const { id } = await createRes.json<{ id: string }>();

    const listRes = await SELF.fetch(adminRequest("/admin/tenants", { method: "GET" }));
    expect(listRes.status).toBe(200);
    const { tenants } = await listRes.json<{ tenants: { id: string }[] }>();
    expect(tenants.some((t) => t.id === id)).toBe(true);

    const getRes = await SELF.fetch(adminRequest(`/admin/tenants/${id}`, { method: "GET" }));
    expect(getRes.status).toBe(200);
    const tenant = await getRes.json<{ slug: string; brand_config: unknown }>();
    expect(tenant.slug).toBe(slug);
    expect(tenant.brand_config).toEqual({});
  });

  it("returns 404 fetching an unknown tenant", async () => {
    const res = await SELF.fetch(adminRequest("/admin/tenants/does-not-exist", { method: "GET" }));
    expect(res.status).toBe(404);
  });

  it("updates system_prompt and model", async () => {
    const slug = `update-${crypto.randomUUID()}`;
    const createRes = await SELF.fetch(
      adminRequest("/admin/tenants", { method: "POST", body: JSON.stringify({ slug, name: "Update Co" }) })
    );
    const { id } = await createRes.json<{ id: string }>();

    const patchRes = await SELF.fetch(
      adminRequest(`/admin/tenants/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ system_prompt: "Be extra helpful.", model: "gpt-4o" }),
      })
    );
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json<{ system_prompt: string; model: string }>();
    expect(updated.system_prompt).toBe("Be extra helpful.");
    expect(updated.model).toBe("gpt-4o");
  });

  it("rejects an empty update body", async () => {
    const res = await SELF.fetch(
      adminRequest("/admin/tenants/some-id", { method: "PATCH", body: "{}" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 patching an unknown tenant", async () => {
    const res = await SELF.fetch(
      adminRequest("/admin/tenants/does-not-exist", {
        method: "PATCH",
        body: JSON.stringify({ name: "New Name" }),
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/tenants/:id/api-keys", () => {
  it("lists keys without exposing the hash", async () => {
    const slug = `keylist-${crypto.randomUUID()}`;
    const createTenantRes = await SELF.fetch(
      adminRequest("/admin/tenants", { method: "POST", body: JSON.stringify({ slug, name: "Key List Co" }) })
    );
    const { id: tenantId } = await createTenantRes.json<{ id: string }>();

    await SELF.fetch(
      adminRequest(`/admin/tenants/${tenantId}/api-keys`, {
        method: "POST",
        body: JSON.stringify({ label: "widget" }),
      })
    );

    const listRes = await SELF.fetch(
      adminRequest(`/admin/tenants/${tenantId}/api-keys`, { method: "GET" })
    );
    expect(listRes.status).toBe(200);
    const { api_keys } = await listRes.json<{ api_keys: Record<string, unknown>[] }>();
    expect(api_keys).toHaveLength(1);
    expect(api_keys[0].label).toBe("widget");
    expect(api_keys[0]).not.toHaveProperty("key_hash");
  });
});

describe("GET /admin/tenants/:id/usage", () => {
  it("summarizes usage_events for the tenant", async () => {
    const slug = `usage-${crypto.randomUUID()}`;
    const createRes = await SELF.fetch(
      adminRequest("/admin/tenants", { method: "POST", body: JSON.stringify({ slug, name: "Usage Co" }) })
    );
    const { id: tenantId } = await createRes.json<{ id: string }>();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO usage_events (id, tenant_id, event_type, model, tokens_input, tokens_output, cost_usd) VALUES (?1, ?2, 'chat_completion', 'gpt-4o-mini', 100, 50, 0.001)`
      ).bind(crypto.randomUUID(), tenantId),
      env.DB.prepare(
        `INSERT INTO usage_events (id, tenant_id, event_type, model, tokens_input, tokens_output, cost_usd) VALUES (?1, ?2, 'chat_completion', 'gpt-4o-mini', 200, 75, 0.002)`
      ).bind(crypto.randomUUID(), tenantId),
    ]);

    const res = await SELF.fetch(adminRequest(`/admin/tenants/${tenantId}/usage`, { method: "GET" }));
    expect(res.status).toBe(200);
    const body = await res.json<{
      summary: { requestCount: number; tokensInput: number; tokensOutput: number; costUsd: number };
    }>();
    expect(body.summary.requestCount).toBe(2);
    expect(body.summary.tokensInput).toBe(300);
    expect(body.summary.tokensOutput).toBe(125);
    expect(body.summary.costUsd).toBeCloseTo(0.003, 6);
  });

  it("returns zeroed summary for a tenant with no usage", async () => {
    const slug = `no-usage-${crypto.randomUUID()}`;
    const createRes = await SELF.fetch(
      adminRequest("/admin/tenants", { method: "POST", body: JSON.stringify({ slug, name: "No Usage Co" }) })
    );
    const { id: tenantId } = await createRes.json<{ id: string }>();

    const res = await SELF.fetch(adminRequest(`/admin/tenants/${tenantId}/usage`, { method: "GET" }));
    const body = await res.json<{ summary: { requestCount: number } }>();
    expect(body.summary.requestCount).toBe(0);
  });
});

describe("API key lifecycle", () => {
  it("mints a key that authenticates against /v1/*, then revokes it", async () => {
    const slug = `lifecycle-${crypto.randomUUID()}`;
    const createTenantRes = await SELF.fetch(
      adminRequest("/admin/tenants", {
        method: "POST",
        body: JSON.stringify({ slug, name: "Lifecycle Co" }),
      })
    );
    const { id: tenantId } = await createTenantRes.json<{ id: string }>();

    const keyRes = await SELF.fetch(
      adminRequest(`/admin/tenants/${tenantId}/api-keys`, {
        method: "POST",
        body: JSON.stringify({ label: "test" }),
      })
    );
    expect(keyRes.status).toBe(201);
    const { id: keyId, key: rawKey } = await keyRes.json<{ id: string; key: string }>();
    expect(rawKey).toMatch(/^sk_live_/);

    const useReq = () =>
      SELF.fetch("http://example.com/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
        body: "{}",
      });

    expect((await useReq()).status).toBe(201);

    const revokeRes = await SELF.fetch(
      adminRequest(`/admin/tenants/${tenantId}/api-keys/${keyId}/revoke`, {
        method: "POST",
        body: "{}",
      })
    );
    expect(revokeRes.status).toBe(200);

    expect((await useReq()).status).toBe(401);
  });

  it("returns 404 minting a key for a nonexistent tenant", async () => {
    const res = await SELF.fetch(
      adminRequest("/admin/tenants/does-not-exist/api-keys", { method: "POST", body: "{}" })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 revoking an already-revoked or unknown key", async () => {
    const res = await SELF.fetch(
      adminRequest("/admin/tenants/some-tenant/api-keys/some-key/revoke", {
        method: "POST",
        body: "{}",
      })
    );
    expect(res.status).toBe(404);
  });
});
