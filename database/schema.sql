-- ============================================================
-- STARLINK PRO - FULL DATABASE SCHEMA
-- Supports PostgreSQL (production) + SQLite (fallback/dev)
-- ============================================================

-- USERS & AUTH
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  first_name  VARCHAR(100),
  last_name   VARCHAR(100),
  role        VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('admin','analyst','viewer')),
  is_active   BOOLEAN DEFAULT true,
  api_key     VARCHAR(64) UNIQUE,
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token       VARCHAR(512) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  resource    VARCHAR(100),
  ip_address  VARCHAR(45),
  user_agent  TEXT,
  status      VARCHAR(20),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- SATELLITE DATA
CREATE TABLE IF NOT EXISTS satellites (
  id            SERIAL PRIMARY KEY,
  norad_id      VARCHAR(20) UNIQUE NOT NULL,
  name          VARCHAR(200) NOT NULL,
  shell         VARCHAR(50),
  tle_line1     TEXT,
  tle_line2     TEXT,
  tle_epoch     TIMESTAMPTZ,
  tle_updated   TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_satellites_norad ON satellites(norad_id);
CREATE INDEX IF NOT EXISTS idx_satellites_shell ON satellites(shell);

-- TELEMETRY (historical storage)
CREATE TABLE IF NOT EXISTS telemetry_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  satellite_id    INTEGER REFERENCES satellites(id) ON DELETE CASCADE,
  norad_id        VARCHAR(20) NOT NULL,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  altitude_km     DOUBLE PRECISION,
  velocity_kms    DOUBLE PRECISION,
  signal_strength DOUBLE PRECISION,
  battery_level   DOUBLE PRECISION,
  temperature_c   DOUBLE PRECISION,
  latency_ms      DOUBLE PRECISION,
  health_status   VARCHAR(20) DEFAULT 'nominal',
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_satellite ON telemetry_snapshots(satellite_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_recorded  ON telemetry_snapshots(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_health    ON telemetry_snapshots(health_status);

-- ALERTS
CREATE TABLE IF NOT EXISTS alerts (
  id              SERIAL PRIMARY KEY,
  satellite_id    INTEGER REFERENCES satellites(id) ON DELETE CASCADE,
  norad_id        VARCHAR(20),
  satellite_name  VARCHAR(200),
  severity        VARCHAR(20) CHECK (severity IN ('critical','warning','info')),
  alert_type      VARCHAR(50),
  message         TEXT,
  metric_name     VARCHAR(50),
  metric_value    DOUBLE PRECISION,
  threshold       DOUBLE PRECISION,
  status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','acknowledged','resolved')),
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  triggered_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status   ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_sat      ON alerts(satellite_id);

-- TLE CACHE (fallback if CelesTrak is down)
CREATE TABLE IF NOT EXISTS tle_cache (
  id          SERIAL PRIMARY KEY,
  group_name  VARCHAR(50) NOT NULL,
  data        TEXT NOT NULL,
  satellite_count INTEGER,
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  is_current  BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_tle_cache_group ON tle_cache(group_name, is_current);

-- HEALTH CHECKS (monitoring)
CREATE TABLE IF NOT EXISTS health_checks (
  id            SERIAL PRIMARY KEY,
  service       VARCHAR(50) NOT NULL,
  status        VARCHAR(20) NOT NULL,
  response_ms   INTEGER,
  error_message TEXT,
  checked_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_service ON health_checks(service, checked_at DESC);

-- SYSTEM CONFIG
CREATE TABLE IF NOT EXISTS system_config (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed admin user (password: Admin@StarLink2026)
INSERT INTO users (email, password, first_name, last_name, role, api_key)
VALUES (
  'admin@starlinkpro.local',
  '$2a$12$LzGmZhMCGXjINXwQkJ6aIuQH1nWn.5lNYyDlYuE3KV0WDvJiHx2y2',
  'System', 'Admin', 'admin',
  'SLPRO-ADMIN-KEY-2026'
) ON CONFLICT DO NOTHING;

-- Default system config
INSERT INTO system_config VALUES ('tle_refresh_interval', '7200000', NOW()) ON CONFLICT DO NOTHING;
INSERT INTO system_config VALUES ('telemetry_retention_days', '30', NOW()) ON CONFLICT DO NOTHING;
INSERT INTO system_config VALUES ('max_alerts_per_page', '100', NOW()) ON CONFLICT DO NOTHING;
