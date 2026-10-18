import { Queue, Worker, Job } from "bullmq";
import { redisConnection } from "./redis";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { logger } from "../lib/logger";
import { instanceManager } from "../whatsapp/instanceManager";
import { enqueueWebhookEvent } from "./webhookQueue";
import { getDelayConfig } from "../lib/gatewaySettings";

export interface SendMessageJobData {
  messageLogId: string;
  deviceId: string;
  recipient: string;
  type: "text" | "image" | "document" | "video";
  content: Record<string, any>;
}

// F-BE-201: Asynchronous Queue Ingestion — inbound payloads go straight into
// a Redis-backed queue; the API returns 202 Accepted immediately.
export const messageQueue = new Queue<SendMessageJobData>("message-send", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: env.maxSendRetries,
    // F-BE-203: exponential backoff retry policy for transient failures
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 5000 },
  },
});

// F-BE-202: Humanized delivery delay, enforced *per active session* (device),
// so messages from the same device are dispatched strictly FIFO with a
// randomized gap, while different devices may send concurrently.
const lastSendAt = new Map<string, number>();
const deviceLocks = new Map<string, Promise<void>>();

function randomDelay(): number {
  const { minSendDelayMs, maxSendDelayMs } = getDelayConfig();
  return Math.floor(Math.random() * (maxSendDelayMs - minSendDelayMs + 1)) + minSendDelayMs;
}

async function withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = deviceLocks.get(deviceId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  deviceLocks.set(
    deviceId,
    previous.then(() => next)
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function updateLog(id: string, fields: Record<string, any>) {
  const keys = Object.keys(fields);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(
    `UPDATE message_logs SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])]
  );
}

async function processJob(job: Job<SendMessageJobData>) {
  const { messageLogId, deviceId, recipient, type, content } = job.data;

  return withDeviceLock(deviceId, async () => {
    // Enforce randomized humanized delay since the previous send on this device
    const last = lastSendAt.get(deviceId) ?? 0;
    const elapsed = Date.now() - last;
    const targetDelay = randomDelay();
    if (elapsed < targetDelay) {
      await new Promise((r) => setTimeout(r, targetDelay - elapsed));
    }

    await updateLog(messageLogId, { status: "QUEUE", attempts: job.attemptsMade + 1 });

    try {
      const waMessageId = await instanceManager.sendMessage(deviceId, recipient, type, content);
      lastSendAt.set(deviceId, Date.now());

      await updateLog(messageLogId, {
        status: "SENT",
        wa_message_id: waMessageId,
        error_log: null,
      });

      await enqueueWebhookEvent("message.sent", {
        message_id: messageLogId,
        instance_id: deviceId,
        recipient,
        status: "SENT",
      });

      return waMessageId;
    } catch (err: any) {
      lastSendAt.set(deviceId, Date.now());
      logger.warn({ err, deviceId, recipient }, "Message send attempt failed");

      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? env.maxSendRetries);
      if (isFinalAttempt) {
        await updateLog(messageLogId, {
          status: "FAILED",
          error_log: err?.message ?? String(err),
        });
        await enqueueWebhookEvent("message.failed", {
          message_id: messageLogId,
          instance_id: deviceId,
          recipient,
          status: "FAILED",
          error: err?.message ?? String(err),
        });
      }
      // Re-throw so BullMQ applies exponential backoff and retries (F-BE-203)
      throw err;
    }
  });
}

let worker: Worker<SendMessageJobData> | null = null;

export function startMessageWorker() {
  worker = new Worker<SendMessageJobData>("message-send", processJob, {
    connection: redisConnection,
    concurrency: 10, // parallel across devices; serialized per-device via withDeviceLock
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "message-send job failed permanently or retrying");
  });

  logger.info("Message worker started");
  return worker;
}

export async function enqueueMessage(data: SendMessageJobData) {
  // BullMQ stores job data as JSON in Redis. A real Buffer survives
  // JSON.stringify as {"type":"Buffer","data":[...]}, which is NOT a
  // Buffer instance anymore once the worker reads it back — so any
  // `instanceof Buffer` check downstream would silently fail. Convert to
  // base64 here (a plain string round-trips through JSON perfectly) and
  // reconstruct the real Buffer in instanceManager.sendMessage().
  let content = data.content;
  if (content?.buffer instanceof Buffer) {
    content = { ...content, buffer: undefined, bufferBase64: content.buffer.toString("base64") };
  }

  const job = await messageQueue.add("send", { ...data, content }, { jobId: data.messageLogId });
  return job;
}
