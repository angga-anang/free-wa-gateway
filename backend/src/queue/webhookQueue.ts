import { Queue, Worker, Job } from "bullmq";
import { redisConnection } from "./redis";
import { pool } from "../db/pool";
import { logger } from "../lib/logger";

interface WebhookJobData {
  event: string;
  data: Record<string, any>;
}

// F-BE-402: Asynchronous Event Notification Pipeline.
export const webhookQueue = new Queue<WebhookJobData>("webhook-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 5000 },
  },
});

export async function enqueueWebhookEvent(event: string, data: Record<string, any>) {
  // Fan out to every active webhook subscriber registered in api_configs.
  const { rows } = await pool.query(
    `SELECT id, webhook_url FROM api_configs WHERE is_active = TRUE AND webhook_url IS NOT NULL AND webhook_url <> ''`
  );

  for (const row of rows) {
    await webhookQueue.add(
      "dispatch",
      { event, data: { ...data, apiConfigId: row.id, targetUrl: row.webhook_url } },
      {}
    );
  }
}

async function processWebhookJob(job: Job<WebhookJobData>) {
  const { event, data } = job.data;
  const { targetUrl, apiConfigId, ...payloadData } = data;

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data: payloadData,
  };

  const deliveryInsert = await pool.query(
    `INSERT INTO webhook_deliveries (api_config_id, event, payload, target_url, status, attempts)
     VALUES ($1, $2, $3, $4, 'PENDING', $5) RETURNING id`,
    [apiConfigId, event, JSON.stringify(payload), targetUrl, job.attemptsMade + 1]
  );
  const deliveryId = deliveryInsert.rows[0].id;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    await pool.query(
      `UPDATE webhook_deliveries SET status = $1, response_code = $2, attempts = $3 WHERE id = $4`,
      [res.ok ? "SENT" : "FAILED", res.status, job.attemptsMade + 1, deliveryId]
    );

    if (!res.ok) {
      // Non-200 responses automatically queue for retry back-off (F-BE-402)
      throw new Error(`Webhook target responded with HTTP ${res.status}`);
    }
  } catch (err: any) {
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'FAILED', attempts = $1 WHERE id = $2`,
      [job.attemptsMade + 1, deliveryId]
    );
    logger.warn({ err, targetUrl, event }, "Webhook delivery attempt failed");
    throw err;
  }
}

let worker: Worker<WebhookJobData> | null = null;

export function startWebhookWorker() {
  worker = new Worker<WebhookJobData>("webhook-dispatch", processWebhookJob, {
    connection: redisConnection,
    concurrency: 20,
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "webhook-dispatch job failed permanently or retrying");
  });

  logger.info("Webhook worker started");
  return worker;
}
