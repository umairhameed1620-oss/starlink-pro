const { Pool } = require('pg');
const logger = require('./logger');

let pool = null;
let usingFallback = false;

async function initDB() {
  try {
    pool = new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'starlinkpro',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
    });
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connected');

    const fs = require('fs');
    const schema = fs.readFileSync(require('path').join(__dirname, '../../../database/schema.sql'), 'utf8');
    // Run schema (skip errors for existing objects)
    for (const stmt of schema.split(';').filter(s => s.trim())) {
      try { await pool.query(stmt + ';'); } catch {}
    }
    return pool;
  } catch (err) {
    logger.warn('PostgreSQL unavailable, using SQLite fallback:', err.message);
    return initSQLite();
  }
}

async function initSQLite() {
  usingFallback = true;
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');
  const dbPath = process.env.SQLITE_PATH || './data/starlink.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // SQLite adapter that mimics pg Pool interface
  pool = {
    query: async (text, params = []) => {
      try {
        // Convert $1,$2 placeholders to ?
        const sql = text.replace(/\$\d+/g, '?');
        if (/^\s*(SELECT|WITH)/i.test(sql)) {
          const rows = db.prepare(sql).all(...params);
          return { rows, rowCount: rows.length };
        } else {
          const info = db.prepare(sql).run(...params);
          return { rows: [], rowCount: info.changes, lastID: info.lastInsertRowid };
        }
      } catch (e) {
        if (e.message.includes('already exists') || e.message.includes('duplicate')) return { rows: [], rowCount: 0 };
        throw e;
      }
    },
    end: async () => db.close(),
  };

  // Init SQLite schema (simplified)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, first_name TEXT, last_name TEXT, role TEXT DEFAULT 'viewer', is_active INTEGER DEFAULT 1, api_key TEXT UNIQUE, last_login TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS refresh_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, token TEXT, expires_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS satellites (id INTEGER PRIMARY KEY AUTOINCREMENT, norad_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, shell TEXT, tle_line1 TEXT, tle_line2 TEXT, tle_epoch TEXT, tle_updated TEXT, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS telemetry_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, satellite_id INTEGER, norad_id TEXT, latitude REAL, longitude REAL, altitude_km REAL, velocity_kms REAL, signal_strength REAL, battery_level REAL, temperature_c REAL, latency_ms REAL, health_status TEXT DEFAULT 'nominal', recorded_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, satellite_id INTEGER, norad_id TEXT, satellite_name TEXT, severity TEXT, alert_type TEXT, message TEXT, metric_name TEXT, metric_value REAL, threshold REAL, status TEXT DEFAULT 'active', acknowledged_by INTEGER, acknowledged_at TEXT, resolved_at TEXT, triggered_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS tle_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, group_name TEXT NOT NULL, data TEXT NOT NULL, satellite_count INTEGER, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP, is_current INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS health_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT, status TEXT, response_ms INTEGER, error_message TEXT, checked_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT, resource TEXT, ip_address TEXT, user_agent TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT OR IGNORE INTO users (email, password, first_name, last_name, role, api_key) VALUES ('admin@starlinkpro.local', '$2a$12$LzGmZhMCGXjINXwQkJ6aIuQH1nWn.5lNYyDlYuE3KV0WDvJiHx2y2', 'System', 'Admin', 'admin', 'SLPRO-ADMIN-KEY-2026');
  `);

  logger.info('SQLite fallback database ready at', dbPath);
  return pool;
}

const query = (text, params) => {
  if (!pool) throw new Error('DB not initialised');
  return pool.query(text, params);
};

const isUsingFallback = () => usingFallback;
const getPool = () => pool;

module.exports = { initDB, query, isUsingFallback, getPool };
