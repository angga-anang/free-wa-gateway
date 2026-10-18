import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { hashApiKey } from "../lib/crypto";

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
