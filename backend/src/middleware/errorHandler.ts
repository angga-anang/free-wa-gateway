import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  logger.error({ err, path: req.path }, "Unhandled error");
  if (res.headersSent) return;
  res.status(err.status ?? 500).json({
    success: false,
    message: err.message ?? "Internal server error",
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
}
