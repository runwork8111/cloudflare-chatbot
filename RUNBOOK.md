# Runbook

Operational procedures for chatbot-worker. Pair with
[THREAT_MODEL.md](./THREAT_MODEL.md) (security posture) and the README
(day-to-day setup/usage).

## Rolling back a bad production deploy

Cloudflare Workers keeps prior versions; rollback is a redeploy of an old
version, not a revert-and-redeploy of code.

```bash
npx wrangler deployments list --env production      # find the last-good version ID
npx wrangler rollback <version-id> --env production  # or omit the ID to roll back one step
```

This is close to instant (no build step) and doesn't touch D1 — code and
schema are rolled back independently. That's why migrations should be
additive/backward-compatible whenever possible (see below): a code
rollback must keep working against whatever schema state the database is
actually in.

## Rolling back a bad D1 migration

D1 migrations (`migrations/*.sql`) are forward-only — there's no
`wrangler d1 migrations rollback`. Recovery options, in order of
preference:

1. **Write a new forward migration that undoes the change** (e.g. drop the
   column/table the bad migration added). This is the normal path — it
   keeps the migration history linear and matches what actually happened
   in every environment.
2. **Restore from a D1 time-travel bookmark**, if the migration corrupted
   or lost data rather than just adding an unwanted schema change:
   ```bash
   npx wrangler d1 time-travel info chatbot-worker-db-production
   npx wrangler d1 time-travel restore chatbot-worker-db-production --bookmark=<bookmark>
   ```
   Time Travel restores the whole database to a point in time — it will
   also undo any legitimate writes (new tenants, conversations, usage)
   that happened after the bad migration, so only reach for this when
   the migration actually destroyed data, not just when it added an
   unwanted column.

**Because of this, prefer additive migrations** (`ALTER TABLE ADD COLUMN`,
new tables) **over destructive ones** (`DROP COLUMN`, `DROP TABLE`,
type-narrowing changes) wherever the schema change allows it — exactly the
pattern every migration in this repo has followed so far
(`migrations/0001_init.sql` through `0003_budget.sql`).

## Incident checklist

1. **Confirm it's real**: check `npx wrangler tail --env production` for
   error-level structured log lines (`src/lib/logger.ts` — `{"level":"error",...}`),
   or the Cloudflare dashboard's Workers → Logs view.
2. **Identify the blast radius**: one tenant (check `tenantId` in the log
   lines) or everyone? A single tenant's issue (e.g. hit their
   `monthly_budget_usd`, a malformed document mid-ingestion) usually
   doesn't need a rollback at all — see "Common failure modes" below.
3. **If it's a bad deploy**: `wrangler rollback` (above), then investigate
   in a branch — don't debug live on production.
4. **If it's a bad migration**: write a forward-fixing migration (above);
   do not hand-edit the remote database outside of migrations, or the
   migration history and the actual schema will drift apart.
5. **If it's OpenAI-side** (rate limits, an outage, a model deprecation):
   nothing to roll back — check
   [status.openai.com](https://status.openai.com), consider lowering
   affected tenants' `model` via the admin dashboard as a stopgap.

## Common failure modes and what they look like

| Symptom | Likely cause | Where to look |
|---|---|---|
| One tenant gets `402` on every message | `monthly_budget_usd` reached | `GET /admin/tenants/:id/usage` — raise the cap or wait for next month |
| One tenant's widget can't create conversations, `429` | Hit the 30 req/min rate limit | Expected behavior (Day 9) — not an incident unless the tenant's legitimate traffic is being throttled, in which case the fixed limit in `src/durable-objects/rate-limiter.ts`/`src/middleware/rate-limit.ts` needs to become tenant-configurable |
| A document stuck in `status: 'processing'` | Queue consumer crashed mid-ingestion, or is retrying against a real error | `GET /admin/tenants/:id/documents` for status/error; `npx wrangler tail` for the actual exception; if genuinely stuck, delete and re-upload the document |
| `502` on every message for a tenant with documents | Vectorize misconfigured or the index doesn't exist in that environment | Confirm `npx wrangler vectorize get chatbot-worker-chunks-<env>` succeeds; this is also the expected local-dev behavior (see README "RAG pipeline"), not a bug, if you're seeing it locally |
| Widget CORS errors in the browser console | `ADMIN_ALLOWED_ORIGIN` set to the wrong origin (only affects `/admin/*` — `/v1/*` is always permissive) | Check the deployed dashboard's actual origin matches the secret |

## Adding a new tenant (operator quick reference)

See [ONBOARDING.md](./ONBOARDING.md) for the full walkthrough (budgets,
document uploads, verification steps, common mistakes). Short version:

```bash
curl $API_BASE/admin/tenants -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"slug":"acme","name":"Acme Co","system_prompt":"..."}'

curl $API_BASE/admin/tenants/<id>/api-keys -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" -d '{"label":"production widget"}'
# -> save the returned key now, it's shown exactly once
```

Then hand the tenant their embed snippet (dashboard generates it, or build
it manually — see README "Widget").
