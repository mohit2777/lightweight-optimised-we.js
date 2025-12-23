const winston = require('winston');
const path = require('path');
const fs = require('fs-extra');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'logs');
fs.ensureDirSync(logsDir);

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Filter out noisy connection timeout errors
const isNoisyConnectionError = (message, meta) => {
  const fullMessage = `${message || ''} ${JSON.stringify(meta || {})}`;
  return (
    fullMessage.includes('ConnectTimeoutError') ||
    fullMessage.includes('UND_ERR_CONNECT_TIMEOUT') ||
    (fullMessage.includes('fetch failed') && fullMessage.includes('timeout'))
  );
};

// Custom filter format to skip noisy errors
const filterNoisyErrors = winston.format((info) => {
  if (isNoisyConnectionError(info.message, info)) {
    return false; // Skip this log entry
  }
  return info;
});

// Console format for better readability
const consoleFormat = winston.format.combine(
  filterNoisyErrors(),
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    // Write to file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// Add console transport in development
// Add console transport if in development OR if explicitly enabled
if (process.env.NODE_ENV !== 'production' || process.env.LOG_TO_CONSOLE === 'true') {
  logger.add(new winston.transports.Console({
    format: consoleFormat
  }));
}

module.exports = logger;
