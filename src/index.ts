import { Hono } from "hono";
import type { AppEnv } from "./types";
import { tenantAuth } from "./middleware/tenant";
import conversations from "./routes/conversations";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

app.use("/v1/*", tenantAuth);
app.route("/v1/conversations", conversations);

export default app;
