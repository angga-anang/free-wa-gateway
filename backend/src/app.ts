import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { bearerAuth } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { devicesRouter } from "./routes/devices";
import { messagesRouter } from "./routes/messages";
import { apiConfigRouter } from "./routes/apiKeys";
import { dashboardRouter } from "./routes/dashboard";
import { dashboardAuthRouter } from "./routes/dashboardAuth";
import { compatRouter } from "./routes/compat";
import { gatewaySettingsRouter } from "./routes/gatewaySettings";

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => res.json({ success: true, status: "ok" }));

  // Serve the dashboard frontend from this same origin/port when its files
  // are present alongside the backend (project-root/frontend by default,
  // overridable via FRONTEND_STATIC_DIR). This means a single reverse
  // proxy or tunnel (Cloudflare Tunnel, ngrok, Nginx, etc.) pointed at just
  // this one port exposes both the dashboard AND the API on one domain —
  // no separate frontend service, no CORS, no Base URL to configure: the
  // dashboard's own JS defaults to same-origin when nothing is overridden.
  // Static file serving only responds for files that actually exist and
  // falls through otherwise, so it never shadows the API/compat routes
  // below (e.g. GET /status is not a file, so it reaches compatRouter).
  const frontendDir = env.frontendStaticDir
    ? path.resolve(env.frontendStaticDir)
    : path.join(__dirname, "..", "..", "frontend");
  if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir, { index: false }));
    app.get("/", (_req, res) => res.redirect("/login.html"));
    // Convenience redirects for the bare (extension-less) paths people
    // naturally type or bookmark — e.g. https://your-tunnel-domain/login —
    // which express.static won't resolve on its own since the actual file
    // is login.html. Without these, such requests used to fall all the way
    // through to compatRouter (mounted at "/") and get rejected with a
    // confusing legacy-API auth error instead of reaching the dashboard.
    app.get("/login", (_req, res) => res.redirect("/login.html"));
    app.get("/dashboard", (_req, res) => res.redirect("/index.html"));
    app.get("/settings", (_req, res) => res.redirect("/settings.html"));
    logger.info(`Serving dashboard frontend from ${frontendDir}`);
  } else {
    logger.warn(
      `Frontend directory not found at ${frontendDir} — dashboard will not be served from this backend. Run it as a separate static server instead, or set FRONTEND_STATIC_DIR.`
    );
  }

  // Dashboard login gate MUST be mounted before apiConfigRouter below.
  // apiConfigRouter applies a blanket auth-check middleware to every
  // request under this same "/api/v1/auth" prefix (see bootstrapOrAuth in
  // apiKeys.ts) — if it were mounted first, it would intercept and reject
  // requests meant for dashboardAuthRouter (e.g. /dashboard-status, /login)
  // before they ever reached their real handlers, demanding a Bearer token
  // that a fresh login attempt has no way of having yet.
  app.use("/api/v1/auth", dashboardAuthRouter);

  // apiConfigRouter self-guards: only the very first POST /keys (bootstrap,
  // when no key exists yet) is allowed without auth; everything else on
  // this router requires a valid Bearer token (see bootstrapOrAuth).
  app.use("/api/v1/auth", apiConfigRouter);

  // F-BE-301: everything else requires Authorization: Bearer <API_KEY>
  app.use("/api/v1/devices", bearerAuth, devicesRouter);
  app.use("/api/v1/messages", bearerAuth, messagesRouter);
  app.use("/api/v1/dashboard", bearerAuth, dashboardRouter);
  app.use("/api/v1/settings", bearerAuth, gatewaySettingsRouter);

  // Legacy-compat layer: mounted at the root path (not /api/v1) so old
  // integrations work by only swapping base URL + key. Auth is via
  // x-api-key header, self-guarded inside compatRouter (see compatAuth.ts).
  app.use("/", compatRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
