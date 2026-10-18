import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const env = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",
  corsOrigin: (process.env.CORS_ORIGIN ?? "*").split(",").map((s) => s.trim()),
  // Optional override for where the backend looks for the frontend's
  // static files to serve from the same origin/port. Defaults to
  // ../../frontend relative to the compiled backend (project-root/frontend).
  frontendStaticDir: process.env.FRONTEND_STATIC_DIR || "",

  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),

  masterKey: required("MASTER_KEY"),
  bootstrapApiKey: process.env.BOOTSTRAP_API_KEY ?? "",

  minSendDelayMs: parseInt(process.env.MIN_SEND_DELAY_MS ?? "2000", 10),
  maxSendDelayMs: parseInt(process.env.MAX_SEND_DELAY_MS ?? "5000", 10),
  maxSendRetries: parseInt(process.env.MAX_SEND_RETRIES ?? "3", 10),

  socketHealthcheckIntervalMs: parseInt(
    process.env.SOCKET_HEALTHCHECK_INTERVAL_MS ?? "30000",
    10
  ),
};
