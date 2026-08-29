const rateLimit = require("express-rate-limit");

/**
 * General API rate limiter
 * Limits each IP to 1000 requests per 15 minutes.
 * Sized for multiple agents sharing one office/NAT IP: each open inbox tab
 * polls conversations + classifications + locks (~6 req/min), so 500 was
 * tight for 3+ concurrent agents.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
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

/**
 * Export rate limiter
 * Generating the prospect sheet is heavy: thousands of documents plus a whole
 * workbook held in memory at once, inside a 512MB container. The general API
 * allowance (1000/15min) is far too generous for that, so exports get their
 * own budget — 20 per 15 minutes per IP is well beyond real use (a manager
 * downloads a handful a day) while removing the DoS headroom.
 */
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    message:
      "Trop d'exports demandés. Réessayez dans quelques minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  apiLimiter,
  authLimiter,
  webhookLimiter,
  exportLimiter,
};
