import http from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { pool } from "./db/pool";
import { attachQrWebSocketServer } from "./ws/qrSocket";
import { startMessageWorker } from "./queue/messageQueue";
import { startWebhookWorker } from "./queue/webhookQueue";
import { instanceManager } from "./whatsapp/instanceManager";
import { loadGatewaySettings } from "./lib/gatewaySettings";

async function bootstrap() {
  // Fail fast if the DB isn't reachable / migrated yet
  await pool.query("SELECT 1");

  await loadGatewaySettings();

  const app = createApp();
  const server = http.createServer(app);

  attachQrWebSocketServer(server);
  startMessageWorker();
  startWebhookWorker();

  // Re-attach any devices that were CONNECTED before a restart so sessions
  // resume without a fresh QR scan (F-BE-102 session re-hydration).
  const { rows } = await pool.query(
    `SELECT id FROM devices WHERE status IN ('CONNECTED', 'INITIALIZING') AND auth_secret IS NOT NULL`
  );
  for (const row of rows) {
    instanceManager.initializeDevice(row.id).catch((err) =>
      logger.error({ err, deviceId: row.id }, "Failed to re-hydrate device session on boot")
    );
  }

  server.listen(env.port, () => {
    logger.info(`FREE GW backend listening on port ${env.port}`);
    logger.info(`WebSocket QR stream available at ws://localhost:${env.port}/ws/devices`);
  });

  // Housekeeping: purge expired dashboard login sessions every hour.
  const sessionCleanup = setInterval(() => {
    pool
      .query(`DELETE FROM dashboard_sessions WHERE expires_at < NOW()`)
      .catch((err) => logger.warn({ err }, "Failed to clean up expired dashboard sessions"));
  }, 60 * 60 * 1000);

  const shutdown = async () => {
    logger.info("Shutting down gracefully...");
    clearInterval(sessionCleanup);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  logger.error({ err }, "Fatal error during bootstrap");
  process.exit(1);
});
