import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../db/pool";
import { compatAuth, resolveCompatDevice } from "../middleware/compatAuth";
import { instanceManager } from "../whatsapp/instanceManager";
import { queueMessage } from "../services/messageService";
import { logger } from "../lib/logger";
import { toJid } from "../lib/phone";

// Mounted directly at the app root (not under /api/v1) so existing
// integrations work by changing only the base URL + key, e.g.
//   OLD: https://gw.dius.my.id/send-message   (header: x-api-key)
//   NEW: https://your-freegw-host/send-message (same header, same body)
export const compatRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// NOTE: compatAuth is attached to each route individually below, NOT via a
// blanket `compatRouter.use(compatAuth)`. This router is mounted at the
// app root ("/") so legacy integrations can hit e.g. /send-message
// directly — but that also means EVERY request that doesn't match an
// earlier route (dashboard frontend files, /api/v1/*, etc.) falls through
// to this router. A blanket `.use(compatAuth)` middleware runs for every
// request that reaches the router, even ones with no matching route below
// it (Express still executes router-level `.use()` middleware before it
// gives up and 404s) — so any stray path (e.g. a tunnel/browser hitting
// "/login" instead of "/login.html") got intercepted here and rejected
// with a confusing "Header x-api-key wajib disertakan" error instead of a
// clean 404 or a chance to reach the real frontend/login route. Requiring
// compatAuth per-route means unmatched paths now correctly fall through to
// notFoundHandler in app.ts.

function guessMediaType(nameOrMime: string): "image" | "document" | "video" {
  const s = nameOrMime.toLowerCase();
  if (/\.(jpe?g|png|gif|webp)(\?|$)/.test(s) || s.startsWith("image/")) return "image";
  if (/\.(mp4|mov|mkv|webm)(\?|$)/.test(s) || s.startsWith("video/")) return "video";
  return "document";
}

// Used when a legacy request doesn't include a fileName — a bare "file"
// with no extension shows up in WhatsApp as a generic, unlabeled
// attachment. Deriving at least the right extension from the mimetype
// gives a more sensible display name (e.g. "dokumen.pdf" instead of
// "file"). For a truly meaningful name (e.g. the actual document title),
// the calling app must send the "fileName" field itself — this is only a
// fallback for when it doesn't.
const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/zip": "zip",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

function defaultFileName(mimetype?: string): string {
  const ext = mimetype ? MIME_EXTENSIONS[mimetype.toLowerCase()] : undefined;
  return ext ? `dokumen.${ext}` : "file";
}

// Different legacy gateways (and apps built against them) use slightly
// different field names for the same thing. Accept the common variants
// instead of forcing every integration to match one exact spelling.
function pickAlias(body: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = body?.[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

function normalizeJid(msisdn: string): string {
  return toJid(msisdn);
}

// ---------------------------------------------------------------
// [1] GET /status
// ---------------------------------------------------------------
compatRouter.get("/status", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const info = instanceManager.getConnectionInfo(req.compatDeviceId!);
    if (!info || info.status !== "CONNECTED") {
      return res.json({ success: true, status: "disconnected" });
    }
    res.json({
      success: true,
      status: "connected",
      device: { phone: info.phone, name: info.name, platform: "multi-device" },
      uptime: info.uptimeSeconds,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [2] POST /send-message
// ---------------------------------------------------------------
const sendMessageSchema = z.object({
  number: z.string().min(6),
  message: z.string().min(1),
});

compatRouter.post("/send-message", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Field "number" dan "message" wajib diisi.' });
    }
    await queueMessage({
      deviceId: req.compatDeviceId!,
      recipient: parsed.data.number,
      type: "text",
      content: { text: parsed.data.message },
    });
    res.json({
      success: true,
      message: "Pesan masuk antrean pengiriman.",
      to: normalizeJid(parsed.data.number),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [3] POST /send-button — WhatsApp multi-device no longer supports
// interactive button messages reliably, so we degrade gracefully to plain
// text (message + numbered options) instead of silently failing.
// ---------------------------------------------------------------
const sendButtonSchema = z.object({
  number: z.string().min(6),
  message: z.string().min(1),
  buttons: z.array(z.string()).optional(),
  footer: z.string().optional(),
});

compatRouter.post("/send-button", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const parsed = sendButtonSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Field "number" dan "message" wajib diisi.' });
    }
    const lines = [parsed.data.message];
    if (parsed.data.buttons?.length) {
      lines.push("", ...parsed.data.buttons.map((b, i) => `${i + 1}. ${b}`));
    }
    if (parsed.data.footer) lines.push("", `_${parsed.data.footer}_`);

    await queueMessage({
      deviceId: req.compatDeviceId!,
      recipient: parsed.data.number,
      type: "text",
      content: { text: lines.join("\n") },
    });
    res.json({
      success: true,
      message:
        "Tombol interaktif tidak didukung WhatsApp multi-device saat ini — dikirim sebagai teks biasa dengan opsi bernomor.",
      to: normalizeJid(parsed.data.number),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [4] POST /send-media
// ---------------------------------------------------------------
const sendMediaSchema = z.object({
  number: z.string().min(6),
  url: z.string().url(),
  caption: z.string().optional(),
});

compatRouter.post("/send-media", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const parsed = sendMediaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Field "number" dan "url" wajib diisi.' });
    }
    const type = guessMediaType(parsed.data.url);
    await queueMessage({
      deviceId: req.compatDeviceId!,
      recipient: parsed.data.number,
      type,
      content: {
        url: parsed.data.url,
        caption: parsed.data.caption,
        fileName: parsed.data.url.split("/").pop(),
      },
    });
    res.json({ success: true, message: "Media masuk antrean pengiriman.", to: normalizeJid(parsed.data.number) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [5] POST /send-bulk
// ---------------------------------------------------------------
const sendBulkSchema = z.object({
  data: z
    .array(z.object({ number: z.string().min(6), msg: z.string().min(1) }))
    .min(1)
    .max(500),
  // Accepted for backward compatibility with the old contract; FREE GW's
  // queue already applies its own randomized 2-5s per-device delay
  // (F-BE-202), so these are informational only and don't change pacing.
  delay: z.number().optional(),
  random_delay: z.boolean().optional(),
});

compatRouter.post("/send-bulk", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const parsed = sendBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Field "data" (array) wajib diisi.' });
    }
    const queued: Array<{ to: string; job_id: string }> = [];
    for (const item of parsed.data.data) {
      const { jobId } = await queueMessage({
        deviceId: req.compatDeviceId!,
        recipient: item.number,
        type: "text",
        content: { text: item.msg },
      });
      queued.push({ to: normalizeJid(item.number), job_id: String(jobId) });
    }
    res.json({
      success: true,
      message: `${queued.length} pesan masuk antrean pengiriman (jeda otomatis oleh FREE GW).`,
      data: queued,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [6] POST /validate-number
// ---------------------------------------------------------------
const validateNumberSchema = z.object({ number: z.string().min(6) });

compatRouter.post("/validate-number", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const parsed = validateNumberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Field "number" wajib diisi.' });
    }
    const result = await instanceManager.checkNumberExists(req.compatDeviceId!, parsed.data.number);
    res.json({ success: true, exists: result.exists, jid: result.jid });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [7] GET /groups
// ---------------------------------------------------------------
compatRouter.get("/groups", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const groups = await instanceManager.listGroups(req.compatDeviceId!);
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [8] POST /set-webhook
// ---------------------------------------------------------------
const setWebhookSchema = z.object({ url: z.string().url() });

compatRouter.post("/set-webhook", compatAuth, async (req, res, next) => {
  try {
    const parsed = setWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Field "url" wajib diisi dan harus URL valid.' });
    }
    await pool.query(`UPDATE api_configs SET webhook_url = $1 WHERE id = $2`, [
      parsed.data.url,
      req.compatApiConfig!.id,
    ]);
    res.json({ success: true, message: "Webhook berhasil diperbarui." });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [9] POST /send-file — multipart/form-data
// ---------------------------------------------------------------
compatRouter.post("/send-file", compatAuth, resolveCompatDevice, upload.single("file"), async (req, res, next) => {
  try {
    const number = pickAlias(req.body, "number", "phone", "to", "msisdn");
    if (!number || !req.file) {
      logger.warn(
        { bodyKeys: Object.keys(req.body ?? {}), hasFile: !!req.file },
        "Legacy /send-file request missing number or file — check field names against what the caller actually sends"
      );
      return res.status(400).json({ success: false, message: 'Field "number" dan file "file" wajib diisi.' });
    }
    const fileName = pickAlias(req.body, "fileName", "filename", "file_name", "name", "document_name") || req.file.originalname;
    const type = guessMediaType(fileName || req.file.mimetype || "");
    await queueMessage({
      deviceId: req.compatDeviceId!,
      recipient: number,
      type,
      content: {
        buffer: req.file.buffer,
        caption: pickAlias(req.body, "caption", "message", "text"),
        fileName,
        mimetype: req.file.mimetype,
      },
    });
    res.json({ success: true, message: "File masuk antrean pengiriman.", to: normalizeJid(number) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [10] POST /send-base64
// ---------------------------------------------------------------
const sendBase64Schema = z.object({
  number: z.string().min(6),
  base64: z.string().min(1),
  mimetype: z.string().optional(),
  caption: z.string().optional(),
});

compatRouter.post("/send-base64", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    const parsed = sendBase64Schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Field "number" dan "base64" wajib diisi.' });
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(parsed.data.base64, "base64");
    } catch {
      return res.status(400).json({ success: false, message: "String base64 tidak valid." });
    }
    const fileName = pickAlias(req.body, "fileName", "filename", "file_name", "name", "document_name", "docName", "title");
    if (!fileName) {
      logger.info(
        { bodyKeysExcludingBase64: Object.keys(req.body ?? {}).filter((k) => k !== "base64") },
        'Legacy /send-base64 request has no recognized filename field — sending with a generic fallback name. If the caller does send a name under a different key, check this field list and tell FREE GW\'s maintainer so it can be added as an alias.'
      );
    }
    const type = guessMediaType(parsed.data.mimetype || fileName || "");
    await queueMessage({
      deviceId: req.compatDeviceId!,
      recipient: parsed.data.number,
      type,
      content: {
        buffer,
        caption: parsed.data.caption,
        fileName: fileName ?? defaultFileName(parsed.data.mimetype),
        mimetype: parsed.data.mimetype ?? "application/octet-stream",
      },
    });
    res.json({ success: true, message: "File masuk antrean pengiriman.", to: normalizeJid(parsed.data.number) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// [11] POST /device/reset
// ---------------------------------------------------------------
compatRouter.post("/device/reset", compatAuth, resolveCompatDevice, async (req, res, next) => {
  try {
    await instanceManager.logoutDevice(req.compatDeviceId!);
    res.json({ success: true, message: "Perangkat berhasil di-logout. Pindai ulang QR untuk menyambungkan." });
  } catch (err) {
    next(err);
  }
});
