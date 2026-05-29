require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const logger      = require('./config/logger');
const routes      = require('./routes/index');

// Start scheduler alongside the app
require('./jobs/scheduler');

const app = express();

// ── Security ────────────────────────────────────────────────
app.use(helmet());

// app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// app.use(cors({
//   origin: true,
//   credentials: true
// }));

// app.use(cors({
//   origin: [
//     'http://localhost:3001',
//     'http://localhost:3002',
//     'http://localhost:3000',
//     'http://192.168.1.107:3000'
//   ],
//   credentials: true
// }));


app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true
}));



app.use(express.json({ limit: '5mb' }));

// ── Rate limiting ────────────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)        || 100,
  message:  { error: 'Too many requests, please slow down' }
}));

// ── Routes ───────────────────────────────────────────────────
app.use('/api', routes);

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV, timestamp: new Date().toISOString() });
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   logger.info(`Server running on port ${PORT}`, { env: process.env.NODE_ENV });
// });

// module.exports = app;

if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

module.exports = app;
