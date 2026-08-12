import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env, IngestionMessage } from "./types";
import { tenantAuth } from "./middleware/tenant";
import { adminAuth } from "./middleware/admin";
import { rateLimit } from "./middleware/rate-limit";
import conversations from "./routes/conversations";
import adminTenants from "./routes/admin-tenants";
import { ingestDocument } from "./lib/ingestion";

export { RateLimiter } from "./durable-objects/rate-limiter";

const app = new Hono<AppEnv>();

// Baseline defense-in-depth headers on every response. This is a JSON API
// (the admin dashboard is a separate static site), so most of these matter
// less than on an HTML app, but they're free and non-controversial here.
app.use(secureHeaders());

app.get("/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

// Internal tenant-management API — creates tenants and mints/revokes their
// API keys. Shared-secret protected for now (ADMIN_SECRET, checked by
// adminAuth); superseded by the Cloudflare Access-gated dashboard once one
// exists. CORS defaults to permissive (matches /v1/*'s reasoning: the
// secret gates access, not the origin) but narrows to ADMIN_ALLOWED_ORIGIN
// once the dashboard has a real deployed URL to pin it to.
app.use(
  "/admin/*",
  cors({
    origin: (_origin, c) => c.env.ADMIN_ALLOWED_ORIGIN || "*",
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);
app.use("/admin/*", adminAuth);
app.route("/admin/tenants", adminTenants);

// The widget is embedded on arbitrary tenant websites, so /v1/* must accept
// cross-origin requests from any origin — the API key is what scopes access,
// not the origin. Registered before tenantAuth so preflight OPTIONS requests
// (which carry no Authorization header) never hit the 401 path.
app.use(
  "/v1/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);
app.use("/v1/*", tenantAuth);
app.use("/v1/*", rateLimit);
app.route("/v1/conversations", conversations);

export default {
  fetch: app.fetch,

  // Consumes document-ingestion jobs enqueued by POST
  // /admin/tenants/:id/documents. Retried (up to the queue's configured
  // max retries) on failure; ingestDocument itself marks the document
  // 'failed' with an error message before rethrowing, so a permanently
  // broken document doesn't retry forever without visibility.
  async queue(batch: MessageBatch<IngestionMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await ingestDocument(env, message.body.tenantId, message.body.documentId);
        message.ack();
      } catch (err) {
        console.error("Document ingestion failed", message.body, err);
        message.retry();
      }
    }
  },
};
