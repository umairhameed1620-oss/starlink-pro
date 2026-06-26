const { Pool } = require('pg');
const logger = require('./logger');

let pool = null;

async function initDB() {
  pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'starlinkpro',
    user:     process.env.DB_USER     || process.env.USER,
    password: process.env.DB_PASSWORD || '',
    max: 20,
  });
  await pool.query('SELECT 1');
  logger.info('PostgreSQL connected');
  return pool;
}

const query = (text, params) => pool.query(text, params);
const isUsingFallback = () => false;
const getPool = () => pool;

module.exports = { initDB, query, isUsingFallback, getPool };
