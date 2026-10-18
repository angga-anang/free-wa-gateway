import { pool } from "../db/pool";
import { env } from "../config/env";
import { logger } from "./logger";

// Settings that can be changed live from the dashboard (Settings page)
// without editing backend/.env or restarting the process. Backed by the
// `gateway_settings` table, with an in-memory cache for fast reads on every
// message send (see queue/messageQueue.ts randomDelay()).

interface DelayConfig {
  minSendDelayMs: number;
  maxSendDelayMs: number;
}

let cache: DelayConfig = {
  minSendDelayMs: env.minSendDelayMs,
  maxSendDelayMs: env.maxSendDelayMs,
};

export async function loadGatewaySettings(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM gateway_settings WHERE key IN ('min_send_delay_ms', 'max_send_delay_ms')`
    );
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (map.min_send_delay_ms) cache.minSendDelayMs = parseInt(map.min_send_delay_ms, 10);
    if (map.max_send_delay_ms) cache.maxSendDelayMs = parseInt(map.max_send_delay_ms, 10);
    logger.info(cache, "Loaded gateway delay settings");
  } catch (err) {
    logger.warn({ err }, "Failed to load gateway_settings, using .env defaults");
  }
}

export function getDelayConfig(): DelayConfig {
  return cache;
}

export async function setDelayConfig(next: Partial<DelayConfig>): Promise<DelayConfig> {
  const minSendDelayMs = next.minSendDelayMs ?? cache.minSendDelayMs;
  const maxSendDelayMs = next.maxSendDelayMs ?? cache.maxSendDelayMs;

  if (!Number.isFinite(minSendDelayMs) || !Number.isFinite(maxSendDelayMs)) {
    throw new Error("Delay values must be numbers");
  }
  if (minSendDelayMs < 0 || maxSendDelayMs < 0) {
    throw new Error("Delay values cannot be negative");
  }
  if (minSendDelayMs > maxSendDelayMs) {
    throw new Error("Minimum delay cannot be greater than maximum delay");
  }
  // Guardrail: block dangerously low delays that would defeat the whole
  // point of the anti-ban pacing feature.
  if (minSendDelayMs < 500) {
    throw new Error("Minimum delay is too low (risk of WhatsApp spam detection) — use at least 500ms");
  }

  await pool.query(
    `INSERT INTO gateway_settings (key, value, updated_at) VALUES ('min_send_delay_ms', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [String(minSendDelayMs)]
  );
  await pool.query(
    `INSERT INTO gateway_settings (key, value, updated_at) VALUES ('max_send_delay_ms', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [String(maxSendDelayMs)]
  );

  cache = { minSendDelayMs, maxSendDelayMs };
  logger.info(cache, "Updated gateway delay settings");
  return cache;
}
