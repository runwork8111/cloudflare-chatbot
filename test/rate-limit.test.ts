import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../src/lib/crypto";

let tenantId: string;
let rawKey: string;

beforeEach(async () => {
  tenantId = crypto.randomUUID();
  rawKey = `rate-limit-key-${tenantId}`;
  const keyHash = await hashApiKey(rawKey);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (id, slug, name, model, system_prompt) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(tenantId, `tenant-${tenantId}`, "Rate Limit Co", "gpt-4o-mini", ""),
    env.DB.prepare(
      `INSERT INTO api_keys (id, tenant_id, key_hash, label) VALUES (?1, ?2, ?3, ?4)`
    ).bind(crypto.randomUUID(), tenantId, keyHash, "test key"),
  ]);
});

function createConversation() {
  return SELF.fetch("http://example.com/v1/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
    body: "{}",
  });
}

describe("rate limiting", () => {
  it("allows requests under the limit and blocks once it's exceeded", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await createConversation();
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 201).length).toBe(30);
    expect(statuses.filter((s) => s === 429).length).toBe(1);
    expect(statuses.at(-1)).toBe(429);
  });

  it("sets Retry-After on a 429 response", async () => {
    for (let i = 0; i < 30; i++) {
      await createConversation();
    }
    const res = await createConversation();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("scopes limits independently per tenant", async () => {
    // Exhaust this tenant's budget...
    for (let i = 0; i < 30; i++) {
      await createConversation();
    }
    expect((await createConversation()).status).toBe(429);

    // ...a fresh tenant should be unaffected.
    const otherTenantId = crypto.randomUUID();
    const otherRawKey = `rate-limit-key-${otherTenantId}`;
    const otherKeyHash = await hashApiKey(otherRawKey);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (id, slug, name, model, system_prompt) VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(otherTenantId, `tenant-${otherTenantId}`, "Other Co", "gpt-4o-mini", ""),
      env.DB.prepare(
        `INSERT INTO api_keys (id, tenant_id, key_hash, label) VALUES (?1, ?2, ?3, ?4)`
      ).bind(crypto.randomUUID(), otherTenantId, otherKeyHash, "test key"),
    ]);

    const res = await SELF.fetch("http://example.com/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherRawKey}` },
      body: "{}",
    });
    expect(res.status).toBe(201);
  });
});
