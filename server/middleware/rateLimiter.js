const rateLimit = require("express-rate-limit");

/**
 * General API rate limiter
 * Limits each IP to 500 requests per 15 minutes.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { message: "Too many requests from this IP, please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Authentication rate limiter
 * Stricter limit for login/auth routes to prevent brute-force attacks.
 * Limits each IP to 50 requests per 15 minutes.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: { message: "Too many login attempts from this IP, please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Webhook rate limiter
 * Generous limits to handle bursts from Meta webhooks.
 * Limits each IP to 2000 requests per 1 minute.
 */
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 2000,
  message: { message: "Too many webhook requests." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  apiLimiter,
  authLimiter,
  webhookLimiter,
};
