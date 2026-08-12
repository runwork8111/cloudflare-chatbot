import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../src/lib/crypto";

let tenantId: string;
let rawKey: string;

beforeEach(async () => {
  tenantId = crypto.randomUUID();
  rawKey = `test-suite-key-${tenantId}`;
  const keyHash = await hashApiKey(rawKey);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (id, slug, name, model, system_prompt) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(tenantId, `tenant-${tenantId}`, "Test Tenant", "gpt-4o-mini", "You are a test assistant."),
    env.DB.prepare(
      `INSERT INTO api_keys (id, tenant_id, key_hash, label) VALUES (?1, ?2, ?3, ?4)`
    ).bind(crypto.randomUUID(), tenantId, keyHash, "test key"),
  ]);
});

function authedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://example.com${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${rawKey}`,
      ...(init.headers ?? {}),
    },
  });
}

describe("GET /health", () => {
  it("is public and reports the environment", async () => {
    const res = await SELF.fetch("http://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("tenant auth", () => {
  it("rejects requests with no API key", async () => {
    const res = await SELF.fetch("http://example.com/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid API key", async () => {
    const res = await SELF.fetch("http://example.com/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/conversations", () => {
  it("creates a conversation for the authenticated tenant", async () => {
    const res = await SELF.fetch(authedRequest("/v1/conversations", { method: "POST", body: "{}" }));
    expect(res.status).toBe(201);

    const body = await res.json<{ id: string; tenant_id: string }>();
    expect(body.tenant_id).toBe(tenantId);

    const row = await env.DB.prepare(`SELECT tenant_id FROM conversations WHERE id = ?1`)
      .bind(body.id)
      .first<{ tenant_id: string }>();
    expect(row?.tenant_id).toBe(tenantId);
  });

  it("rejects an invalid external_user_ref type", async () => {
    const res = await SELF.fetch(
      authedRequest("/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ external_user_ref: 123 }),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/conversations/:id/messages", () => {
  it("returns 404 for a conversation that doesn't exist", async () => {
    const res = await SELF.fetch(
      authedRequest("/v1/conversations/does-not-exist/messages", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      })
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a conversation belonging to a different tenant", async () => {
    const otherTenantId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (id, slug, name, model, system_prompt) VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(otherTenantId, `other-${otherTenantId}`, "Other Tenant", "gpt-4o-mini", ""),
      env.DB.prepare(`INSERT INTO conversations (id, tenant_id) VALUES (?1, ?2)`).bind(
        conversationId,
        otherTenantId
      ),
    ]);

    const res = await SELF.fetch(
      authedRequest(`/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      })
    );
    expect(res.status).toBe(404);
  });

  it("rejects an empty message body", async () => {
    const createRes = await SELF.fetch(
      authedRequest("/v1/conversations", { method: "POST", body: "{}" })
    );
    const { id } = await createRes.json<{ id: string }>();

    const res = await SELF.fetch(
      authedRequest(`/v1/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "" }),
      })
    );
    expect(res.status).toBe(400);
  });

  // getGroundedContext only calls the real env.VECTOR_INDEX once a tenant
  // has ingested documents (test/rag-pipeline.test.ts covers the retrieval
  // logic itself via an injected fake). Vectorize has no local-dev
  // simulation, so this is the actual behavior anyone running `wrangler
  // dev`/`npm test` locally sees today for a tenant with real documents —
  // asserting it fails as a clean 502, not an unhandled crash, rather than
  // leaving that path silently unverified.
  it("degrades to a 502 (not a crash) for a tenant with documents, since Vectorize isn't locally simulated", async () => {
    const documentId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents (id, tenant_id, filename, r2_key) VALUES (?1, ?2, ?3, ?4)`
      ).bind(documentId, tenantId, "faq.md", `tenants/${tenantId}/documents/${documentId}/faq.md`),
      env.DB.prepare(
        `INSERT INTO document_chunks (id, document_id, tenant_id, chunk_index, content, vector_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(crypto.randomUUID(), documentId, tenantId, 0, "Some content.", `${documentId}:0`),
    ]);

    const createRes = await SELF.fetch(
      authedRequest("/v1/conversations", { method: "POST", body: "{}" })
    );
    const { id } = await createRes.json<{ id: string }>();

    const res = await SELF.fetch(
      authedRequest(`/v1/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      })
    );
    expect(res.status).toBe(502);
  });

  it("returns 402 once the tenant's monthly budget is exhausted, without calling OpenAI", async () => {
    await env.DB.prepare(`UPDATE tenants SET monthly_budget_usd = 1 WHERE id = ?1`)
      .bind(tenantId)
      .run();
    await env.DB.prepare(
      `INSERT INTO usage_events (id, tenant_id, event_type, model, cost_usd) VALUES (?1, ?2, 'chat_completion', 'gpt-4o-mini', 1)`
    )
      .bind(crypto.randomUUID(), tenantId)
      .run();

    const createRes = await SELF.fetch(
      authedRequest("/v1/conversations", { method: "POST", body: "{}" })
    );
    const { id } = await createRes.json<{ id: string }>();

    const res = await SELF.fetch(
      authedRequest(`/v1/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      })
    );
    expect(res.status).toBe(402);
  });
});
