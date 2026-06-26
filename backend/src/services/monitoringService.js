const cron     = require('node-cron');
const axios    = require('axios');
const { query } = require('../utils/database');
const { getTLEMeta } = require('./tleService');
const logger   = require('../utils/logger');

let io = null;
function setIO(socketIO) { io = socketIO; }

// ─── Check CelesTrak availability ────────────────────────────
async function checkCelesTrak() {
  const start = Date.now();
  try {
    await axios.head('https://celestrak.org', { timeout: 10000 });
    const ms = Date.now() - start;
    await recordCheck('celestrak', 'up', ms);
    return { status: 'up', responseMs: ms };
  } catch (err) {
    const ms = Date.now() - start;
    await recordCheck('celestrak', 'down', ms, err.message);
    logger.warn('CelesTrak health check failed:', err.message);
    if (io) io.emit('monitoring:alert', { service: 'celestrak', status: 'down', message: err.message });
    return { status: 'down', responseMs: ms, error: err.message };
  }
}

// ─── Check DB ────────────────────────────────────────────────
async function checkDatabase() {
  const start = Date.now();
  try {
    await query('SELECT 1');
    const ms = Date.now() - start;
    await recordCheck('database', 'up', ms);
    return { status: 'up', responseMs: ms };
  } catch (err) {
    const ms = Date.now() - start;
    await recordCheck('database', 'down', ms, err.message);
    return { status: 'down', responseMs: ms, error: err.message };
  }
}

// ─── Check TLE freshness ─────────────────────────────────────
async function checkTLEFreshness() {
  const meta = getTLEMeta();
  if (!meta.updatedAt) {
    await recordCheck('tle_freshness', 'stale', 0, 'No TLE data loaded');
    return { status: 'stale', source: meta.source };
  }
  const ageHours = (Date.now() - new Date(meta.updatedAt).getTime()) / 3600000;
  const status = ageHours < 2.5 ? 'fresh' : ageHours < 6 ? 'aging' : 'stale';
  await recordCheck('tle_freshness', status, 0, `Age: ${ageHours.toFixed(1)}h, source: ${meta.source}`);
  return { status, ageHours: parseFloat(ageHours.toFixed(2)), source: meta.source, count: meta.count };
}

// ─── Record health check to DB ────────────────────────────────
async function recordCheck(service, status, responseMs, errorMsg = null) {
  try {
    await query(
      `INSERT INTO health_checks (service, status, response_ms, error_message) VALUES ($1,$2,$3,$4)`,
      [service, status, responseMs, errorMsg]
    );
    // Keep only last 1000 per service
    await query(
      `DELETE FROM health_checks WHERE service=$1 AND id NOT IN (
         SELECT id FROM health_checks WHERE service=$1 ORDER BY checked_at DESC LIMIT 1000
       )`,
      [service]
    );
  } catch {}
}

// ─── Full health report ───────────────────────────────────────
async function getHealthReport() {
  const [db, celestrak, tle] = await Promise.all([
    checkDatabase(),
    checkCelesTrak(),
    checkTLEFreshness(),
  ]);

  const overall = [db, celestrak].every(s => s.status === 'up') ? 'healthy'
                : [db, celestrak].some(s => s.status === 'down') ? 'degraded' : 'healthy';

  return {
    overall,
    timestamp: new Date().toISOString(),
    services: { database: db, celestrak, tleFreshness: tle },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    nodeVersion: process.version,
  };
}

// ─── Get historical health data ───────────────────────────────
async function getHealthHistory(service, limit = 100) {
  const { rows } = await query(
    `SELECT service, status, response_ms, error_message, checked_at
     FROM health_checks
     WHERE ($1::text IS NULL OR service=$1)
     ORDER BY checked_at DESC LIMIT $2`,
    [service || null, limit]
  );
  return rows;
}

// ─── Active alert count ───────────────────────────────────────
async function getAlertSummary() {
  try {
    const { rows } = await query(
      `SELECT severity, COUNT(*) as count FROM alerts WHERE status='active' GROUP BY severity`
    );
    return rows.reduce((acc, r) => ({ ...acc, [r.severity]: parseInt(r.count) }), {});
  } catch { return {}; }
}

// ─── Cron: health check every minute ─────────────────────────
function startMonitoring() {
  cron.schedule('* * * * *', async () => {
    const report = await getHealthReport();
    if (io) io.emit('monitoring:health', report);
    if (report.overall === 'degraded') {
      logger.warn('System health degraded:', JSON.stringify(report.services));
    }
  });
  logger.info('Monitoring started (1-minute health checks)');
}

module.exports = { startMonitoring, getHealthReport, getHealthHistory, getAlertSummary, setIO };
