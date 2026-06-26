const jwt = require('jsonwebtoken');
const { query } = require('../utils/database');
const logger = require('../utils/logger');

// ─── JWT Auth ────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    // Check API key first
    const apiKey = req.headers['x-api-key'];
    if (apiKey) return authenticateApiKey(apiKey, req, res, next);

    // JWT from header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'starlink-secret');
    
    const { rows } = await query(
      'SELECT id, email, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!rows[0] || !rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = rows[0];
    await logAudit(req, 'api_access', 'success');
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    logger.error('Auth middleware error:', err.message);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// ─── API Key Auth ────────────────────────────────────────────
const authenticateApiKey = async (apiKey, req, res, next) => {
  try {
    // Sanitise - only alphanumeric + dash
    if (!/^[A-Z0-9\-]{10,64}$/.test(apiKey)) {
      return res.status(401).json({ error: 'Invalid API key format' });
    }
    const { rows } = await query(
      'SELECT id, email, role, is_active FROM users WHERE api_key = $1',
      [apiKey]
    );
    if (!rows[0] || !rows[0].is_active) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    logger.error('API key auth error:', err.message);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// ─── RBAC ────────────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
  }
  next();
};

const isAdmin    = requireRole('admin');
const isAnalyst  = requireRole('admin', 'analyst');
const isViewer   = requireRole('admin', 'analyst', 'viewer');

// ─── Audit logging ───────────────────────────────────────────
const logAudit = async (req, action, status) => {
  try {
    await query(
      `INSERT INTO audit_log (user_id, action, resource, ip_address, user_agent, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user?.id, action, req.path, req.ip, req.get('User-Agent'), status]
    );
  } catch {}
};

module.exports = { authenticate, requireRole, isAdmin, isAnalyst, isViewer, logAudit };
