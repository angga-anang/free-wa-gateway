import crypto from "crypto";
import { env } from "../config/env";

// NFR-BE-501: Advanced Cryptographic Security at Rest.
// auth_secret must never be stored in cleartext. We use AES-256-GCM with a
// key derived from MASTER_KEY (64 hex chars = 32 bytes), which itself must
// live only in the environment, never in the DB or logs.

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const key = Buffer.from(env.masterKey, "hex");
  if (key.length !== 32) {
    throw new Error(
      "MASTER_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM"
    );
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // store as iv:authTag:ciphertext (base64)
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(
    ":"
  );
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted payload");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

// API key generation/verification (F-BE-301). Keys are only ever shown once
// at creation time; the DB stores a SHA-256 hash, never the raw key.
//
// `customKey`, when provided, is used verbatim instead of generating a new
// random key — this lets an existing key from a legacy gateway (e.g. a
// hardcoded UUID an old app can't be changed to stop using) be registered
// as-is in FREE GW, so migration requires changing only the Base URL.
//
// `format: "uuid"` generates a fresh random key in UUID shape
// (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) instead of the default
// `fgw_live_...` shape — some legacy apps validate the key's *format*
// client-side (not a specific value), so a UUID-shaped key alone is enough
// to satisfy them without needing to know any specific old key value.
export function generateApiKey(
  customKey?: string,
  format: "default" | "uuid" = "default"
): { rawKey: string; prefix: string; hash: string } {
  let rawKey: string;
  if (customKey && customKey.trim().length > 0) {
    rawKey = customKey.trim();
  } else if (format === "uuid") {
    rawKey = crypto.randomUUID();
  } else {
    rawKey = `fgw_live_${crypto.randomBytes(24).toString("hex")}`;
  }
  const prefix = rawKey.slice(0, 16);
  const hash = hashApiKey(rawKey);
  return { rawKey, prefix, hash };
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// ---- Dashboard login password (separate from API keys — protects the
// human-facing UI, not the machine-facing REST API) ----

export function hashDashboardPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyDashboardPassword(password: string, hash: string, salt: string): boolean {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// Dashboard session tokens: same pattern as API keys — the raw token is
// shown/stored client-side once, only its SHA-256 hash lives in the DB.
export function generateSessionToken(): { rawToken: string; hash: string } {
  const rawToken = crypto.randomBytes(32).toString("hex");
  return { rawToken, hash: crypto.createHash("sha256").update(rawToken).digest("hex") };
}

export function hashSessionToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}
