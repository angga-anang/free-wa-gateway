import { pool } from "../db/pool";
import { enqueueMessage } from "../queue/messageQueue";

export type MessageType = "text" | "image" | "document" | "video";

interface QueueMessageInput {
  deviceId: string;
  recipient: string;
  type: MessageType;
  content: Record<string, any>;
}

// Inserts the audit row (message_logs) and pushes the job onto the same
// BullMQ queue used by POST /api/v1/messages/send — reused by the
// legacy-compat routes so both APIs share identical delivery behavior
// (humanized delay, retry/backoff, webhook events) and both show up
// together in the dashboard's Riwayat Pesan.
export async function queueMessage(input: QueueMessageInput) {
  const { deviceId, recipient, type, content } = input;
  const messageType = type.toUpperCase();

  const logInsert = await pool.query(
    `INSERT INTO message_logs (device_id, recipient, message_type, payload, status)
     VALUES ($1, $2, $3, $4, 'QUEUE') RETURNING id`,
    [deviceId, recipient, messageType, JSON.stringify({ type, content: sanitizeForLog(content) })]
  );
  const messageLogId = logInsert.rows[0].id;

  const job = await enqueueMessage({ messageLogId, deviceId, recipient, type, content });

  await pool.query(`UPDATE message_logs SET job_id = $1 WHERE id = $2`, [job.id, messageLogId]);

  return { messageLogId, jobId: job.id };
}

// Buffers can be large/binary — don't persist raw file bytes into the JSONB
// payload column (message_logs is meant for audit/history, not blob storage).
function sanitizeForLog(content: Record<string, any>) {
  if (content?.buffer instanceof Buffer) {
    return { ...content, buffer: `<binary ${content.buffer.length} bytes, not stored>` };
  }
  return content;
}
