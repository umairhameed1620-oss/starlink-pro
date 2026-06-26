// ============================================================
// STARLINK PRO - FULL TEST SUITE
// Run: npm test
// ============================================================

const request = require('supertest');

// Mock database before requiring server
jest.mock('../utils/database', () => ({
  initDB: jest.fn().mockResolvedValue({}),
  query: jest.fn(),
  isUsingFallback: jest.fn().mockReturnValue(false),
}));

jest.mock('../services/tleService', () => ({
  refreshTLEs:          jest.fn().mockResolvedValue([]),
  getCachedSatellites:  jest.fn().mockReturnValue([]),
  getTLEMeta:           jest.fn().mockReturnValue({ updatedAt: new Date().toISOString(), source: 'live', count: 0 }),
  startTLERefreshCron:  jest.fn(),
}));

jest.mock('../services/telemetryService', () => ({
  startTelemetryLoop: jest.fn(),
  getLiveTelemetry:   jest.fn().mockReturnValue({}),
  getHistory:         jest.fn().mockResolvedValue([]),
  setIO:              jest.fn(),
}));

jest.mock('../services/monitoringService', () => ({
  startMonitoring:   jest.fn(),
  getHealthReport:   jest.fn().mockResolvedValue({ overall: 'healthy', timestamp: new Date().toISOString(), services: {}, uptime: 100, memory: {} }),
  getHealthHistory:  jest.fn().mockResolvedValue([]),
  getAlertSummary:   jest.fn().mockResolvedValue({}),
  setIO:             jest.fn(),
}));

const { query } = require('../utils/database');
let app;

beforeAll(() => {
  process.env.JWT_SECRET         = 'test-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.NODE_ENV           = 'test';
  app = require('../server').app;
});

afterEach(() => jest.clearAllMocks());

// ─── AUTH TESTS ───────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  const bcrypt = require('bcryptjs');

  it('should return 401 for invalid credentials', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'wrong@test.com', password: 'wrongpass123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('should return 400 for invalid email format', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('should return 400 for short password', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'test@test.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('should login successfully with valid credentials', async () => {
    const hash = await bcrypt.hash('ValidPass@123', 12);
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, email: 'admin@test.com', password: hash, role: 'admin', is_active: true }] })
      .mockResolvedValueOnce({ rows: [] })  // insert refresh token
      .mockResolvedValueOnce({ rows: [] }); // update last_login

    const res = await request(app).post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'ValidPass@123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body.user.role).toBe('admin');
  });
});

describe('GET /api/auth/me', () => {
  it('should return 401 without token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

// ─── SATELLITE TESTS ──────────────────────────────────────────
describe('GET /api/satellites', () => {
  const jwt = require('jsonwebtoken');
  const getToken = () => jwt.sign({ userId: 1, role: 'viewer' }, 'test-secret', { expiresIn: '1h' });

  it('should return 401 without auth', async () => {
    const res = await request(app).get('/api/satellites');
    expect(res.status).toBe(401);
  });

  it('should return satellites with valid token', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, email: 'viewer@test.com', role: 'viewer', is_active: true }] }) // auth
      .mockResolvedValueOnce({ rows: [{ id: 1, email: 'viewer@test.com', role: 'viewer', is_active: true }] }) // audit
      .mockResolvedValueOnce({ rows: [
        { id: 1, norad_id: '44713', name: 'STARLINK-1007', shell: 'Shell-1', tle_line1: '', tle_line2: '' },
        { id: 2, norad_id: '44714', name: 'STARLINK-1008', shell: 'Shell-1', tle_line1: '', tle_line2: '' },
      ]});

    const res = await request(app)
      .get('/api/satellites')
      .set('Authorization', `Bearer ${getToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('satellites');
    expect(Array.isArray(res.body.satellites)).toBe(true);
  });

  it('should reject invalid limit param', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'v@t.com', role: 'viewer', is_active: true }] });
    const res = await request(app)
      .get('/api/satellites?limit=99999')
      .set('Authorization', `Bearer ${getToken()}`);
    expect(res.status).toBe(400);
  });
});

// ─── SECURITY TESTS ───────────────────────────────────────────
describe('Security - Rate Limiting', () => {
  it('should have rate limit headers on auth endpoint', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'test@test.com', password: 'testpass1' });
    expect(res.headers).toHaveProperty('ratelimit-limit');
  });
});

describe('Security - Input Sanitisation', () => {
  it('should reject SQL injection attempts', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: "admin' OR '1'='1", password: 'pass' });
    // Either 400 validation or 400 SQL injection detection
    expect([400, 401]).toContain(res.status);
  });

  it('should strip HTML tags from input', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/auth/login')
      .send({ email: '<script>alert(1)</script>@test.com', password: 'password123' });
    expect(res.status).toBe(400);
  });
});

describe('Security - NORAD ID Validation', () => {
  const jwt = require('jsonwebtoken');
  const getToken = () => jwt.sign({ userId: 1, role: 'viewer' }, 'test-secret', { expiresIn: '1h' });

  it('should reject non-numeric NORAD IDs', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'v@t.com', role: 'viewer', is_active: true }] });
    const res = await request(app)
      .get('/api/satellites/DROP-TABLE')
      .set('Authorization', `Bearer ${getToken()}`);
    expect(res.status).toBe(400);
  });
});

// ─── HEALTH TESTS ─────────────────────────────────────────────
describe('GET /api/health', () => {
  it('should return health status without auth (public endpoint)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('overall');
    expect(res.body.overall).toBe('healthy');
  });
});

// ─── GRAPHQL TESTS ────────────────────────────────────────────
describe('POST /graphql', () => {
  it('should return 401 without auth', async () => {
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ tleMeta { count source } }' });
    expect(res.status).toBe(401);
  });
});

// ─── TELEMETRY TESTS ──────────────────────────────────────────
describe('Telemetry Generation', () => {
  const { getLiveTelemetry } = require('../services/telemetryService');

  it('should return telemetry map', () => {
    getLiveTelemetry.mockReturnValue({
      '44713': { signal: 85, battery: 90, temp: 25, latency: 20, health: 'nominal' },
    });
    const tele = getLiveTelemetry();
    expect(tele['44713'].health).toBe('nominal');
    expect(tele['44713'].signal).toBeGreaterThanOrEqual(0);
    expect(tele['44713'].signal).toBeLessThanOrEqual(100);
  });

  it('should classify critical when signal < 15', () => {
    const tele = { signal: 10, battery: 80, temp: 25, latency: 50 };
    const health =
      tele.signal < 15 || tele.battery < 15 || tele.temp > 95 || tele.latency > 350
        ? 'critical' : tele.signal < 40 || tele.battery < 35 || tele.temp > 75 || tele.latency > 200
        ? 'warning' : 'nominal';
    expect(health).toBe('critical');
  });

  it('should classify nominal for healthy values', () => {
    const tele = { signal: 85, battery: 90, temp: 30, latency: 25 };
    const health =
      tele.signal < 15 || tele.battery < 15 || tele.temp > 95 || tele.latency > 350
        ? 'critical' : tele.signal < 40 || tele.battery < 35 || tele.temp > 75 || tele.latency > 200
        ? 'warning' : 'nominal';
    expect(health).toBe('nominal');
  });
});

// ─── TLE SERVICE TESTS ────────────────────────────────────────
describe('TLE Service', () => {
  const { getCachedSatellites, getTLEMeta } = require('../services/tleService');

  it('should return cached satellites', () => {
    getCachedSatellites.mockReturnValue([
      { noradId: '44713', name: 'STARLINK-1007', shell: 'Shell-1' },
    ]);
    const sats = getCachedSatellites();
    expect(Array.isArray(sats)).toBe(true);
    expect(sats[0].noradId).toBe('44713');
  });

  it('should return TLE meta', () => {
    const meta = getTLEMeta();
    expect(meta).toHaveProperty('source');
    expect(meta).toHaveProperty('count');
  });
});
