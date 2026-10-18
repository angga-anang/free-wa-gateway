import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool";
import { instanceManager } from "../whatsapp/instanceManager";

export const devicesRouter = Router();

const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(255).optional(),
});

// List all devices (Device Management module)
devicesRouter.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, phone_number, status, last_seen_at, created_at
       FROM devices ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

devicesRouter.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, phone_number, status, last_seen_at, created_at
       FROM devices WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Instance Provisioning: register a new logical client container
devicesRouter.post("/", async (req, res, next) => {
  try {
    const parsed = createDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.message });
    }
    const { name, description } = parsed.data;
    const { rows } = await pool.query(
      `INSERT INTO devices (name, description, status) VALUES ($1, $2, 'DISCONNECTED')
       RETURNING id, name, description, status, created_at`,
      [name, description ?? null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// F-BE-103: Initialize — kicks off QR handshake; client should then open
// ws://<host>/ws/devices?deviceId=<id> to receive the QR + status stream.
devicesRouter.post("/:id/initialize", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id FROM devices WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }
    instanceManager.initializeDevice(req.params.id).catch(() => undefined);
    res.status(202).json({
      success: true,
      message: "Initialization started. Connect to the WebSocket endpoint to receive the QR code.",
      data: { ws_url: `/ws/devices?deviceId=${req.params.id}` },
    });
  } catch (err) {
    next(err);
  }
});

// F-BE-103: Disconnect / Logout
devicesRouter.post("/:id/logout", async (req, res, next) => {
  try {
    await instanceManager.logoutDevice(req.params.id);
    res.json({ success: true, message: "Device logged out and session cleared." });
  } catch (err) {
    next(err);
  }
});

// F-BE-103: Restart Engine
devicesRouter.post("/:id/restart", async (req, res, next) => {
  try {
    instanceManager.restartDevice(req.params.id).catch(() => undefined);
    res.status(202).json({ success: true, message: "Restart initiated." });
  } catch (err) {
    next(err);
  }
});

// F-BE-103: Check Instance Status (live, in-memory)
devicesRouter.get("/:id/status", async (req, res, next) => {
  try {
    const liveStatus = instanceManager.getStatus(req.params.id);
    const { rows } = await pool.query(`SELECT status FROM devices WHERE id = $1`, [
      req.params.id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }
    res.json({
      success: true,
      data: { persisted_status: rows[0].status, live_status: liveStatus },
    });
  } catch (err) {
    next(err);
  }
});

// Purge Instance Data
devicesRouter.delete("/:id", async (req, res, next) => {
  try {
    await instanceManager.logoutDevice(req.params.id).catch(() => undefined);
    await pool.query(`DELETE FROM devices WHERE id = $1`, [req.params.id]);
    res.json({ success: true, message: "Device purged." });
  } catch (err) {
    next(err);
  }
});
