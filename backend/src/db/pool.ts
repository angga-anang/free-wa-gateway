import { Pool } from "pg";
import { env } from "../config/env";

export const pool = new Pool({
  connectionString: env.databaseUrl,
});

// Force every connection's session time zone to UTC. This matters even
// though timestamp columns are TIMESTAMPTZ (which store an unambiguous
// absolute instant): `CURRENT_TIMESTAMP` and friends are still evaluated
// in the session's time zone before being converted, and — more
// importantly — this guarantees consistent behavior regardless of what
// time zone the Postgres server/container/host happens to be configured
// with (which we don't control and shouldn't have to rely on). Without
// this, a server whose OS time zone isn't UTC could otherwise produce
// systematically wrong timestamps that only show up as a mismatch on the
// dashboard.
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'UTC'").catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to set session time zone to UTC", err);
  });
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("Unexpected PostgreSQL pool error", err);
});
