import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./types";
import { tenantAuth } from "./middleware/tenant";
import conversations from "./routes/conversations";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

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
app.route("/v1/conversations", conversations);

export default app;
