# Onboarding a new tenant

Step-by-step for taking a new company from zero to a live, working widget
on their site. (The runbook has a condensed version of steps 1–2 for quick
reference; this is the full walkthrough, including the parts that need
judgment calls.)

Assumes `$API_BASE` (the deployed Worker URL) and `$ADMIN_SECRET` are set
in your shell, or that you're using the admin dashboard instead of raw
`curl` — either drives the same API.

## 1. Create the tenant

```bash
curl $API_BASE/admin/tenants -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "acme",
    "name": "Acme Co",
    "model": "gpt-4o-mini",
    "system_prompt": "You are the support assistant for Acme Co, a widget manufacturer. Be concise and friendly. If you cannot answer from the knowledge base, offer to connect the user with a human at support@acme.example."
  }'
```

Save the returned `id` — every subsequent call needs it.

**Writing the system prompt**: name the business, set the tone, and give an
explicit escalation path (an email/contact — the model can't invent one
usefully). Don't try to hand-write injection-defense or citation
instructions here — `getGroundedContext` (`src/lib/retrieval.ts`) appends
those automatically once the tenant has documents. Keep this prompt
focused on *this business's* voice and scope.

## 2. Set a monthly budget (recommended, not required)

Skipping this means unlimited spend. For a new/unproven tenant:

```bash
curl $API_BASE/admin/tenants/<tenant-id> -X PATCH -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"monthly_budget_usd": 25}'
```

Pick a number from expected message volume × `src/lib/pricing.ts`'s rate
for their model, with headroom — not a guess. `gpt-4o-mini` is roughly
$0.15/$0.60 per 1M input/output tokens; a typical short support exchange
is a few hundred tokens, so $25/month covers on the order of tens of
thousands of messages. Revisit after their first week of real usage via
`GET /admin/tenants/<id>/usage`.

## 3. Upload knowledge base documents (optional but usually the point)

```bash
curl $API_BASE/admin/tenants/<tenant-id>/documents -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"filename": "faq.md", "content": "..."}'
```

v0 only accepts plain text/markdown as a JSON string (see README "RAG
pipeline" for why). Practically: take their FAQ page, policy docs,
product spec sheets — copy the text out, upload as one document per
logical source (so citations point somewhere meaningful), not one giant
merged file.

**Wait for ingestion, then verify:**

```bash
curl $API_BASE/admin/tenants/<tenant-id>/documents -H "Authorization: Bearer $ADMIN_SECRET"
```

Check `status` is `ready` for each document, not stuck on `pending`/
`processing` or landed on `failed` (the `error` field says why — usually
an embeddings-API problem, rarely a real bug). This step needs a real
Vectorize index provisioned for the target environment — see README "RAG
pipeline" for the exact `wrangler vectorize create` command; without it,
every document will land on `failed`.

## 4. Mint the widget's API key

```bash
curl $API_BASE/admin/tenants/<tenant-id>/api-keys -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"label": "production widget"}'
```

**Save the returned `key` immediately — it is shown exactly once.** If you
lose it, mint a new one and revoke the old one; there's no recovery.

## 5. Hand off the embed snippet

```html
<script
  src="https://<wherever-widget.js-is-hosted>"
  data-api-base="https://<your-worker>.workers.dev"
  data-api-key="sk_live_..."
  data-title="Acme Support"
  data-turnstile-site-key="<optional, once Turnstile is set up>"
></script>
```

The admin dashboard generates this automatically right after minting a
key (it's the only time the raw key is available client-side to build it
from). Send it to whoever manages the tenant's website — one `<script>`
tag, no other integration work on their end.

## 6. Verify before calling it done

- Load a page with the snippet installed (or the local `widget/demo.html`
  pattern, pointed at the real tenant) and send a real message — confirm
  a response comes back and, if documents were uploaded, that citations
  show up under the reply.
- Check `GET /admin/tenants/<id>/usage` shows the test message.
- If a budget was set, confirm it's comfortably above what the test
  traffic used.

## Common mistakes

- **Forgetting the budget** on a new/unproven tenant — the first thing to
  check if a surprise OpenAI bill shows up.
- **Uploading a giant merged document** instead of one file per logical
  source — citations become useless ("Source: everything.md" tells nobody
  anything).
- **Not waiting for ingestion status** before declaring the tenant live —
  a widget pointed at a tenant whose documents are still `processing`
  works fine, it just won't cite anything yet; not a bug, just a timing
  gap worth knowing about.
