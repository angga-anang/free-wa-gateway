import { Router } from "express";
import { z } from "zod";
import { getDelayConfig, setDelayConfig } from "../lib/gatewaySettings";

export const gatewaySettingsRouter = Router();

gatewaySettingsRouter.get("/delay", (_req, res) => {
  res.json({ success: true, data: getDelayConfig() });
});

const setDelaySchema = z.object({
  minSendDelayMs: z.number().int().optional(),
  maxSendDelayMs: z.number().int().optional(),
});

gatewaySettingsRouter.put("/delay", async (req, res, next) => {
  try {
    const parsed = setDelaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.message });
    }
    const updated = await setDelayConfig(parsed.data);
    res.json({ success: true, message: "Pengaturan jeda berhasil diperbarui.", data: updated });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message ?? "Gagal memperbarui pengaturan." });
  }
});

// Server's detected timezone, so the dashboard can offer "ikuti zona waktu
// server" as an explicit display option alongside "otomatis (browser)".
gatewaySettingsRouter.get("/server-timezone", (_req, res) => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  res.json({ success: true, data: { timeZone, serverTime: new Date().toISOString() } });
});
