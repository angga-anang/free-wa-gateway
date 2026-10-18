import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { instanceEvents, instanceManager } from "../whatsapp/instanceManager";
import { logger } from "../lib/logger";

// F-BE-101: streams reactive QR string/image formats via WebSocket pools to
// the calling UI layer, keyed by device (instance) ID:
//   ws://<host>/ws/devices/:deviceId
export function attachQrWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws/devices" });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const deviceId = url.searchParams.get("deviceId");

    if (!deviceId) {
      ws.send(JSON.stringify({ event: "error", message: "deviceId query param required" }));
      ws.close();
      return;
    }

    logger.debug({ deviceId }, "WebSocket client subscribed to device events");

    const onQr = (qrDataUrl: string) => {
      ws.send(JSON.stringify({ event: "qr", deviceId, qr: qrDataUrl }));
    };
    const onStatus = (status: string) => {
      ws.send(JSON.stringify({ event: "status", deviceId, status }));
    };

    instanceEvents.on(`qr:${deviceId}`, onQr);
    instanceEvents.on(`status:${deviceId}`, onStatus);

    // Send current known status immediately on connect
    ws.send(
      JSON.stringify({ event: "status", deviceId, status: instanceManager.getStatus(deviceId) })
    );

    ws.on("close", () => {
      instanceEvents.off(`qr:${deviceId}`, onQr);
      instanceEvents.off(`status:${deviceId}`, onStatus);
    });
  });

  logger.info("QR/status WebSocket server attached at /ws/devices");
  return wss;
}
