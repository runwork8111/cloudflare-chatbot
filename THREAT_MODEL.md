# Threat model

Short, living document — updated as the system grows, not a one-time
checkbox. Last reviewed: Day 14 of the build.

## Assets

- **`OPENAI_API_KEY`** — a leak means unbounded spend on our account, by anyone.
- **Tenant data isolation** — one tenant must never see another's conversations, messages, or usage.
- **`ADMIN_SECRET`** — controls tenant/API-key management for the whole platform.
- **Tenant API keys** (`sk_live_...`) — scope a caller to one tenant's data and spend.
- **End-user conversation content** — may contain PII the end user typed to the widget.

## Actors

| Actor | Capability | Motivation |
|---|---|---|
| Anonymous internet | Can call `/health`, `/v1/*` with a stolen/guessed key, `/admin/*` with a stolen/guessed secret | Abuse, cost exhaustion, data theft |
| A tenant's own visitors | Can use the widget with that tenant's real API key (it's client-visible by design) | Legitimate use, or abuse of that one tenant's budget |
| A competitor tenant | Has valid credentials for tenant A, tries to access tenant B's data | Data theft |
| Malicious/compromised admin operator browser | Has `ADMIN_SECRET` in `localStorage` | Full platform control if the browser is compromised (XSS, malware) |

## Mitigations already in place

- **Credential storage**: tenant API keys and `ADMIN_SECRET` comparisons never touch raw values in storage — `api_keys.key_hash` is SHA-256, and `adminAuth` compares digests, not strings, so a timing side-channel doesn't leak `ADMIN_SECRET` (`src/middleware/admin.ts`).
- **Cross-tenant isolation**: every tenant-scoped query filters by `tenant_id`; `loadConversationHistory` returns "not found" (not "forbidden") for another tenant's conversation ID, so existence isn't leaked either. Covered by tests (`test/conversations.test.ts`, `test/admin.test.ts`).
- **Rate limiting**: 30 req/min per tenant via a Durable Object (Day 9) — bounds the damage of a scraped widget key.
- **Bot verification**: Turnstile on conversation creation, once a real widget is provisioned (Day 10).
- **Revocation**: API keys can be revoked immediately and take effect on the next request (no caching).
- **Input validation**: every request body is Zod-validated before touching the database or OpenAI.
- **Security headers**: `hono/secure-headers()` applied globally (this Worker only serves JSON, so the marginal value is mostly for the rare browser-rendered error page).

## Known gaps / accepted risk for now

- **One key tier per tenant**: the widget embeds a full-access tenant API key client-side (flagged since Day 6). A distinct rate-limited "public" key type, separate from a back-office "secret" key, is still open. Rate limiting + Turnstile bound the damage in the meantime.
- **Admin auth is a shared secret, not per-operator identity**: anyone with `ADMIN_SECRET` can do anything to any tenant, and there's no audit log of who did what. Acceptable for a single-operator internal tool; not acceptable once more than one person touches production. Cloudflare Access (per-identity, logged) is the intended replacement — blocked on having a real zone/dashboard access to configure it, which this environment doesn't have.
- **No PII redaction on stored conversation content yet** — planned for Day 20 alongside the RAG guardrails work.
- **No audit log** of admin actions (tenant created/updated, key minted/revoked) beyond D1's own `created_at`/`updated_at` columns. Worth adding before a real pilot if more than one operator has `ADMIN_SECRET`.

## Secrets Store: considered and deliberately not used (yet)

The Day 14 plan called for "move sensitive config to Secrets Store." Cloudflare
Secrets Store is for sharing one secret across *multiple* Workers/services
under one account. This project is currently a single Worker — plain Worker
secrets (`wrangler secret put`, already used for `OPENAI_API_KEY`,
`ADMIN_SECRET`, `TURNSTILE_SECRET_KEY`) are the right tool for that shape and
add no operational benefit over Secrets Store here. Revisit this if the
architecture splits into multiple Workers (e.g. a separate ingestion worker
from Week 3) that need to share `OPENAI_API_KEY`.

## CORS posture

- `/v1/*`: origin `*`, intentionally — the widget is embedded on arbitrary
  tenant websites, so the origin can't be pinned. The API key is the actual
  access control.
- `/admin/*`: origin `*` by default, narrows to `ADMIN_ALLOWED_ORIGIN` once
  the dashboard has a real deployed URL to pin it to (Day 14). CORS wildcard
  here is lower-risk than it looks: `ADMIN_SECRET` lives in the dashboard's
  own `localStorage`, which a different origin cannot read — the real risk
  is XSS on the dashboard's own origin, which CORS doesn't address either way.
