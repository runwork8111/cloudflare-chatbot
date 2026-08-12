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

## CI

Every PR runs typecheck + `wrangler deploy --dry-run` via GitHub Actions
(`.github/workflows/ci.yml`). Requires repo secrets `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets and variables → Actions).
