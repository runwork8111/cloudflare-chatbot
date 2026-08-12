// Smoke-level load test against a running Worker (local `wrangler dev` or a
// real deployment). Seeds one tenant + API key via the admin API, then
// hammers POST /v1/conversations (cheap: no OpenAI call) to characterize
// this Worker's own overhead — D1 writes, rate-limiter DO round-trip,
// Zod validation — separately from OpenAI's latency, which dominates
// /messages and varies by model/provider, not by anything this repo
// controls.
//
// Usage:
//   npx wrangler dev                                    # in one terminal
//   ADMIN_SECRET=local-dev-admin-secret node scripts/load-test.mjs

import autocannon from "autocannon";

const apiBase = process.env.API_BASE || "http://localhost:8787";
const adminSecret = process.env.ADMIN_SECRET;
const duration = Number(process.env.LOAD_TEST_DURATION || 10);
const connections = Number(process.env.LOAD_TEST_CONNECTIONS || 10);

if (!adminSecret) {
  console.error("Set ADMIN_SECRET to the target Worker's admin secret.");
  process.exit(1);
}

async function api(path, options = {}) {
  const res = await fetch(apiBase + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + adminSecret,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

console.log(`Seeding a tenant against ${apiBase}...`);
const slug = "load-test-" + Date.now();
const tenant = await api("/admin/tenants", {
  method: "POST",
  body: JSON.stringify({ slug, name: "Load Test Co" }),
});
const { key } = await api(`/admin/tenants/${tenant.id}/api-keys`, {
  method: "POST",
  body: JSON.stringify({ label: "load-test" }),
});
console.log(`Tenant ${tenant.id} ready. Running ${duration}s at ${connections} connections...\n`);

const result = await autocannon({
  url: apiBase + "/v1/conversations",
  connections,
  duration,
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + key,
  },
  body: JSON.stringify({}),
});

console.log(autocannon.printResult(result, { verbose: true }));

console.log(
  `\nNote: this Worker rate-limits each tenant to 30 req/min (src/durable-objects/rate-limiter.ts),\n` +
    `so sustained runs above that will show 429s by design, not a failure of this test.`
);
