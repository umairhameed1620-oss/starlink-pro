const { buildSchema } = require('graphql');
const { query } = require('../utils/database');
const { getCachedSatellites, getTLEMeta } = require('../services/tleService');
const { getLiveTelemetry, getHistory } = require('../services/telemetryService');

// ─── Schema ───────────────────────────────────────────────────
const schema = buildSchema(`
  type Satellite {
    id: ID
    noradId: String!
    name: String!
    shell: String
    tleLine1: String
    tleLine2: String
    tleEpoch: String
    tleUpdated: String
    telemetry: Telemetry
  }

  type Telemetry {
    signal: Float
    battery: Float
    temp: Float
    latency: Float
    health: String
  }

  type TelemetryHistory {
    signalStrength: Float
    batteryLevel: Float
    temperatureC: Float
    latencyMs: Float
    healthStatus: String
    recordedAt: String
  }

  type Alert {
    id: ID
    noradId: String
    satelliteName: String
    severity: String
    alertType: String
    message: String
    metricName: String
    metricValue: Float
    threshold: Float
    status: String
    triggeredAt: String
  }

  type ConstellationSummary {
    total: Int
    nominal: Int
    warning: Int
    critical: Int
    avgSignal: Float
    avgBattery: Float
  }

  type TLEMeta {
    updatedAt: String
    source: String
    count: Int
  }

  type HealthStatus {
    overall: String
    uptime: Float
    timestamp: String
  }

  type Query {
    satellite(noradId: String!): Satellite
    satellites(shell: String, health: String, limit: Int, offset: Int): [Satellite]
    constellationSummary: ConstellationSummary
    alerts(status: String, severity: String, limit: Int): [Alert]
    telemetryHistory(noradId: String!, hours: Int): [TelemetryHistory]
    tleMeta: TLEMeta
    health: HealthStatus
  }

  type Mutation {
    acknowledgeAlert(id: ID!): Alert
    resolveAlert(id: ID!): Alert
  }
`);

// ─── Resolvers ────────────────────────────────────────────────
const root = {
  satellite: async ({ noradId }) => {
    const { rows } = await query('SELECT * FROM satellites WHERE norad_id=$1', [noradId]);
    if (!rows[0]) return null;
    const live = getLiveTelemetry();
    return { ...rows[0], noradId: rows[0].norad_id, tleEpoch: rows[0].tle_epoch, tleUpdated: rows[0].tle_updated, telemetry: live[noradId] || null };
  },

  satellites: async ({ shell, health, limit = 100, offset = 0 }) => {
    let sql = 'SELECT * FROM satellites WHERE is_active=true';
    const params = [];
    if (shell) { params.push(shell); sql += ` AND shell=$${params.length}`; }
    sql += ` LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Math.min(limit, 500), offset);
    const { rows } = await query(sql, params);
    const live = getLiveTelemetry();
    const mapped = rows.map(s => ({
      ...s, noradId: s.norad_id, tleEpoch: s.tle_epoch, tleUpdated: s.tle_updated,
      telemetry: live[s.norad_id] || null,
    }));
    return health ? mapped.filter(s => s.telemetry?.health === health) : mapped;
  },

  constellationSummary: () => {
    const live = Object.values(getLiveTelemetry());
    return {
      total:      live.length,
      nominal:    live.filter(t => t.health==='nominal').length,
      warning:    live.filter(t => t.health==='warning').length,
      critical:   live.filter(t => t.health==='critical').length,
      avgSignal:  parseFloat((live.reduce((a,b)=>a+b.signal,0)/(live.length||1)).toFixed(1)),
      avgBattery: parseFloat((live.reduce((a,b)=>a+b.battery,0)/(live.length||1)).toFixed(1)),
    };
  },

  alerts: async ({ status = 'active', severity, limit = 50 }) => {
    let sql = 'SELECT * FROM alerts WHERE 1=1';
    const params = [];
    if (status)   { params.push(status);   sql += ` AND status=$${params.length}`; }
    if (severity) { params.push(severity); sql += ` AND severity=$${params.length}`; }
    sql += ` ORDER BY triggered_at DESC LIMIT $${params.length+1}`;
    params.push(limit);
    const { rows } = await query(sql, params);
    return rows.map(a => ({
      ...a, noradId: a.norad_id, satelliteName: a.satellite_name,
      alertType: a.alert_type, metricName: a.metric_name, metricValue: a.metric_value,
      triggeredAt: a.triggered_at,
    }));
  },

  telemetryHistory: async ({ noradId, hours = 24 }) => {
    const data = await getHistory(noradId, Math.min(hours, 168));
    return data.map(r => ({
      signalStrength: r.signal_strength, batteryLevel: r.battery_level,
      temperatureC:   r.temperature_c,   latencyMs:    r.latency_ms,
      healthStatus:   r.health_status,   recordedAt:   r.recorded_at,
    }));
  },

  tleMeta: getTLEMeta,

  health: () => ({
    overall: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString()
  }),

  acknowledgeAlert: async ({ id }, context) => {
    if (!context?.user) throw new Error('Unauthenticated');
    const { rows } = await query(
      `UPDATE alerts SET status='acknowledged', acknowledged_by=$1, acknowledged_at=NOW()
       WHERE id=$2 RETURNING *`,
      [context.user.id, id]
    );
    return rows[0];
  },

  resolveAlert: async ({ id }, context) => {
    if (!context?.user) throw new Error('Unauthenticated');
    const { rows } = await query(
      `UPDATE alerts SET status='resolved', resolved_at=NOW() WHERE id=$1 RETURNING *`, [id]
    );
    return rows[0];
  },
};

module.exports = { schema, root };
