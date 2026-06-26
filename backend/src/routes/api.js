const router = require('express').Router();
const { query } = require('../utils/database');
const { authenticate, isAdmin, isAnalyst } = require('../middleware/auth');
const { validateSatelliteQuery, validateNoradId, handleValidation, tleLimiter } = require('../middleware/security');
const { getCachedSatellites, getTLEMeta, refreshTLEs } = require('../services/tleService');
const { getLiveTelemetry, getHistory } = require('../services/telemetryService');
const { getHealthReport, getHealthHistory, getAlertSummary } = require('../services/monitoringService');
const logger = require('../utils/logger');

// ══════════════════════════════════════════════════════════════
// SATELLITES
// ══════════════════════════════════════════════════════════════

// GET /api/satellites
router.get('/', authenticate, validateSatelliteQuery, handleValidation, async (req, res) => {
  try {
    const { limit = 200, offset = 0, shell, health, search } = req.query;

    // Get from DB (includes position data)
    let sql = `SELECT s.id, s.norad_id, s.name, s.shell, s.tle_line1, s.tle_line2, s.tle_epoch, s.tle_updated
               FROM satellites s WHERE s.is_active=true`;
    const params = [];

    if (shell)  { params.push(shell);  sql += ` AND s.shell=$${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND s.name ILIKE $${params.length}`; }

    sql += ` ORDER BY s.name LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);

    const { rows: satellites } = await query(sql, params);

    // Merge with live telemetry
    const liveTele = getLiveTelemetry();
    const merged = satellites.map(s => ({
      ...s,
      telemetry: liveTele[s.norad_id] || null,
    }));

    // Filter by health if requested
    const result = health
      ? merged.filter(s => s.telemetry?.health === health)
      : merged;

    res.json({
      satellites: result,
      total: result.length,
      tleMeta: getTLEMeta(),
    });
  } catch (err) {
    logger.error('GET /satellites error:', err.message);
    res.status(500).json({ error: 'Failed to fetch satellites' });
  }
});

// GET /api/satellites/:noradId
router.get('/:noradId', authenticate, validateNoradId, handleValidation, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM satellites WHERE norad_id=$1', [req.params.noradId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Satellite not found' });
  const liveTele = getLiveTelemetry();
  res.json({ ...rows[0], telemetry: liveTele[req.params.noradId] || null });
});

// GET /api/satellites/:noradId/history
router.get('/:noradId/history', authenticate, validateNoradId, handleValidation, async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24'), 168); // max 7 days
  const data = await getHistory(req.params.noradId, hours);
  res.json({ noradId: req.params.noradId, hours, records: data });
});

// POST /api/satellites/refresh-tle (admin only)
router.post('/refresh-tle', authenticate, isAdmin, tleLimiter, async (req, res) => {
  try {
    logger.info(`Manual TLE refresh triggered by user ${req.user.id}`);
    const satellites = await refreshTLEs();
    res.json({ message: 'TLE refresh complete', count: satellites.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/satellites/summary/constellation
router.get('/summary/constellation', authenticate, async (req, res) => {
  const liveTele  = getLiveTelemetry();
  const values    = Object.values(liveTele);
  const nominal   = values.filter(t => t.health === 'nominal').length;
  const warning   = values.filter(t => t.health === 'warning').length;
  const critical  = values.filter(t => t.health === 'critical').length;
  const avgSignal = values.reduce((a,b) => a + b.signal, 0) / (values.length || 1);
  const avgBatt   = values.reduce((a,b) => a + b.battery, 0) / (values.length || 1);
  res.json({
    total: values.length, nominal, warning, critical,
    avgSignal: parseFloat(avgSignal.toFixed(1)),
    avgBattery: parseFloat(avgBatt.toFixed(1)),
    tleMeta: getTLEMeta(),
  });
});

// ══════════════════════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════════════════════

const alertsRouter = require('express').Router();

// GET /api/alerts
alertsRouter.get('/', authenticate, async (req, res) => {
  const { status = 'active', severity, limit = 100, offset = 0 } = req.query;
  let sql = `SELECT a.*, u.email as acked_by_email FROM alerts a
             LEFT JOIN users u ON a.acknowledged_by=u.id WHERE 1=1`;
  const params = [];
  if (status)   { params.push(status);   sql += ` AND a.status=$${params.length}`; }
  if (severity) { params.push(severity); sql += ` AND a.severity=$${params.length}`; }
  sql += ` ORDER BY a.triggered_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
  params.push(limit, offset);
  const { rows } = await query(sql, params);
  res.json({ alerts: rows, total: rows.length });
});

// POST /api/alerts/:id/acknowledge
alertsRouter.post('/:id/acknowledge', authenticate, isAnalyst, async (req, res) => {
  const { rows } = await query(
    `UPDATE alerts SET status='acknowledged', acknowledged_by=$1, acknowledged_at=NOW()
     WHERE id=$2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Alert not found' });
  res.json(rows[0]);
});

// POST /api/alerts/:id/resolve
alertsRouter.post('/:id/resolve', authenticate, isAnalyst, async (req, res) => {
  const { rows } = await query(
    `UPDATE alerts SET status='resolved', resolved_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Alert not found' });
  res.json(rows[0]);
});

// ══════════════════════════════════════════════════════════════
// HEALTH / MONITORING
// ══════════════════════════════════════════════════════════════

const healthRouter = require('express').Router();

// GET /api/health (public - for load balancer)
healthRouter.get('/', async (req, res) => {
  const report = await getHealthReport();
  res.status(report.overall === 'healthy' ? 200 : 503).json(report);
});

// GET /api/health/history
healthRouter.get('/history', authenticate, async (req, res) => {
  const data = await getHealthHistory(req.query.service, req.query.limit || 100);
  res.json(data);
});

// GET /api/health/alerts-summary
healthRouter.get('/alerts-summary', authenticate, async (req, res) => {
  res.json(await getAlertSummary());
});

// ══════════════════════════════════════════════════════════════
// TELEMETRY LIVE
// ══════════════════════════════════════════════════════════════

const telemetryRouter = require('express').Router();

telemetryRouter.get('/live', authenticate, (req, res) => {
  const live = getLiveTelemetry();
  res.json({ telemetry: live, count: Object.keys(live).length, timestamp: new Date().toISOString() });
});

telemetryRouter.get('/stats', authenticate, (req, res) => {
  const live = Object.values(getLiveTelemetry());
  const stats = {
    count:       live.length,
    nominal:     live.filter(t => t.health==='nominal').length,
    warning:     live.filter(t => t.health==='warning').length,
    critical:    live.filter(t => t.health==='critical').length,
    avgSignal:   parseFloat((live.reduce((a,b)=>a+b.signal,0)/(live.length||1)).toFixed(1)),
    avgBattery:  parseFloat((live.reduce((a,b)=>a+b.battery,0)/(live.length||1)).toFixed(1)),
    avgTemp:     parseFloat((live.reduce((a,b)=>a+b.temp,0)/(live.length||1)).toFixed(1)),
    avgLatency:  parseFloat((live.reduce((a,b)=>a+b.latency,0)/(live.length||1)).toFixed(0)),
  };
  res.json(stats);
});

module.exports = { satellitesRouter: router, alertsRouter, healthRouter, telemetryRouter };
