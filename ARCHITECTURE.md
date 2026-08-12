# Architecture

One Cloudflare Worker (`src/index.ts`, Hono router) fronting everything;
D1 as the system of record; R2/Vectorize/Queues for the RAG pipeline;
OpenAI for generation and embeddings. No separate backend service — the
Worker *is* the backend.

```mermaid
flowchart TB
    subgraph clients["Client surfaces"]
        widget["Widget (widget/widget.js)<br/>embedded on tenant sites"]
        dashboard["Admin dashboard (admin/)<br/>static SPA"]
    end

    subgraph worker["chatbot-worker (single Cloudflare Worker)"]
        router["Hono router (src/index.ts)"]
        tenantAuth["tenantAuth + rateLimit<br/>(per-tenant API key)"]
        adminAuth["adminAuth<br/>(shared ADMIN_SECRET)"]
        convRoutes["/v1/conversations*<br/>(src/routes/conversations.ts)"]
        adminRoutes["/admin/*<br/>(src/routes/admin-tenants.ts)"]
        rateLimiterDO["RateLimiter Durable Object<br/>1 instance per tenant"]
        queueConsumer["queue() handler<br/>ingestDocument"]
    end

    subgraph storage["Storage"]
        d1[("D1: tenants, api_keys,<br/>conversations, messages,<br/>usage_events, documents,<br/>document_chunks")]
        r2[("R2: raw uploaded<br/>documents")]
        vectorize[("Vectorize: chunk<br/>embeddings, tenantId-filtered")]
        queue[["Queue: ingestion jobs"]]
    end

    openai{{"OpenAI API<br/>chat completions + embeddings"}}
    turnstile{{"Cloudflare Turnstile<br/>siteverify (optional)"}}

    widget -->|"Bearer sk_live_...<br/>+ CORS: *"| router
    dashboard -->|"Bearer ADMIN_SECRET"| router

    router --> tenantAuth --> convRoutes
    router --> adminAuth --> adminRoutes

    tenantAuth --> rateLimiterDO
    convRoutes -->|"read/write"| d1
    convRoutes -->|"embed query +<br/>tenantId-filtered search"| vectorize
    convRoutes -->|"chat completion<br/>(streamed or not)"| openai
    convRoutes -.->|"verify token<br/>(if configured)"| turnstile

    adminRoutes -->|"CRUD"| d1
    adminRoutes -->|"upload"| r2
    adminRoutes -->|"enqueue ingest job"| queue
    adminRoutes -->|"delete vectors"| vectorize

    queue --> queueConsumer
    queueConsumer -->|"fetch raw doc"| r2
    queueConsumer -->|"chunk + embed"| openai
    queueConsumer -->|"upsert chunks"| vectorize
    queueConsumer -->|"record chunks,<br/>update status"| d1
```

## Request paths

**Chat message** (`POST /v1/conversations/:id/messages[/stream]`):
`tenantAuth` resolves the tenant from the hashed API key → `rateLimit`
checks the per-tenant Durable Object → `isOverMonthlyBudget` checks
`usage_events` → if the tenant has ingested documents,
`getGroundedContext` embeds the query and does a `tenantId`-filtered
Vectorize search, wrapping the system prompt with grounding/citation/
injection-defense instructions → `chatCompletion`/`streamChatCompletion`
calls OpenAI → `persistTurn` writes both messages plus a costed
`usage_events` row to D1 in one batch.

**Document ingestion** (`POST /admin/tenants/:id/documents` → async):
the HTTP request only writes to R2, inserts a `documents` row, and
enqueues a job — it returns immediately. The `queue()` handler in
`src/index.ts` does the actual work: fetch from R2 → `chunkText` → embed
each chunk via OpenAI → upsert into Vectorize → write `document_chunks`
rows → flip `documents.status` to `ready` (or `failed`, with a reason).

## Why one Worker, not several

Everything (chat, RAG retrieval, admin CRUD, ingestion) runs in this one
Worker rather than being split into separate services. At this scale
that's simpler to reason about, deploy, and test — the tradeoff noted in
[THREAT_MODEL.md](./THREAT_MODEL.md)'s Secrets Store section is exactly
this: splitting ingestion into its own Worker would be the trigger to
revisit that decision, not before.

## What's *not* in this diagram

Cloudflare Access (gating the admin dashboard) and a real Vectorize index
per environment both need actions against a live Cloudflare account that
this build environment doesn't have — see README "RAG pipeline" and
"Admin dashboard" for the exact commands to provision them for real.
