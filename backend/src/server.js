require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const compression= require('compression');
const morgan     = require('morgan');
const { graphqlHTTP } = require('express-graphql');

const logger      = require('./utils/logger');
const { initDB }  = require('./utils/database');
const { helmetConfig, corsConfig, globalLimiter, sanitiseInput, detectSQLInjection } = require('./middleware/security');
const { authenticate } = require('./middleware/auth');
const { refreshTLEs, startTLERefreshCron } = require('./services/tleService');
const { startTelemetryLoop, setIO: setTelemetryIO } = require('./services/telemetryService');
const { startMonitoring, setIO: setMonitoringIO } = require('./services/monitoringService');
const { schema, root } = require('./routes/graphql');
const authRoutes  = require('./routes/auth');
const { satellitesRouter, alertsRouter, healthRouter, telemetryRouter } = require('./routes/api');

const app    = express();
const server = http.createServer(app);

// ─── WebSocket (Socket.IO) ────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

io.use((socket, next) => {
  // Optional: auth WS connections
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      socket.user = jwt.verify(token, process.env.JWT_SECRET || 'starlink-secret');
    } catch {}
  }
  next();
});

io.on('connection', (socket) => {
  logger.info(`WS connected: ${socket.id}`);
  socket.on('disconnect', () => logger.info(`WS disconnected: ${socket.id}`));
  // Client can subscribe to specific satellite
  socket.on('subscribe:satellite', (noradId) => socket.join(`sat:${noradId}`));
});

// ─── Global Middleware ────────────────────────────────────────
app.use(helmetConfig);
app.use(corsConfig);
app.use(compression());                              // GZIP responses (scaling)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(sanitiseInput);
app.use(detectSQLInjection);
app.use(globalLimiter);

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
}

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/satellites', satellitesRouter);
app.use('/api/alerts',     alertsRouter);
app.use('/api/health',     healthRouter);
app.use('/api/telemetry',  telemetryRouter);

// GraphQL (authenticated)
app.use('/graphql', authenticate, graphqlHTTP((req) => ({
  schema,
  rootValue: root,
  context: { user: req.user },
  graphiql: process.env.NODE_ENV === 'development',
})));

// ─── 404 + Error handlers ────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err.message);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ─── Boot ─────────────────────────────────────────────────────
async function start() {
  try {
    logger.info('Initialising database...');
    await initDB();

    // Wire Socket.IO to services
    setTelemetryIO(io);
    setMonitoringIO(io);

    // Initial TLE fetch
    logger.info('Fetching initial TLE data...');
    await refreshTLEs().catch(e => logger.warn('Initial TLE fetch failed:', e.message));

    // Start background services
    startTLERefreshCron();
    startTelemetryLoop();
    startMonitoring();

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`🚀 Starlink Pro server running on port ${PORT}`);
      logger.info(`📡 GraphQL: http://localhost:${PORT}/graphql`);
      logger.info(`❤️  Health:  http://localhost:${PORT}/api/health`);
      logger.info(`🔌 WS:      ws://localhost:${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') start();

module.exports = { app, server };
