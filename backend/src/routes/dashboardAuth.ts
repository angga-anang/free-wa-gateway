import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import {
  hashDashboardPassword,
  verifyDashboardPassword,
  generateSessionToken,
  hashSessionToken,
} from "../lib/crypto";

export const dashboardAuthRouter = Router();

const SESSION_TTL_HOURS = 12;

// ---- Basic brute-force protection (in-memory, per-process) ----
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
}

function isLockedOut(ip: string): boolean {
  const rec = attempts.get(ip);
  return !!rec && rec.lockedUntil > Date.now();
}

function recordFailure(ip: string) {
  const rec = attempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

function recordSuccess(ip: string) {
  attempts.delete(ip);
}

// ---- Session verification middleware (used by other routers if needed) ----
export async function requireDashboardSession(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-dashboard-session"] as string | undefined;
  if (!token) {
    return res.status(401).json({ success: false, message: "Missing dashboard session." });
  }
  const hash = hashSessionToken(token);
  const { rows } = await pool.query(
    `SELECT id FROM dashboard_sessions WHERE token_hash = $1 AND expires_at > NOW()`,
    [hash]
  );
  if (rows.length === 0) {
    return res.status(401).json({ success: false, message: "Session expired or invalid." });
  }
  pool
    .query(`UPDATE dashboard_sessions SET last_seen_at = NOW() WHERE id = $1`, [rows[0].id])
    .catch(() => undefined);
  next();
}

// Whether a dashboard password has ever been set (drives login.html's UI:
// "create password" first-run form vs normal "enter password" form).
dashboardAuthRouter.get("/dashboard-status", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id FROM dashboard_auth WHERE id = 1`);
    res.json({ success: true, data: { configured: rows.length > 0 } });
  } catch (err) {
    next(err);
  }
});

const passwordSchema = z.object({ password: z.string().min(8).max(200) });

// First-run bootstrap: only works while no dashboard password exists yet.
dashboardAuthRouter.post("/dashboard-password", async (req, res, next) => {
  try {
    const existing = await pool.query(`SELECT id FROM dashboard_auth WHERE id = 1`);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Dashboard password already set. Log in and use change-password instead.",
      });
    }
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Password minimal 8 karakter.",
      });
    }
    const { hash, salt } = hashDashboardPassword(parsed.data.password);
    await pool.query(
      `INSERT INTO dashboard_auth (id, password_hash, password_salt) VALUES (1, $1, $2)`,
      [hash, salt]
    );

    // Auto-login after bootstrap so the admin doesn't have to log in twice.
    const { rawToken, hash: tokenHash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
    await pool.query(
      `INSERT INTO dashboard_sessions (token_hash, ip_address, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash, clientIp(req), expiresAt]
    );

    res.status(201).json({
      success: true,
      message: "Password dashboard berhasil dibuat.",
      data: { token: rawToken, expires_at: expiresAt.toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

dashboardAuthRouter.post("/login", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    if (isLockedOut(ip)) {
      return res.status(429).json({
        success: false,
        message: "Terlalu banyak percobaan gagal. Coba lagi dalam beberapa menit.",
      });
    }

    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Password tidak valid." });
    }

    const { rows } = await pool.query(`SELECT password_hash, password_salt FROM dashboard_auth WHERE id = 1`);
    if (rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Password dashboard belum dibuat.",
      });
    }

    const valid = verifyDashboardPassword(
      parsed.data.password,
      rows[0].password_hash,
      rows[0].password_salt
    );
    if (!valid) {
      recordFailure(ip);
      return res.status(401).json({ success: false, message: "Password salah." });
    }
    recordSuccess(ip);

    const { rawToken, hash: tokenHash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
    await pool.query(
      `INSERT INTO dashboard_sessions (token_hash, ip_address, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash, ip, expiresAt]
    );

    res.json({
      success: true,
      data: { token: rawToken, expires_at: expiresAt.toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

dashboardAuthRouter.get("/verify-session", async (req, res, next) => {
  try {
    const token = req.headers["x-dashboard-session"] as string | undefined;
    if (!token) return res.json({ success: true, data: { valid: false } });
    const hash = hashSessionToken(token);
    const { rows } = await pool.query(
      `SELECT id FROM dashboard_sessions WHERE token_hash = $1 AND expires_at > NOW()`,
      [hash]
    );
    res.json({ success: true, data: { valid: rows.length > 0 } });
  } catch (err) {
    next(err);
  }
});

dashboardAuthRouter.post("/logout", async (req, res, next) => {
  try {
    const token = req.headers["x-dashboard-session"] as string | undefined;
    if (token) {
      await pool.query(`DELETE FROM dashboard_sessions WHERE token_hash = $1`, [
        hashSessionToken(token),
      ]);
    }
    res.json({ success: true, message: "Logged out." });
  } catch (err) {
    next(err);
  }
});

const changePasswordSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(8).max(200),
});

dashboardAuthRouter.post("/change-password", requireDashboardSession, async (req, res, next) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Password baru minimal 8 karakter.",
      });
    }
    const { rows } = await pool.query(`SELECT password_hash, password_salt FROM dashboard_auth WHERE id = 1`);
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: "Dashboard password belum dibuat." });
    }
    const valid = verifyDashboardPassword(
      parsed.data.old_password,
      rows[0].password_hash,
      rows[0].password_salt
    );
    if (!valid) {
      return res.status(401).json({ success: false, message: "Password lama salah." });
    }

    const { hash, salt } = hashDashboardPassword(parsed.data.new_password);
    await pool.query(
      `UPDATE dashboard_auth SET password_hash = $1, password_salt = $2, updated_at = NOW() WHERE id = 1`,
      [hash, salt]
    );
    // Invalidate all existing sessions so other logged-in devices must re-auth.
    await pool.query(`DELETE FROM dashboard_sessions`);

    res.json({ success: true, message: "Password berhasil diubah. Silakan login ulang." });
  } catch (err) {
    next(err);
  }
});
