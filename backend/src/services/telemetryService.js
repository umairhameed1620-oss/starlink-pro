const cron   = require('node-cron');
const { query } = require('../utils/database');
const { getCachedSatellites } = require('./tleService');
const logger = require('../utils/logger');
const NodeCache = require('node-cache');

const liveCache  = new NodeCache({ stdTTL: 30 });
const BATCH_SIZE = 100; // Process in batches for scaling

// ─── Simulate realistic telemetry per satellite ───────────────
function generateTelemetry(sat, prevTele) {
  const drift = (base, range, prev) => {
    const v = prev !== undefined
      ? Math.max(0, Math.min(100, prev + (Math.random() - 0.5) * 2))
      : base + (Math.random() - 0.5) * range;
    return parseFloat(v.toFixed(2));
  };

  const prev = prevTele || {};
  const signal  = drift(75, 20, prev.signal);
  const battery = drift(80, 10, prev.battery);
  const temp    = parseFloat((prev.temp !== undefined
    ? Math.max(-40, Math.min(120, prev.temp + (Math.random() - 0.5) * 3))
    : 20 + Math.random() * 40).toFixed(1));
  const latency = parseFloat((prev.latency !== undefined
    ? Math.max(10, Math.min(500, prev.latency + (Math.random() - 0.5) * 10))
    : 20 + Math.random() * 30).toFixed(0));

  const health =
    signal < 15 || battery < 15 || temp > 95 || latency > 350 ? 'critical' :
    signal < 40 || battery < 35 || temp > 75 || latency > 200 ? 'warning'  : 'nominal';

  return { signal, battery, temp, latency, health };
}

// ─── Process a batch of satellites ───────────────────────────
async function processBatch(satellites) {
  const snapshots = [];

  for (const sat of satellites) {
    const prev = liveCache.get(sat.noradId);
    const tele = generateTelemetry(sat, prev);
    liveCache.set(sat.noradId, tele);

    snapshots.push({
      noradId:  sat.noradId,
      name:     sat.name,
      ...tele,
    });

    // Persist to DB (sample 10% to avoid overwhelming storage)
    if (Math.random() < 0.1) {
      try {
        const { rows } = await query(
          'SELECT id FROM satellites WHERE norad_id=$1', [sat.noradId]
        );
        if (rows[0]) {
          await query(
            `INSERT INTO telemetry_snapshots
               (satellite_id, norad_id, signal_strength, battery_level, temperature_c, latency_ms, health_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [rows[0].id, sat.noradId, tele.signal, tele.battery, tele.temp, tele.latency, tele.health]
          );
        }
      } catch {}
    }
  }

  return snapshots;
}

// ─── Check thresholds and raise alerts ───────────────────────
async function checkAlerts(snapshots) {
  const critical = snapshots.filter(s => s.health === 'critical');
  const warning  = snapshots.filter(s => s.health === 'warning');

  for (const sat of [...critical, ...warning]) {
    try {
      // Deduplicate: only insert if no active alert in last 10 mins
      const { rows } = await query(
        `SELECT id FROM alerts WHERE norad_id=$1 AND status='active'
         AND triggered_at > NOW() - INTERVAL '10 minutes'`,
        [sat.noradId]
      );
      if (rows.length) continue;

      const metric = sat.signal < 20  ? { name: 'signal',  val: sat.signal,  threshold: 20 }
                   : sat.battery < 20 ? { name: 'battery', val: sat.battery, threshold: 20 }
                   : sat.temp > 90    ? { name: 'temp',    val: sat.temp,    threshold: 90 }
                   :                    { name: 'latency', val: sat.latency, threshold: 350 };

      await query(
        `INSERT INTO alerts (norad_id, satellite_name, severity, alert_type, message, metric_name, metric_value, threshold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          sat.noradId, sat.name, sat.health, 'telemetry_threshold',
          `${sat.name}: ${metric.name} = ${metric.val} (threshold: ${metric.threshold})`,
          metric.name, metric.val, metric.threshold
        ]
      );
    } catch {}
  }
}

// ─── Get live telemetry map ───────────────────────────────────
function getLiveTelemetry() {
  const result = {};
  const keys = liveCache.keys();
  for (const k of keys) result[k] = liveCache.get(k);
  return result;
}

// ─── Get historical telemetry for a satellite ─────────────────
async function getHistory(noradId, hours = 24, limit = 500) {
  const { rows } = await query(
    `SELECT signal_strength, battery_level, temperature_c, latency_ms, health_status, recorded_at
     FROM telemetry_snapshots
     WHERE norad_id=$1 AND recorded_at > NOW() - ($2 || ' hours')::INTERVAL
     ORDER BY recorded_at DESC LIMIT $3`,
    [noradId, hours, limit]
  );
  return rows;
}

// ─── Clean old telemetry (retention policy) ───────────────────
async function cleanOldTelemetry() {
  try {
    const { rows: [cfg] } = await query(
      `SELECT value FROM system_config WHERE key='telemetry_retention_days'`
    );
    const days = parseInt(cfg?.value || '30');
    const { rowCount } = await query(
      `DELETE FROM telemetry_snapshots WHERE recorded_at < NOW() - ($1 || ' days')::INTERVAL`,
      [days]
    );
    if (rowCount > 0) logger.info(`Cleaned ${rowCount} old telemetry records (>${days} days)`);
  } catch (e) {
    logger.warn('Telemetry cleanup failed:', e.message);
  }
}

// ─── Start telemetry loop (every 10s) ────────────────────────
let io = null;
function setIO(socketIO) { io = socketIO; }

function startTelemetryLoop() {
  cron.schedule('*/10 * * * * *', async () => {
    const satellites = getCachedSatellites();
    if (!satellites.length) return;

    // Process in batches for scaling
    const allSnapshots = [];
    for (let i = 0; i < satellites.length; i += BATCH_SIZE) {
      const batch = satellites.slice(i, i + BATCH_SIZE);
      const snaps = await processBatch(batch);
      allSnapshots.push(...snaps);
    }

    await checkAlerts(allSnapshots);

    // Broadcast summary via WebSocket
    if (io) {
      const critical = allSnapshots.filter(s => s.health === 'critical');
      const warning  = allSnapshots.filter(s => s.health === 'warning');
      io.emit('telemetry:summary', {
        total: allSnapshots.length,
        nominal:  allSnapshots.length - critical.length - warning.length,
        warning:  warning.length,
        critical: critical.length,
        timestamp: new Date().toISOString(),
      });
      // Broadcast individual critical/warning sats
      for (const sat of [...critical, ...warning]) {
        io.emit('telemetry:update', sat);
      }
    }
  });

  // Cleanup cron: daily at 3am
  cron.schedule('0 3 * * *', cleanOldTelemetry);
  logger.info('Telemetry loop started (10s interval, batch size: ' + BATCH_SIZE + ')');
}

module.exports = { startTelemetryLoop, getLiveTelemetry, getHistory, setIO };
