# chatbot-worker

Multi-tenant chatbot backend on Cloudflare Workers + OpenAI. See
[THREAT_MODEL.md](./THREAT_MODEL.md) for the security posture and known gaps.

## Environments

| Env | Command | Worker name |
|-----|---------|--------------|
| dev (default) | `npm run dev` / `npm run deploy:dev` | `chatbot-worker-dev` |
| staging | `npm run deploy:staging` | `chatbot-worker-staging` |
| production | `npm run deploy:production` | `chatbot-worker` |

## Local setup

```bash
cp .dev.vars.example .dev.vars   # fill in OPENAI_API_KEY and ADMIN_SECRET
npm run dev
```

## Database (D1)

Schema lives in `migrations/`, one file per change, applied in order.

```bash
# One-time, per environment, after `wrangler login`:
npx wrangler d1 create chatbot-worker-db-dev
# paste the returned database_id into wrangler.jsonc (top-level d1_databases)
# repeat for chatbot-worker-db-staging / chatbot-worker-db-production under env.staging / env.production

# Apply migrations
npx wrangler d1 migrations apply chatbot-worker-db-dev --local     # local dev
npx wrangler d1 migrations apply chatbot-worker-db-dev --remote    # real dev DB

# Seed a local test tenant + API key (raw key: "dev-test-key")
npx wrangler d1 execute chatbot-worker-db-dev --local --file db/seed.local.sql
```

## API

Tenant-scoped routes under `/v1/*` require `Authorization: Bearer <api-key>`;
the middleware hashes the key and resolves it to a tenant row via `api_keys`.

```bash
curl http://localhost:8787/health

curl http://localhost:8787/v1/conversations \
  -X POST -H "Authorization: Bearer dev-test-key" \
  -H "Content-Type: application/json" \
  -d '{"external_user_ref":"visitor-42"}'
```

## Admin API

`/admin/*` creates and updates tenants and mints/revokes their API keys.
It's protected by a single shared secret (`ADMIN_SECRET`) — an internal
control-plane tool for now, superseded by a Cloudflare Access-gated version
once this is deployed against a real zone. A minted key is returned exactly
once; only its hash is stored.

| Route | Purpose |
|---|---|
| `POST /admin/tenants` | Create a tenant |
| `GET /admin/tenants` | List tenants |
| `GET /admin/tenants/:id` | Fetch one tenant |
| `PATCH /admin/tenants/:id` | Update name/model/system_prompt/brand_config |
| `GET /admin/tenants/:id/usage?days=30` | Request count, tokens, estimated cost (totals + daily) |
| `GET /admin/tenants/:id/usage/export?days=30` | Same, as a downloadable CSV |
| `POST /admin/tenants/:id/api-keys` | Mint a key (raw key shown once) |
| `GET /admin/tenants/:id/api-keys` | List keys (no hash/raw key exposed) |
| `POST /admin/tenants/:id/api-keys/:keyId/revoke` | Revoke a key |

```bash
curl http://localhost:8787/admin/tenants \
  -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"slug":"acme","name":"Acme Co","system_prompt":"You are Acme'\''s support assistant."}'

curl http://localhost:8787/admin/tenants/<tenant-id>/api-keys \
  -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"label":"production widget key"}'
# => { "id": "...", "key": "sk_live_..." }  — save the key now, it isn't shown again

curl http://localhost:8787/admin/tenants/<tenant-id>/api-keys/<key-id>/revoke \
  -X POST -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" -d '{}'
```

Cost is estimated at write time (`src/lib/pricing.ts`) from a hardcoded
per-model $/1M-token table — good enough for dashboards and spend caps, not
exact enough for invoicing. Update it if OpenAI repricing drifts.

### Monthly budget caps

Set `monthly_budget_usd` on a tenant (via `PATCH /admin/tenants/:id` or the
dashboard) to cap its spend; `null` (the default) means unlimited. Both
message endpoints check the tenant's cost-to-date for the current calendar
month (`src/lib/usage.ts`'s `isOverMonthlyBudget`) *before* calling OpenAI,
returning `402 Payment Required` once the cap is reached — so a capped
tenant can't run up further spend past its budget, not even by one more
request's worth.

### Billing export

`GET /admin/tenants/:id/usage/export?days=30` returns a CSV (date,
requests, tokens in/out, cost) — the dashboard's "Export 30-day CSV"
button downloads it. No Stripe (or other payment provider) integration:
that needs a real merchant account and API keys this environment doesn't
have. This CSV is the interim — reconcile manually, or feed it into
whatever billing system actually exists.

## Admin dashboard

`admin/` is a static, no-build-step SPA (plain HTML/CSS/JS, same style as
the widget) over the admin API above: lists tenants, edits
name/model/system_prompt/brand_config, mints and revokes API keys, and
generates the widget embed `<script>` snippet from a freshly minted key.

```bash
npx wrangler dev        # in one terminal
npx serve admin          # in another — open the printed URL
```

On first load it asks for the API base URL, `ADMIN_SECRET`, and (optionally)
where `widget/widget.js` is hosted, all stored in `localStorage` — nothing
is sent anywhere except to the API base you configure. Minted keys are kept
in memory only for the current page session, matching the server's
"shown once" behavior; refreshing loses it, same as the API does.

**Deployment note**: this is a static site, so it deploys to Cloudflare
Pages (`wrangler pages deploy admin`) same as any other static app — but
gating it with Cloudflare Access instead of a client-side secret prompt
requires a zone and Access policy configured in the dashboard, which needs
real account access this environment doesn't have. Until then, treat the
`ADMIN_SECRET` prompt as the access control, same as the raw `curl` calls
above.

## Widget

`widget/widget.js` is a single self-contained script (no build step) that
renders a chat bubble and talks to `/v1/conversations*` directly from the
browser, including manual SSE parsing for the streaming endpoint (EventSource
can't send POST bodies, so it isn't used here). `/v1/*` has permissive CORS
since the widget runs on arbitrary tenant domains.

```bash
npx wrangler dev            # in one terminal
npx serve widget             # in another — open the printed URL's demo.html
```

**Known interim tradeoff**: the widget embeds the tenant's API key in
client-visible markup, and that key currently has full admin-mintable-key
access rather than a separate restricted "public" key type. Rate limiting
(below) and Turnstile bound the blast radius of that for now; a distinct
public-key type is still worth doing before a real pilot.

## Rate limiting

Each tenant gets a 30 requests/minute budget on `/v1/*`, enforced by a
Durable Object (`src/durable-objects/rate-limiter.ts`) — one DO instance per
tenant, so the increment-and-check is atomic without needing a distributed
lock. Exceeding it returns `429` with a `Retry-After` header.

## Turnstile

Conversation creation (`POST /v1/conversations`) verifies a Turnstile token
server-side whenever `TURNSTILE_SECRET_KEY` is set — this is the one piece
of this project that needs a real Cloudflare Turnstile widget, which can
only be created against a live Cloudflare account (`wrangler login`, then
either the dashboard or the `turnstile-spin` skill). Until that exists,
leave `TURNSTILE_SECRET_KEY` unset (the default in `.dev.vars.example`) and
verification is skipped — this is what local dev and CI do today.

Once a widget exists: set its secret key as `TURNSTILE_SECRET_KEY` (via
`wrangler secret put` for staging/production), and pass its site key to the
embed snippet as `data-turnstile-site-key` (site keys are public, safe to
ship client-side).

## RAG pipeline

Tenants can upload knowledge-base documents; the bot then answers grounded
in that content, with citations, instead of relying on the model's general
knowledge or the base system prompt alone.

**Flow**: `POST /admin/tenants/:id/documents` (raw text/markdown in a JSON
body — see below) stores the file in R2, inserts a `documents` row
(`status: 'pending'`), and enqueues a job. The `queue` handler in
`src/index.ts` picks it up, chunks it (`src/lib/chunking.ts`, paragraph-aware
with overlap), embeds each chunk (OpenAI `text-embedding-3-small`), and
upserts them into Vectorize with the source `document_chunks` rows in D1.
On a chat message, `getGroundedContext` (`src/lib/retrieval.ts`) embeds the
query, does a `tenantId`-filtered Vectorize search, and — only for tenants
who've actually uploaded something — wraps the tenant's system prompt with
grounding, citation, and prompt-injection-defense instructions (retrieved
document content is treated as untrusted data, not instructions). Both
`/v1/conversations/:id/messages` and the `/stream` variant return a
`sources` array alongside the reply; the widget renders it under the
message.

```bash
curl http://localhost:8787/admin/tenants/<tenant-id>/documents \
  -X POST -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"filename":"faq.md","content":"Our return policy allows returns within 30 days."}'
```

**v0 scope, deliberately**: plain text/markdown only, uploaded as a JSON
string (no multipart, no PDF/docx extraction) — real document formats are
a follow-up, not core to proving the retrieval pipeline works.

**Known limitation — Vectorize has no local-dev simulation.** Wrangler
warns "Vectorize Index bindings do not support local development" on every
local run; calling it locally throws "needs to be run remotely" (confirmed
by actually uploading and ingesting a document against this repo's local
dev server — it fails exactly there, cleanly, marking the document
`status: 'failed'` with that message). Two consequences, both handled
deliberately rather than left silently broken:

1. **Ingestion and retrieval are unit-testable anyway** — `ingestDocument`
   and `retrieveRelevantChunks` take an injectable `{ embed, vectorIndex }`,
   the same pattern used for OpenAI's `fetchImpl`. `test/rag-pipeline.test.ts`
   exercises the real chunk → embed → store → retrieve → grounded-prompt
   logic end to end against an in-memory fake vector index (real
   cosine-similarity ranking, deterministic keyword-based fake embeddings)
   — this is genuine coverage of everything this codebase controls; only
   Cloudflare's own Vectorize infrastructure is out of reach here.
2. **A tenant with real documents will 502 in local dev / this
   environment** until a real Vectorize index exists remotely — asserted
   explicitly in `test/conversations.test.ts` rather than left as an
   unexplained gap.

**To make it actually work** (needs `wrangler login` + real account access
this environment doesn't have):

```bash
npx wrangler vectorize create chatbot-worker-chunks-dev --dimensions 1536 --metric cosine
npx wrangler r2 bucket create chatbot-worker-docs-dev
npx wrangler queues create chatbot-worker-ingestion-dev
# repeat with -staging/-production names for those environments
```

## Observability

Every request logs one structured JSON line (`src/lib/logger.ts` +
`src/middleware/request-logger.ts`): `route`, `method`, `status`,
`durationMs`, `tenantId` when known. Errors go through the same logger, so
`OpenAI request failed`-type messages get PII-redacted (`src/lib/pii.ts`)
before they hit Workers Logs. View them with:

```bash
npx wrangler tail                    # deployed Worker
# local `wrangler dev` prints them directly to its own terminal
```

`observability.enabled: true` in `wrangler.jsonc` is what makes these
queryable in the Cloudflare dashboard's Logs view for a deployed Worker.
Two things this doesn't cover, deliberately left as follow-ups rather than
faked: a **dashboard** (Analytics Engine, or piping logs to Grafana/Datadog)
and **alerting** (email/Slack/PagerDuty on error-rate or latency spikes) —
both need a real Cloudflare account (and, for alerting, a destination) to
configure, which this environment doesn't have. The structured fields above
are exactly what either would query against once wired up.

## Load testing

`scripts/load-test.mjs` seeds a tenant via the admin API, then hammers
`POST /v1/conversations` with [autocannon](https://github.com/mcollina/autocannon)
— that endpoint rather than `/messages` deliberately, to measure this
Worker's own overhead (D1 write, rate-limiter DO round-trip, Zod
validation) separately from OpenAI's latency, which dominates `/messages`
and isn't something this codebase controls.

```bash
npx wrangler dev   # in one terminal
ADMIN_SECRET=local-dev-admin-secret LOAD_TEST_DURATION=10 LOAD_TEST_CONNECTIONS=10 \
  npm run load-test
```

Ran it against local `wrangler dev` (5s, 5 connections): **28 requests,
~4.6 req/sec, ~1024ms median latency**. Take that as a smoke test that the
script and the endpoint both work, not a production capacity number —
local `wrangler dev` has real per-request overhead (D1-over-IPC, cold
workerd startup) that a deployed edge Worker doesn't have. Also: the
30 req/min per-tenant rate limit means sustained runs above that show
`429`s by design — that's the rate limiter working, not the test failing.
A real capacity number needs running this against a deployed
staging/production Worker, which needs a real Cloudflare deployment this
environment can't create.

## CI

Every PR generates Worker types, typechecks, runs the test suite (`npm test`,
via `@cloudflare/vitest-pool-workers` — real Workers runtime, migrated D1),
then `wrangler deploy --dry-run` (`.github/workflows/ci.yml`, `validate` job).
Requires repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
(Settings → Secrets and variables → Actions).

### Staging deploys

A push to the `staging` branch runs `validate` first, then (only if that
passes) the `deploy-staging` job: applies D1 migrations to the real staging
database (`--remote`), deploys with `wrangler deploy --env staging`, and —
if the optional repo variable `STAGING_URL` is set (Settings → Secrets and
variables → Actions → Variables; e.g.
`https://chatbot-worker-staging.<your-subdomain>.workers.dev` — the
`*.workers.dev` subdomain is account-specific, so it can't be hardcoded) —
smoke-tests `/health` and fails the job if it doesn't return 200.

This needs the staging D1/R2/Vectorize/Queues resources to already exist
(the `wrangler ... create` commands are in "Database (D1)" and "RAG
pipeline" above) — the workflow deploys to them, it doesn't create them.
None of this has actually run, since it needs `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` for a real account this environment doesn't have;
the YAML is validated (`python -c "import yaml; yaml.safe_load(...)"`)
but not executed.
