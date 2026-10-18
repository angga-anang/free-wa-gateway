import pino from "pino";
import { env } from "../config/env";

export const logger = pino({
  level: env.nodeEnv === "production" ? "info" : "debug",
  // NFR-BE-501: never let secrets leak into logs
  redact: ["*.auth_secret", "*.MASTER_KEY", "req.headers.authorization"],
});
