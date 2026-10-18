import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { EventEmitter } from "events";
import QRCode from "qrcode";
import { pool } from "../db/pool";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { useDbAuthState, clearAuthState } from "./authStore";
import { enqueueWebhookEvent } from "../queue/webhookQueue";
import { toJid, normalizeMsisdn } from "../lib/phone";

type DeviceStatus = "DISCONNECTED" | "INITIALIZING" | "CONNECTED" | "FAILED";

interface ActiveInstance {
  sock: WASocket;
  status: DeviceStatus;
  connectedAt: number | null;
}

// F-BE-101/103: emits `qr:<deviceId>` and `status:<deviceId>` events that the
// WebSocket layer (src/ws/qrSocket.ts) subscribes to and streams to clients.
export const instanceEvents = new EventEmitter();
instanceEvents.setMaxListeners(0);

class InstanceManager {
  private instances = new Map<string, ActiveInstance>();

  private async setStatus(deviceId: string, status: DeviceStatus, phoneNumber?: string) {
    await pool.query(
      `UPDATE devices SET status = $1, phone_number = COALESCE($2, phone_number),
       last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [status, phoneNumber ?? null, deviceId]
    );
    const inst = this.instances.get(deviceId);
    if (inst) inst.status = status;
    instanceEvents.emit(`status:${deviceId}`, status);

    if (status === "DISCONNECTED") {
      await enqueueWebhookEvent("instance.disconnected", { instance_id: deviceId });
    } else if (status === "CONNECTED") {
      await enqueueWebhookEvent("instance.status_changed", {
        instance_id: deviceId,
        status: "CONNECTED",
      });
    }
  }

  // F-BE-101: Multi-Device Authentication (QR Code via WebSockets)
  async initializeDevice(deviceId: string) {
    if (this.instances.has(deviceId)) {
      logger.warn({ deviceId }, "Instance already initializing/connected");
      return;
    }

    await this.setStatus(deviceId, "INITIALIZING");

    const { state, saveCreds } = await useDbAuthState(deviceId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // Caches signal keys in memory for speed; still persisted via authStore
        keys: makeCacheableSignalKeyStore(state.keys, undefined),
      },
      printQRInTerminal: false,
      syncFullHistory: false,
      // NFR-BE-502: Baileys itself is not a headless browser (unlike
      // whatsapp-web.js), so no --no-sandbox flags are needed here. When
      // swapping in a Puppeteer-based driver, launch args and container
      // process boundaries must be enforced there instead.
    });

    this.instances.set(deviceId, { sock, status: "INITIALIZING", connectedAt: null });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr);
        instanceEvents.emit(`qr:${deviceId}`, qrDataUrl);
      }

      if (connection === "open") {
        const phoneNumber = sock.user?.id?.split(":")[0];
        const inst = this.instances.get(deviceId);
        if (inst) inst.connectedAt = Date.now();
        await this.setStatus(deviceId, "CONNECTED", phoneNumber);
        logger.info({ deviceId, phoneNumber }, "WhatsApp instance connected");
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.instances.delete(deviceId);

        if (loggedOut) {
          await clearAuthState(deviceId);
          await this.setStatus(deviceId, "DISCONNECTED");
          logger.info({ deviceId }, "Instance logged out; auth cleared");
        } else {
          // NFR-BE-503: Connection Resiliency — attempt auto-healing reconnect
          await this.setStatus(deviceId, "DISCONNECTED");
          logger.warn({ deviceId, statusCode }, "Instance disconnected; scheduling reconnect");
          setTimeout(() => {
            this.initializeDevice(deviceId).catch((err) =>
              logger.error({ err, deviceId }, "Auto-reconnect failed")
            );
          }, env.socketHealthcheckIntervalMs);
        }
      }
    });

    // F-BE-401: Native Event Aggregator — message.received
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const text =
          msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";
        await enqueueWebhookEvent("message.received", {
          instance_id: deviceId,
          from: msg.key.remoteJid,
          message_id: msg.key.id,
          text,
          raw_type: Object.keys(msg.message ?? {})[0] ?? "unknown",
        });
      }
    });

    // F-BE-401: message.ack — delivery status modifications
    sock.ev.on("messages.update", async (updates) => {
      for (const u of updates) {
        const ackStatus = u.update.status;
        if (ackStatus === undefined) continue;
        const statusMap: Record<number, string> = {
          2: "SENT",
          3: "DELIVERED",
          4: "READ",
        };
        const mapped = statusMap[ackStatus as number];
        if (!mapped) continue;

        await pool.query(
          `UPDATE message_logs SET status = $1, updated_at = CURRENT_TIMESTAMP
           WHERE wa_message_id = $2 AND device_id = $3`,
          [mapped, u.key.id, deviceId]
        );

        await enqueueWebhookEvent(`message.${mapped.toLowerCase()}`, {
          message_id: u.key.id,
          instance_id: deviceId,
          recipient: u.key.remoteJid,
          status: mapped,
        });
      }
    });

    return sock;
  }

  // F-BE-103: Lifecycle Action Routing — Disconnect/Logout
  async logoutDevice(deviceId: string) {
    const inst = this.instances.get(deviceId);
    if (inst) {
      await inst.sock.logout().catch(() => undefined);
      this.instances.delete(deviceId);
    }
    await clearAuthState(deviceId);
    await this.setStatus(deviceId, "DISCONNECTED");
  }

  // F-BE-103: Restart Engine
  async restartDevice(deviceId: string) {
    const inst = this.instances.get(deviceId);
    if (inst) {
      inst.sock.end(undefined as any);
      this.instances.delete(deviceId);
    }
    await this.initializeDevice(deviceId);
  }

  // F-BE-103: Check Instance Status
  getStatus(deviceId: string): DeviceStatus | "UNKNOWN" {
    return this.instances.get(deviceId)?.status ?? "UNKNOWN";
  }

  isActive(deviceId: string) {
    return this.instances.has(deviceId);
  }

  // ---- Helpers used by the legacy-compat API layer (src/routes/compat.ts) ----

  getConnectionInfo(deviceId: string) {
    const inst = this.instances.get(deviceId);
    if (!inst) return null;
    return {
      status: inst.status,
      phone: inst.sock.user?.id?.split(":")[0] ?? null,
      name: inst.sock.user?.name ?? null,
      uptimeSeconds: inst.connectedAt ? Math.floor((Date.now() - inst.connectedAt) / 1000) : 0,
    };
  }

  async checkNumberExists(deviceId: string, msisdn: string): Promise<{ exists: boolean; jid: string | null }> {
    const inst = this.instances.get(deviceId);
    if (!inst || inst.status !== "CONNECTED") {
      throw new Error(`Device ${deviceId} is not connected`);
    }
    const [result] = (await inst.sock.onWhatsApp(normalizeMsisdn(msisdn))) ?? [];
    return { exists: !!result?.exists, jid: result?.jid ?? null };
  }

  async listGroups(deviceId: string): Promise<Array<{ id: string; subject: string }>> {
    const inst = this.instances.get(deviceId);
    if (!inst || inst.status !== "CONNECTED") {
      throw new Error(`Device ${deviceId} is not connected`);
    }
    const groups = await inst.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g: any) => ({ id: g.id, subject: g.subject }));
  }

  // Used by the message queue worker to actually dispatch via the live socket.
  async sendMessage(
    deviceId: string,
    recipient: string,
    type: "text" | "image" | "document" | "video",
    content: Record<string, any>
  ): Promise<string> {
    const inst = this.instances.get(deviceId);
    if (!inst || inst.status !== "CONNECTED") {
      throw new Error(`Device ${deviceId} is not connected`);
    }

    const jid = toJid(recipient);
    let result;

    // Media content can come from a public URL (content.url) or a raw
    // Buffer (content.buffer) — the latter is used by the legacy-compat
    // /send-file and /send-base64 endpoints, which receive the file data
    // directly rather than a hosted link. Baileys accepts either form.
    const mediaSource = (): { url: string } | Buffer => {
      // Reconstruct the Buffer from base64 (see enqueueMessage in
      // queue/messageQueue.ts for why raw Buffers can't survive the queue).
      if (typeof content.bufferBase64 === "string") return Buffer.from(content.bufferBase64, "base64");
      // Kept for any direct (non-queued) callers that might still pass a
      // real Buffer synchronously.
      if (content.buffer instanceof Buffer) return content.buffer;
      return { url: content.url };
    };

    switch (type) {
      case "text":
        result = await inst.sock.sendMessage(jid, { text: content.text });
        break;
      case "image":
        result = await inst.sock.sendMessage(jid, {
          image: mediaSource(),
          caption: content.caption,
        });
        break;
      case "document":
        result = await inst.sock.sendMessage(jid, {
          document: mediaSource(),
          fileName: content.fileName ?? "document.pdf",
          mimetype: content.mimetype ?? "application/pdf",
        });
        break;
      case "video":
        result = await inst.sock.sendMessage(jid, {
          video: mediaSource(),
          caption: content.caption,
        });
        break;
      default:
        throw new Error(`Unsupported message type: ${type}`);
    }

    if (!result?.key?.id) {
      throw new Error("Send did not return a message ID");
    }
    return result.key.id;
  }
}

export const instanceManager = new InstanceManager();
