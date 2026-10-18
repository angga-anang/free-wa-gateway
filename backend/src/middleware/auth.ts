import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { hashApiKey, hashSessionToken } from "../lib/crypto";

// Augment Express Request with the resolved API config
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiConfig?: { id: string; webhookUrl: string | null };
    }
  }
}

// F-BE-301: Bearer Token Authorization.
// Validates every REST call against the api_configs registry.
// Non-matching tokens trigger a 401 Unauthorized reject block.
export async function bearerAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      success: false,
      message: "Missing or malformed Authorization header. Expected: Bearer <API_KEY>",
    });
  }

  try {
    const hash = hashApiKey(token);
    const result = await pool.query(
      `SELECT id, webhook_url FROM api_configs WHERE api_key_hash = $1 AND is_active = TRUE LIMIT 1`,
      [hash]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ success: false, message: "Invalid or revoked API key." });
    }

    req.apiConfig = { id: result.rows[0].id, webhookUrl: result.rows[0].webhook_url };
    next();
  } catch (err) {
    next(err);
  }
}

// Dashboard login session (X-Dashboard-Session header). The admin proved
// the password at /api/v1/auth/login, so the SHA-256-hashed token stored in
// dashboard_sessions is enough proof of the same trust level. Shared by
// apiConfigRouter's bootstrapOrAuth and bearerOrSession below, so both
// gates validate a session the same way.
export async function verifyDashboardSession(req: Request): Promise<boolean> {
  const token = req.headers["x-dashboard-session"] as string | undefined;
  if (!token) return false;
  const hash = hashSessionToken(token);
  const { rows } = await pool.query(
    `SELECT id FROM dashboard_sessions WHERE token_hash = $1 AND expires_at > NOW()`,
    [hash]
  );
  if (rows.length === 0) return false;
  pool
    .query(`UPDATE dashboard_sessions SET last_seen_at = NOW() WHERE id = $1`, [rows[0].id])
    .catch(() => undefined);
  return true;
}

// Gate for the endpoints the dashboard UI itself calls. Accepts EITHER a
// Bearer API key (external integrations, docs' native API) OR a valid
// dashboard session (admin already logged into the UI, no API key stashed
// in browser localStorage). Callers that send Authorization take the
// unchanged bearerAuth path; the logged-in dashboard without a key pays one
// indexed session lookup instead of being rejected 401.
export async function bearerOrSession(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization) return bearerAuth(req, res, next);

  if (await verifyDashboardSession(req)) return next();

  return res.status(401).json({
    success: false,
    message: "Missing or malformed Authorization header. Expected: Bearer <API_KEY> or X-Dashboard-Session",
  });
}
