import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { generateApiKey } from "../lib/crypto";
import { bearerAuth, verifyDashboardSession } from "../middleware/auth";

export const apiConfigRouter = Router();

// Only allow an unauthenticated POST /keys when no key exists yet
// (first-run bootstrap). Every other request on this router accepts EITHER:
//   1) a valid dashboard session (X-Dashboard-Session header), or
//   2) a valid Bearer API key token
// as proof of authorization.
//
// Why not require only the Bearer token like the rest of the API
// (F-BE-301)? Because this router manages the API keys themselves. If it
// only trusted bearerAuth, then the moment a key is revoked (or was the
// last one and gets revoked/lost), there is no longer any valid Bearer
// token to send — permanently locking the admin out of ever creating a
// replacement key, even though they're still logged into the
// password-protected dashboard. A valid dashboard session is sufficient
// proof of being the admin, so it's accepted on its own; Bearer auth
// remains as a fallback for programmatic key management that isn't going
// through the dashboard UI at all.
// The shared verifyDashboardSession lives in middleware/auth.ts so this
// gate and bearerOrSession validate a session identically.

async function bootstrapOrAuth(req: Request, res: Response, next: NextFunction) {
  if (req.method === "POST" && req.path === "/keys") {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM api_configs`);
    if (rows[0].c === 0) return next(); // first key ever: allow without auth
  }

  if (await verifyDashboardSession(req)) return next();

  return bearerAuth(req, res, next);
}

apiConfigRouter.use(bootstrapOrAuth);

// List keys (never returns raw key, only prefix + metadata)
apiConfigRouter.get("/keys", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, key_prefix, webhook_url, default_device_id, is_active, created_at, revoked_at
       FROM api_configs ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

const createKeySchema = z.object({
  label: z.string().min(1).max(100).default("API Key"),
  webhook_url: z.string().url().optional(),
  // Optional: register an existing key value verbatim (e.g. the UUID key
  // from a legacy gateway an old app can't be edited to stop using) instead
  // of generating a new random one — enables true zero-code-change migration.
  custom_key: z.string().min(6).max(255).optional(),
  // "uuid" generates a fresh random key shaped like a UUID instead of the
  // default fgw_live_... shape, for legacy apps that validate key *format*
  // rather than a specific value. Ignored if custom_key is set.
  format: z.enum(["default", "uuid"]).optional(),
});

// Generate Key — raw key is returned exactly once
apiConfigRouter.post("/keys", async (req, res, next) => {
  try {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.message });
    }
    const { label, webhook_url, custom_key, format } = parsed.data;
    const { rawKey, prefix, hash } = generateApiKey(custom_key, format);

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO api_configs (label, api_key_hash, key_prefix, webhook_url, is_active)
         VALUES ($1, $2, $3, $4, TRUE) RETURNING id, label, key_prefix, webhook_url, created_at`,
        [label, hash, prefix, webhook_url ?? null]
      ));
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "Key ini sudah terdaftar sebelumnya (mungkin dari percobaan sebelumnya).",
        });
      }
      throw err;
    }

    res.status(201).json({
      success: true,
      message: "Store this key securely — it will not be shown again.",
      data: { ...rows[0], api_key: rawKey },
    });
  } catch (err) {
    next(err);
  }
});

// Revoke Token — permanently deletes the key from the database (not a soft
// deactivation). Once revoked, the key is gone for good: it disappears from
// the dashboard list and can never be reactivated or looked up again.
// webhook_deliveries rows for this key are cascade-deleted (see schema.sql).
apiConfigRouter.post("/keys/:id/revoke", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM api_configs WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "API key not found" });
    }
    res.json({ success: true, message: "API key permanently deleted." });
  } catch (err) {
    next(err);
  }
});

apiConfigRouter.post("/keys/:id/rotate", async (req, res, next) => {
  try {
    const { rawKey, prefix, hash } = generateApiKey();
    const { rows } = await pool.query(
      `UPDATE api_configs SET api_key_hash = $1, key_prefix = $2, is_active = TRUE, revoked_at = NULL
       WHERE id = $3 RETURNING id, label, key_prefix, webhook_url`,
      [hash, prefix, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "API key not found" });
    }
    res.json({
      success: true,
      message: "Store this key securely — it will not be shown again.",
      data: { ...rows[0], api_key: rawKey },
    });
  } catch (err) {
    next(err);
  }
});

// Webhook Endpoint Registry
const webhookSchema = z.object({ webhook_url: z.string().url().nullable() });

apiConfigRouter.put("/keys/:id/webhook", async (req, res, next) => {
  try {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.message });
    }
    const { rows } = await pool.query(
      `UPDATE api_configs SET webhook_url = $1 WHERE id = $2 RETURNING id, webhook_url`,
      [parsed.data.webhook_url, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "API key not found" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Default Device — used by the legacy-compat API layer (src/routes/compat.ts)
// to know which device to target when a legacy request doesn't specify one.
const defaultDeviceSchema = z.object({ device_id: z.string().uuid().nullable() });

apiConfigRouter.put("/keys/:id/default-device", async (req, res, next) => {
  try {
    const parsed = defaultDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.message });
    }
    const { rows } = await pool.query(
      `UPDATE api_configs SET default_device_id = $1 WHERE id = $2 RETURNING id, default_device_id`,
      [parsed.data.device_id, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "API key not found" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Recent webhook delivery attempts, useful for the developer toolkit UI
apiConfigRouter.get("/webhook-deliveries", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, event, target_url, status, response_code, attempts, created_at
       FROM webhook_deliveries ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});
