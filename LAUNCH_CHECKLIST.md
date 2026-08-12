# Pilot launch checklist

This is a checklist, not a launch log — nothing in this repo has been
deployed to a real Cloudflare account or handed to a real pilot company.
That needs `wrangler login` against a real account, a real domain/zone
decision, and an actual company willing to pilot, none of which exist in
this build environment. What follows is everything to work through, in
order, when those pieces are in place.

## ✅ Already done and verified (code, local tests, and manual runs against local `wrangler dev`)

- Full request path: widget → tenant auth → rate limit → budget check →
  (optional) RAG retrieval → OpenAI → persisted + costed, streaming and
  non-streaming, with citations
- Admin API + dashboard: tenant CRUD, API key mint/revoke, document
  upload/ingest/delete, usage dashboard + CSV export, budget caps
- 69 automated tests (`npm test`, real Workers runtime via
  `@cloudflare/vitest-pool-workers`, migrated D1) — see `test/` and
  `src/**/*.test.ts`
- Security review pass with no high-confidence findings (`THREAT_MODEL.md`
  Day 26 section)
- CI: typecheck + test + dry-run on every PR; staging/production deploy
  workflows written and YAML-validated (not yet run — see below)
- Structured logging, a load-test script with real local numbers, a
  rollback runbook, an architecture diagram, a tenant-onboarding guide

## ⬜ Needs a real Cloudflare account (`wrangler login`) — not done here

Run once per environment you're actually deploying (dev/staging/production
— see README "Environments" for the naming convention):

```bash
npx wrangler login
npx wrangler d1 create chatbot-worker-db-<env>            # then paste the id into wrangler.jsonc
npx wrangler r2 bucket create chatbot-worker-docs-<env>
npx wrangler queues create chatbot-worker-ingestion-<env>
npx wrangler vectorize create chatbot-worker-chunks-<env> --dimensions 1536 --metric cosine
npx wrangler d1 migrations apply chatbot-worker-db-<env> --remote
npx wrangler secret put OPENAI_API_KEY --env <env>
npx wrangler secret put ADMIN_SECRET --env <env>
```

Then deploy for real: `npm run deploy:<env>` (or push a `v*.*.*` tag /
trigger `workflow_dispatch` for production, once GitHub repo secrets
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are set — Settings → Secrets
and variables → Actions).

## ⬜ Needs decisions + real account access beyond the Worker itself

- **Turnstile widget** — create one against the real account (dashboard or
  the `turnstile-spin` skill), set `TURNSTILE_SECRET_KEY` as a secret,
  configure the widget's site key in the embed snippet. Until this exists,
  bot verification is skipped (see README "Turnstile").
- **Admin dashboard hosting** — deploy `admin/` to Cloudflare Pages
  (`wrangler pages deploy admin`), then either keep the client-side
  `ADMIN_SECRET` prompt or set up Cloudflare Access for real per-operator
  auth (needs a zone + Access policy in the dashboard).
- **Custom domain** (optional) — attach one to the production Worker
  instead of the `*.workers.dev` default, if the pilot company's brand
  matters for the widget's network requests (it mostly doesn't — the
  widget is invisible to end users either way).
- **Billing** — no Stripe/payment-provider integration exists (README
  "Billing export"); decide whether the pilot is free, invoiced manually
  off the CSV export, or worth building real billing for before charging
  anyone.

## ⬜ Pre-launch verification (once the above exists)

Walk through [ONBOARDING.md](./ONBOARDING.md) end to end against the real
staging environment with a throwaway test tenant:

1. Create tenant, set a small budget, upload 1–2 real documents
2. Confirm ingestion reaches `status: 'ready'` (this is the step that
   silently can't work without a real Vectorize index — confirm it
   actually completes, don't assume)
3. Mint a key, load the embed snippet in an actual browser, send a real
   message, confirm the reply and citations look right
4. Deliberately exceed the tiny budget, confirm `402` fires
5. Confirm `wrangler tail` shows structured log lines for all of the above
6. Run `scripts/load-test.mjs` against staging (not local dev) to get a
   real capacity number — the numbers in `README.md` "Load testing" are
   local-dev-only and don't represent this

Only after all six pass against staging: repeat the resource-provisioning
steps for production, and do a final smoke test against production before
onboarding the actual pilot company.

## Launch day sequence (for the real pilot company)

1. Onboard them for real via [ONBOARDING.md](./ONBOARDING.md), against
   production
2. Confirm `RUNBOOK.md`'s rollback steps are fresh in mind — first 48
   hours of real traffic is when a bad edge case is most likely to surface
3. Watch `wrangler tail --env production` (or the dashboard Logs view)
   actively for the first hour, not just reactively
4. Check `GET /admin/tenants/<id>/usage` at the end of day 1 — confirm
   actual spend is in the range the budget was sized for
   ([ONBOARDING.md](./ONBOARDING.md) step 2); adjust the budget if the
   estimate was off
5. Ask the pilot contact directly whether responses felt accurate and
   on-brand — this is the one signal nothing in this repo can measure
   automatically

## What "done" means for this 30-day build

Every day of the original plan has a corresponding commit on this branch
(`git log --oneline`) with what was built, what was verified and how, and
— for anything that needed real account access this environment doesn't
have — exactly what's missing and the commands to close the gap. That's
the honest end state: a complete, tested, documented codebase ready to
deploy, not a deployed product with a real customer, because this session
never had the account access that second thing requires.
