import fs from "fs";
import path from "path";
import { pool } from "./pool";
import { logger } from "../lib/logger";

async function migrate() {
  const schemaPath = path.join(__dirname, "..", "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  logger.info("Running database migration...");
  await pool.query(sql);
  logger.info("Migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  logger.error({ err }, "Migration failed");
  process.exit(1);
});
