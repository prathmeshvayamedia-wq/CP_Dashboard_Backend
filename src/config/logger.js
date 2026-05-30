const { createLogger, format, transports } = require('winston');

const loggerTransports = [
  new transports.Console()
];

// File logging only works locally — Vercel filesystem is read-only
if (process.env.NODE_ENV !== 'production') {
  const fs = require('fs');
  if (!fs.existsSync('logs')) fs.mkdirSync('logs');

  loggerTransports.push(
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' })
  );
}

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
    })
  ),
  transports: loggerTransports
});

module.exports = logger;
