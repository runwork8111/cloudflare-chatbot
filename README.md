# chatbot-worker

Multi-tenant chatbot backend on Cloudflare Workers + OpenAI.

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

## CI

Every PR generates Worker types, typechecks, runs the test suite (`npm test`,
via `@cloudflare/vitest-pool-workers` — real Workers runtime, migrated D1),
then `wrangler deploy --dry-run` (`.github/workflows/ci.yml`). Requires repo
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings →
Secrets and variables → Actions).
