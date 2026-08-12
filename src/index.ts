import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./types";
import { tenantAuth } from "./middleware/tenant";
import { adminAuth } from "./middleware/admin";
import { rateLimit } from "./middleware/rate-limit";
import conversations from "./routes/conversations";
import adminTenants from "./routes/admin-tenants";

export { RateLimiter } from "./durable-objects/rate-limiter";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

// Internal tenant-management API — creates tenants and mints/revokes their
// API keys. Shared-secret protected for now (ADMIN_SECRET, checked by
// adminAuth); superseded by the Cloudflare Access-gated dashboard once one
// exists. CORS is permissive here the same way it is on /v1/*: the admin
// dashboard (Day 11) is a static site on a different origin, and the secret
// is what actually gates access, not the origin.
app.use(
  "/admin/*",
  cors({
    origin: "*",
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

export default app;
