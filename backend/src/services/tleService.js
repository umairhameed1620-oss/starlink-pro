const axios  = require('axios');
const cron   = require('node-cron');
const NodeCache = require('node-cache');
const { query } = require('../utils/database');
const logger = require('../utils/logger');

const memCache = new NodeCache({ stdTTL: 7200, checkperiod: 300 });

const CELESTRAK_URL = process.env.CELESTRAK_URL || 'https://celestrak.org/NORAD/elements/gp.php';
const GROUP = process.env.CELESTRAK_GROUP || 'starlink';

// ─── Parse TLE JSON from CelesTrak ──────────────────────────
function parseTLEData(data) {
  if (Array.isArray(data)) {
    return data.map(s => ({
      noradId:  String(s.NORAD_CAT_ID),
      name:     s.OBJECT_NAME?.trim() || `STARLINK-${s.NORAD_CAT_ID}`,
      shell:    detectShell(s.OBJECT_NAME),
      tleLine1: s.TLE_LINE1,
      tleLine2: s.TLE_LINE2,
      epoch:    s.EPOCH,
    }));
  }
  return [];
}

function detectShell(name = '') {
  if (name.includes('STARLINK-1')) return 'Shell-1';
  if (name.includes('STARLINK-2')) return 'Shell-2';
  if (name.includes('STARLINK-3')) return 'Shell-3';
  if (name.includes('STARLINK-4')) return 'Shell-4';
  if (name.includes('STARLINK-5')) return 'Shell-5';
  return 'Unknown';
}

// ─── Fetch from CelesTrak ─────────────────────────────────────
async function fetchFromCelesTrak() {
  const url = `${CELESTRAK_URL}?GROUP=${GROUP}&FORMAT=JSON`;
  logger.info('Fetching TLE data from CelesTrak...');
  const startMs = Date.now();
  const response = await axios.get(url, { timeout: 30000 });
  const elapsed = Date.now() - startMs;
  logger.info(`CelesTrak responded in ${elapsed}ms with ${response.data?.length || 0} satellites`);
  return response.data;
}

// ─── Store TLEs in DB ─────────────────────────────────────────
async function storeTLEs(satellites) {
  let stored = 0;
  for (const sat of satellites) {
    try {
      await query(
        `INSERT INTO satellites (norad_id, name, shell, tle_line1, tle_line2, tle_epoch, tle_updated)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (norad_id) DO UPDATE SET
           name=EXCLUDED.name, shell=EXCLUDED.shell,
           tle_line1=EXCLUDED.tle_line1, tle_line2=EXCLUDED.tle_line2,
           tle_epoch=EXCLUDED.tle_epoch, tle_updated=NOW()`,
        [sat.noradId, sat.name, sat.shell, sat.tleLine1, sat.tleLine2, sat.epoch]
      );
      stored++;
    } catch {}
  }
  logger.info(`Stored/updated ${stored} satellites in DB`);
}

// ─── Cache TLE snapshot ───────────────────────────────────────
async function cacheTLESnapshot(rawData) {
  try {
    // Mark old as not current
    await query(`UPDATE tle_cache SET is_current=false WHERE group_name=$1`, [GROUP]);
    await query(
      `INSERT INTO tle_cache (group_name, data, satellite_count, is_current)
       VALUES ($1,$2,$3,true)`,
      [GROUP, JSON.stringify(rawData), rawData.length]
    );
    // Keep only last 5 snapshots
    await query(
      `DELETE FROM tle_cache WHERE id NOT IN (
         SELECT id FROM tle_cache WHERE group_name=$1 ORDER BY fetched_at DESC LIMIT 5
       )`,
      [GROUP]
    );
  } catch (e) {
    logger.warn('Failed to cache TLE snapshot:', e.message);
  }
}

// ─── Get fallback from DB cache ───────────────────────────────
async function getFallbackTLEs() {
  logger.warn('CelesTrak unavailable — using DB cache fallback');
  const { rows } = await query(
    `SELECT data, fetched_at, satellite_count FROM tle_cache
     WHERE group_name=$1 ORDER BY fetched_at DESC LIMIT 1`,
    [GROUP]
  );
  if (!rows[0]) throw new Error('No TLE cache available');
  logger.info(`Using cached TLE data from ${rows[0].fetched_at} (${rows[0].satellite_count} sats)`);
  return { data: JSON.parse(rows[0].data), fromCache: true, cachedAt: rows[0].fetched_at };
}

// ─── Main refresh ─────────────────────────────────────────────
async function refreshTLEs() {
  try {
    const raw = await fetchFromCelesTrak();
    const satellites = parseTLEData(raw);
    if (!satellites.length) throw new Error('Empty TLE response');

    // Store in memory cache
    memCache.set('satellites', satellites);
    memCache.set('tle_raw', raw);
    memCache.set('tle_updated_at', new Date().toISOString());
    memCache.set('tle_source', 'live');

    // Persist
    await storeTLEs(satellites);
    await cacheTLESnapshot(raw);

    logger.info(`TLE refresh complete: ${satellites.length} Starlink satellites`);
    return satellites;
  } catch (err) {
    logger.error('TLE refresh failed:', err.message);
    // Try memory cache
    const cached = memCache.get('satellites');
    if (cached) {
      logger.info('Using in-memory TLE cache');
      memCache.set('tle_source', 'memory_cache');
      return cached;
    }
    // Try DB cache
    const { data } = await getFallbackTLEs();
    const sats = parseTLEData(data);
    memCache.set('satellites', sats);
    memCache.set('tle_source', 'db_cache');
    return sats;
  }
}

// ─── Get current satellites ───────────────────────────────────
function getCachedSatellites() {
  return memCache.get('satellites') || [];
}

function getTLEMeta() {
  return {
    updatedAt: memCache.get('tle_updated_at'),
    source:    memCache.get('tle_source') || 'unknown',
    count:     (memCache.get('satellites') || []).length,
  };
}

// ─── Cron: refresh every 2 hours ─────────────────────────────
function startTLERefreshCron() {
  cron.schedule('0 */2 * * *', async () => {
    logger.info('Cron: starting TLE refresh');
    await refreshTLEs();
  });
  logger.info('TLE refresh cron scheduled (every 2 hours)');
}

module.exports = { refreshTLEs, getCachedSatellites, getTLEMeta, startTLERefreshCron };
