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
cp .dev.vars.example .dev.vars   # fill in OPENAI_API_KEY
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

## CI

Every PR runs typecheck + `wrangler deploy --dry-run` via GitHub Actions
(`.github/workflows/ci.yml`). Requires repo secrets `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets and variables → Actions).
