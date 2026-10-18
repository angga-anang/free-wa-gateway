-- FREE GW — PostgreSQL schema
-- Mirrors section 3 of Stitch_WhatsApp_Gateway_Backend_PRD.md

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 3.1 devices (Instance Sessions)
CREATE TABLE IF NOT EXISTS devices (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(100) NOT NULL,
    description    VARCHAR(255),
    phone_number   VARCHAR(20),
    status         VARCHAR(30) NOT NULL DEFAULT 'DISCONNECTED'
                   CHECK (status IN ('DISCONNECTED','INITIALIZING','CONNECTED','FAILED')),
    auth_secret    TEXT,                     -- AES-256-GCM encrypted Baileys auth state (NFR-BE-501)
    last_seen_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3.2 message_logs (Audit History)
CREATE TABLE IF NOT EXISTS message_logs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    job_id         VARCHAR(100),
    recipient      VARCHAR(20) NOT NULL,
    message_type   VARCHAR(20) NOT NULL DEFAULT 'TEXT'
                   CHECK (message_type IN ('TEXT','IMAGE','DOCUMENT','VIDEO')),
    payload        JSONB NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','QUEUE','SENT','DELIVERED','READ','FAILED')),
    error_log      TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    wa_message_id  VARCHAR(100),
    timestamp      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_logs_device_id ON message_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_status ON message_logs(status);
CREATE INDEX IF NOT EXISTS idx_message_logs_timestamp ON message_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_message_logs_recipient ON message_logs(recipient);

-- 3.3 api_configs (Security Registry)
CREATE TABLE IF NOT EXISTS api_configs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label          VARCHAR(100) NOT NULL DEFAULT 'Default Key',
    api_key_hash   VARCHAR(255) NOT NULL UNIQUE,
    key_prefix     VARCHAR(20) NOT NULL,   -- shown in UI, e.g. fgw_live_83hf928h
    webhook_url    VARCHAR(255),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    default_device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at     TIMESTAMPTZ
);

-- Webhook delivery audit (supports the Webhook Event Dispatcher, F-BE-401/402)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_config_id  UUID REFERENCES api_configs(id) ON DELETE CASCADE,
    event          VARCHAR(50) NOT NULL,
    payload        JSONB NOT NULL,
    target_url     VARCHAR(255) NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','SENT','FAILED')),
    response_code  INTEGER,
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);

-- Dashboard login gate — single row holding the hashed dashboard password.
-- Separate from api_configs: this protects the human-facing dashboard UI,
-- while api_configs.api_key_hash protects the machine-facing REST API.
CREATE TABLE IF NOT EXISTS dashboard_auth (
    id             SMALLINT PRIMARY KEY DEFAULT 1,
    password_hash  VARCHAR(255) NOT NULL,
    password_salt  VARCHAR(64) NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT dashboard_auth_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash     VARCHAR(255) NOT NULL UNIQUE,
    ip_address     VARCHAR(64),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at     TIMESTAMPTZ NOT NULL,
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires ON dashboard_sessions(expires_at);

-- Global gateway settings configurable from the dashboard (currently just
-- the anti-ban humanized send delay), so they can be changed without
-- editing backend/.env and restarting the process.
CREATE TABLE IF NOT EXISTS gateway_settings (
    key            VARCHAR(100) PRIMARY KEY,
    value          TEXT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent migration for installations that already ran an older version
-- of this schema (Postgres 9.6+ supports IF NOT EXISTS on ADD COLUMN).
ALTER TABLE api_configs ADD COLUMN IF NOT EXISTS default_device_id UUID REFERENCES devices(id) ON DELETE SET NULL;

-- A unique index enforces the same guarantee as a UNIQUE column constraint
-- (and raises the same SQLSTATE 23505 on conflict) without needing a
-- conditional ALTER TABLE ... ADD CONSTRAINT, which Postgres doesn't support
-- with IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_configs_key_hash_unique ON api_configs(api_key_hash);

-- ---------------------------------------------------------------------
-- Migration: TIMESTAMP -> TIMESTAMPTZ (fixes wrong/unconverted times in
-- the dashboard, e.g. Riwayat Pesan showing raw UTC instead of the
-- browser's local time zone).
--
-- Root cause: "timestamp without time zone" columns store bare wall-clock
-- digits with no zone info attached. Whether those digits end up meaning
-- the right real-world instant depends entirely on the Postgres session's
-- `timezone` setting at INSERT time — which in turn depends on how the
-- Postgres server/container itself is configured. That's fragile: if the
-- underlying host or container ever has a non-UTC system time zone, the
-- exact same code silently produces wrong results, and the client has no
-- way to know which time zone the raw value is even in.
--
-- TIMESTAMPTZ removes the ambiguity entirely: Postgres always stores it
-- as an absolute UTC instant internally, and the pg driver always reports
-- it back as a correct, unambiguous instant — so the dashboard's own
-- time zone conversion (Settings > Zona Waktu Tampilan) is guaranteed to
-- apply correctly and consistently everywhere it's displayed.
--
-- This block only runs (and is a no-op after the first run) for columns
-- that are still the old "timestamp without time zone" type, so it's safe
-- to re-run on every startup/migrate. Existing values are reinterpreted
-- as UTC (matching Postgres's own default session time zone), which is
-- correct for any install that hasn't manually changed that setting.
DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
      AND table_name IN (
        'devices', 'message_logs', 'api_configs', 'webhook_deliveries',
        'dashboard_auth', 'dashboard_sessions', 'gateway_settings'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
      col.table_name, col.column_name, col.column_name
    );
  END LOOP;
END $$;
