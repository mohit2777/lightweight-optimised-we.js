const rateLimit = require('express-rate-limit');
const logger = require('./logger');

// Helper to disable rate limiting
const noOpLimiter = (req, res, next) => next();

// General API rate limiter - DISABLED
const apiLimiter = noOpLimiter;

// Strict rate limiter for authentication endpoints - DISABLED
const authLimiter = noOpLimiter;

// Message sending rate limiter - DISABLED
const messageLimiter = noOpLimiter;

// Webhook creation rate limiter - DISABLED
const webhookLimiter = noOpLimiter;

// Account creation rate limiter - DISABLED
const accountLimiter = noOpLimiter;

module.exports = {
  apiLimiter,
  authLimiter,
  messageLimiter,
  webhookLimiter,
  accountLimiter
};
