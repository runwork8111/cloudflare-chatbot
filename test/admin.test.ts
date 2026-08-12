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
