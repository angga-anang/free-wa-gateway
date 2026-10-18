import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { hashApiKey } from "../lib/crypto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      compatApiConfig?: { id: string; defaultDeviceId: string | null };
      compatDeviceId?: string;
    }
  }
}

// Legacy web apps authenticate with `x-api-key: <key>` instead of the
// `Authorization: Bearer <key>` header used by the native /api/v1 API.
// Both header styles are validated against the exact same api_configs
// table/hash — this is just an alternate presentation of the same key.
export async function compatAuth(req: Request, res: Response, next: NextFunction) {
  const rawKey = req.header("x-api-key");
  if (!rawKey) {
    return res.status(401).json({ success: false, message: "Header x-api-key wajib disertakan." });
  }

  try {
    const hash = hashApiKey(rawKey);
    const { rows } = await pool.query(
      `SELECT id, default_device_id FROM api_configs WHERE api_key_hash = $1 AND is_active = TRUE LIMIT 1`,
      [hash]
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: "API key tidak valid atau sudah dicabut." });
    }
    req.compatApiConfig = { id: rows[0].id, defaultDeviceId: rows[0].default_device_id };
    next();
  } catch (err) {
    next(err);
  }
}

// Resolves which device a legacy request should target, in order of
// preference: explicit `device_id`/`instance_id` in the body, the API key's
// configured default device, or — if there's exactly one device registered
// at all — that single device (convenience for single-device setups, which
// is what the legacy gateway this replaces always assumed).
export async function resolveCompatDevice(req: Request, res: Response, next: NextFunction) {
  try {
    const explicit = req.body?.device_id || req.body?.instance_id;
    if (explicit) {
      req.compatDeviceId = explicit;
      return next();
    }

    if (req.compatApiConfig?.defaultDeviceId) {
      req.compatDeviceId = req.compatApiConfig.defaultDeviceId;
      return next();
    }

    const { rows } = await pool.query(`SELECT id FROM devices`);
    if (rows.length === 1) {
      req.compatDeviceId = rows[0].id;
      return next();
    }

    return res.status(400).json({
      success: false,
      message:
        rows.length === 0
          ? "Belum ada perangkat terdaftar. Buat perangkat dulu di dashboard FREE GW."
          : "Ada lebih dari satu perangkat terdaftar — set default device untuk API key ini, atau sertakan \"device_id\" di body request.",
    });
  } catch (err) {
    next(err);
  }
}
