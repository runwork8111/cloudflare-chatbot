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

`/admin/*` creates tenants and mints/revokes their API keys. It's protected
by a single shared secret (`ADMIN_SECRET`) — an internal control-plane tool
for now, superseded by the Cloudflare Access-gated dashboard planned for
Week 2. A minted key is returned exactly once; only its hash is stored.

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
client-visible markup, and that key currently has full API access. That's
fine for local development, but before a real pilot (Week 2, rate limiting +
Turnstile) this needs a separate, restricted "public" key type that's
rate-limited and safe to expose client-side.

## CI

Every PR generates Worker types, typechecks, runs the test suite (`npm test`,
via `@cloudflare/vitest-pool-workers` — real Workers runtime, migrated D1),
then `wrangler deploy --dry-run` (`.github/workflows/ci.yml`). Requires repo
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings →
Secrets and variables → Actions).
