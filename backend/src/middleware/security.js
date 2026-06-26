const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
const cors     = require('cors');
const logger   = require('../utils/logger');

// ─── Helmet (HTTP security headers) ─────────────────────────
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://celestrak.org'],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// ─── CORS ────────────────────────────────────────────────────
const corsConfig = cors({
  origin: (origin, cb) => {
    const allowed = [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'http://localhost:3001',
    ];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
});

// ─── Rate Limiters ───────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '200'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit exceeded: ${req.ip} ${req.path}`);
    res.status(429).json(options.message);
  },
});

const authLimiter = rateLimit({
  windowMs: 900000, // 15 min
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10'),
  message:  { error: 'Too many auth attempts, try again in 15 minutes' },
  skipSuccessfulRequests: true,
});

const tleLimiter = rateLimit({
  windowMs: 60000, // 1 min
  max: 10,
  message: { error: 'TLE request rate limit exceeded' },
});

// ─── Input Sanitisation ──────────────────────────────────────
const sanitiseInput = (req, res, next) => {
  const sanitise = (val) => {
    if (typeof val !== 'string') return val;
    // Strip HTML tags, null bytes, control chars
    return val
      .replace(/<[^>]*>/g, '')
      .replace(/\0/g, '')
      .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim()
      .slice(0, 2000); // max length
  };

  const deepSanitise = (obj) => {
    if (typeof obj === 'string') return sanitise(obj);
    if (Array.isArray(obj))      return obj.map(deepSanitise);
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [sanitise(k), deepSanitise(v)])
      );
    }
    return obj;
  };

  if (req.body)   req.body   = deepSanitise(req.body);
  if (req.query)  req.query  = deepSanitise(req.query);
  if (req.params) req.params = deepSanitise(req.params);
  next();
};

// ─── Validation rules ────────────────────────────────────────
const validateLogin = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8, max: 128 }).withMessage('Password 8-128 chars'),
];

const validateCreateUser = [
  body('email').isEmail().normalizeEmail(),
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/)
    .withMessage('Password must contain uppercase, lowercase, number and special char'),
  body('role').optional().isIn(['admin', 'analyst', 'viewer']),
  body('firstName').optional().isLength({ max: 100 }).trim(),
  body('lastName').optional().isLength({ max: 100 }).trim(),
];

const validateSatelliteQuery = [
  query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
  query('shell').optional().isLength({ max: 50 }).trim(),
  query('health').optional().isIn(['nominal', 'warning', 'critical']),
];

const validateNoradId = [
  param('noradId').matches(/^\d{1,6}$/).withMessage('Invalid NORAD ID'),
];

// ─── Validation result handler ───────────────────────────────
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(e => ({ field: e.path, message: e.msg }))
    });
  }
  next();
};

// ─── SQL injection detection ─────────────────────────────────
const detectSQLInjection = (req, res, next) => {
  const sqlPatterns = /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|EXECUTE)\b|--|\/\*|\*\/|xp_|;.*--)/gi;
  const check = (val) => typeof val === 'string' && sqlPatterns.test(val);
  const allValues = [
    ...Object.values(req.body   || {}),
    ...Object.values(req.query  || {}),
    ...Object.values(req.params || {}),
  ];
  if (allValues.some(check)) {
    logger.warn(`SQL injection attempt from ${req.ip}: ${req.path}`);
    return res.status(400).json({ error: 'Invalid input detected' });
  }
  next();
};

module.exports = {
  helmetConfig,
  corsConfig,
  globalLimiter,
  authLimiter,
  tleLimiter,
  sanitiseInput,
  detectSQLInjection,
  validateLogin,
  validateCreateUser,
  validateSatelliteQuery,
  validateNoradId,
  handleValidation,
};
