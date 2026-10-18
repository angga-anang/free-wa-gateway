import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { enqueueMessage } from "../queue/messageQueue";
import { queueMessage } from "../services/messageService";

export const messagesRouter = Router();

const sendMessageSchema = z.object({
  instance_id: z.string().uuid(),
  recipient: z.string().min(6).max(20),
  type: z.enum(["text", "image", "document", "video"]),
  content: z.record(z.any()),
});

// 4.1 POST /api/v1/messages/send
messagesRouter.post("/send", async (req, res, next) => {
  try {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.message });
    }
    const { instance_id, recipient, type, content } = parsed.data;

    const device = await pool.query(`SELECT id, status FROM devices WHERE id = $1`, [
      instance_id,
    ]);
    if (device.rowCount === 0) {
      return res.status(404).json({ success: false, message: "instance_id not found" });
    }

    const { messageLogId, jobId } = await queueMessage({
      deviceId: instance_id,
      recipient,
      type,
      content,
    });

    // F-BE-201: 202 Accepted with tracking Job ID
    res.status(202).json({
      success: true,
      message: "Message successfully accepted into the routing queue.",
      data: {
        job_id: jobId,
        message_id: messageLogId,
        status: "QUEUE",
      },
    });
  } catch (err) {
    next(err);
  }
});

// 3.3 Message Logs — multivariant filtering
messagesRouter.get("/logs", async (req, res, next) => {
  try {
    const { device_id, status, type, recipient, start, end, page = "1", limit = "25" } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];

    if (device_id) {
      params.push(device_id);
      conditions.push(`device_id = $${params.length}`);
    }
    if (status) {
      params.push(String(status).toUpperCase());
      conditions.push(`status = $${params.length}`);
    }
    if (type) {
      params.push(String(type).toUpperCase());
      conditions.push(`message_type = $${params.length}`);
    }
    if (recipient) {
      params.push(`%${recipient}%`);
      conditions.push(`recipient ILIKE $${params.length}`);
    }
    if (start) {
      params.push(start);
      conditions.push(`timestamp >= $${params.length}`);
    }
    if (end) {
      params.push(end);
      conditions.push(`timestamp <= $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 25));
    const offset = (pageNum - 1) * limitNum;

    params.push(limitNum, offset);
    const { rows } = await pool.query(
      `SELECT ml.id, ml.device_id, d.name AS device_name, ml.recipient, ml.message_type,
              ml.payload, ml.status, ml.error_log, ml.attempts, ml.timestamp
       FROM message_logs ml
       LEFT JOIN devices d ON d.id = ml.device_id
       ${where}
       ORDER BY ml.timestamp DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM message_logs ml ${where}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      success: true,
      data: rows,
      pagination: { page: pageNum, limit: limitNum, total: countResult.rows[0].total },
    });
  } catch (err) {
    next(err);
  }
});

// Instant Outbox Resend — retry a FAILED message
messagesRouter.post("/logs/:id/resend", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM message_logs WHERE id = $1`, [
      req.params.id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Message log not found" });
    }
    const log = rows[0];
    if (log.status !== "FAILED") {
      return res
        .status(400)
        .json({ success: false, message: "Only FAILED messages can be resent." });
    }

    const { type, content } = log.payload;
    await pool.query(
      `UPDATE message_logs SET status = 'QUEUE', attempts = 0, error_log = NULL WHERE id = $1`,
      [log.id]
    );

    const job = await enqueueMessage({
      messageLogId: log.id,
      deviceId: log.device_id,
      recipient: log.recipient,
      type,
      content,
    });

    res.status(202).json({ success: true, message: "Message re-queued.", data: { job_id: job.id } });
  } catch (err) {
    next(err);
  }
});
