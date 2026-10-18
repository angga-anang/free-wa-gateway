import { Router } from "express";
import { pool } from "../db/pool";

export const dashboardRouter = Router();

// System Metrics Callouts: Total Sent, Queue, Success/Failed Rate
dashboardRouter.get("/summary", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ')) AS total_sent,
        COUNT(*) FILTER (WHERE status IN ('PENDING','QUEUE')) AS in_queue,
        COUNT(*) FILTER (WHERE status = 'FAILED') AS total_failed,
        COUNT(*) AS total_all
      FROM message_logs
    `);
    const r = rows[0];
    const totalAll = parseInt(r.total_all, 10) || 0;
    const totalSent = parseInt(r.total_sent, 10) || 0;
    const totalFailed = parseInt(r.total_failed, 10) || 0;

    const successRate = totalAll > 0 ? (totalSent / totalAll) * 100 : 0;
    const failedRate = totalAll > 0 ? (totalFailed / totalAll) * 100 : 0;

    res.json({
      success: true,
      data: {
        total_sent: totalSent,
        in_queue: parseInt(r.in_queue, 10) || 0,
        total_failed: totalFailed,
        success_rate: Math.round(successRate * 100) / 100,
        failed_rate: Math.round(failedRate * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Instance Status Matrix: Connected vs Disconnected
dashboardRouter.get("/instances-status", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT status, COUNT(*)::int AS count FROM devices GROUP BY status
    `);
    const matrix = { CONNECTED: 0, DISCONNECTED: 0, INITIALIZING: 0, FAILED: 0 } as Record<
      string,
      number
    >;
    for (const row of rows) matrix[row.status] = row.count;
    res.json({ success: true, data: matrix });
  } catch (err) {
    next(err);
  }
});

// Volume Analytics Chart: message volume over a configurable horizon
dashboardRouter.get("/volume", async (req, res, next) => {
  try {
    const granularity = (req.query.granularity as string) ?? "hour"; // hour | day | week
    const bucket =
      granularity === "day" ? "day" : granularity === "week" ? "week" : "hour";

    const { rows } = await pool.query(
      `SELECT date_trunc($1, timestamp) AS bucket,
              COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ')) AS sent,
              COUNT(*) FILTER (WHERE status = 'FAILED') AS failed
       FROM message_logs
       WHERE timestamp > NOW() - INTERVAL '7 days'
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [bucket]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Recent Activity Feed
dashboardRouter.get("/recent-activity", async (req, res, next) => {
  try {
    const limit = Math.min(20, parseInt(String(req.query.limit ?? "10"), 10) || 10);
    const { rows } = await pool.query(
      `SELECT ml.id, ml.recipient, ml.message_type, ml.status, ml.timestamp, d.name AS device_name
       FROM message_logs ml
       LEFT JOIN devices d ON d.id = ml.device_id
       ORDER BY ml.timestamp DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});
