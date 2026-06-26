const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { query } = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const { authLimiter, validateLogin, validateCreateUser, handleValidation } = require('../middleware/security');
const logger  = require('../utils/logger');

const sign = (payload, secret, expiresIn) =>
  jwt.sign(payload, secret, { expiresIn });

// POST /api/auth/login
router.post('/login', authLimiter, validateLogin, handleValidation, async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await query(
      'SELECT * FROM users WHERE email=$1 AND is_active=true', [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken  = sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET || 'starlink-secret', process.env.JWT_EXPIRES_IN || '8h');
    const refreshToken = sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET || 'refresh-secret', process.env.JWT_REFRESH_EXPIRES_IN || '7d');

    // Store refresh token
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600000).toISOString();
    await query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)`,
      [user.id, refreshToken, expiresAt]
    );
    // Update last login
    await query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);

    logger.info(`Login: ${email} (${user.role}) from ${req.ip}`);
    res.json({
      accessToken, refreshToken,
      user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name },
    });
  } catch (err) {
    logger.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || 'refresh-secret');
    const { rows } = await query(
      `SELECT * FROM refresh_tokens WHERE token=$1 AND user_id=$2 AND expires_at > NOW()`,
      [refreshToken, decoded.userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const { rows: [user] } = await query('SELECT * FROM users WHERE id=$1 AND is_active=true', [decoded.userId]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const accessToken = sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET || 'starlink-secret', '8h');
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Token refresh failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await query('DELETE FROM refresh_tokens WHERE token=$1', [refreshToken]);
    res.json({ message: 'Logged out' });
  } catch {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  const { rows } = await query(
    'SELECT id, email, role, first_name, last_name, last_login, created_at FROM users WHERE id=$1',
    [req.user.id]
  );
  res.json(rows[0]);
});

// POST /api/auth/regenerate-key (admin or self)
router.post('/regenerate-key', authenticate, async (req, res) => {
  const newKey = 'SLPRO-' + crypto.randomBytes(16).toString('hex').toUpperCase();
  await query('UPDATE users SET api_key=$1 WHERE id=$2', [newKey, req.user.id]);
  res.json({ apiKey: newKey });
});

module.exports = router;
