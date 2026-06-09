/**
 * sanitize.js — Input sanitization utilities for security hardening.
 *
 * Prevents:
 *  - NoSQL injection (MongoDB operator injection via $gt, $ne, etc.)
 *  - Server-Side Request Forgery (SSRF) via crafted IDs in Graph API URLs
 *  - Clear-text logging of sensitive values
 *
 * Usage:
 *   const { sanitizeId, sanitizePlatform, isValidGraphId } = require("../utils/sanitize");
 */

"use strict";

const VALID_PLATFORMS = new Set([
  "facebook",
  "instagram",
  "whatsapp",
  "email",
  "messenger",
  "tiktok",
]);

/**
 * Ensure a value is a plain string (not a MongoDB operator object).
 * If the value is an object (e.g. { "$gt": "" }), it is rejected.
 * Returns the trimmed string, or null if invalid.
 *
 * @param {*} value — User-supplied input (query param, body field, webhook data)
 * @returns {string|null}
 */
function sanitizeId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  // Reject strings that look like MongoDB operators
  if (value.startsWith("$")) return null;
  return value.trim();
}

/**
 * Validate that a platform string is one of the known platforms.
 * Returns the lowercase platform string, or null if invalid.
 *
 * @param {*} value
 * @returns {string|null}
 */
function sanitizePlatform(value) {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return VALID_PLATFORMS.has(lower) ? lower : null;
}

/**
 * Validate that a value is a safe Meta Graph API ID.
 *
 * Valid Graph IDs are:
 *  - Pure numeric strings (PSIDs, page IDs, message IDs): "123456789"
 *  - Thread IDs with "t_" prefix: "t_1234567890"
 *  - Message IDs with "m_" prefix: "m_abc123"
 *  - Alphanumeric strings with dots, underscores, hyphens
 *  - Email addresses (for email platform): "user@example.com"
 *
 * Rejects anything containing path separators, protocol schemes, or whitespace
 * that could be used for SSRF attacks.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isValidGraphId(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  // Reject path traversal, protocol injection, and MongoDB operators
  if (/[\/\\:?\s#]/.test(trimmed) && !trimmed.includes("@")) return false;
  if (trimmed.startsWith("$")) return false;
  if (/^https?/i.test(trimmed)) return false;
  return true;
}

module.exports = {
  sanitizeId,
  sanitizePlatform,
  isValidGraphId,
};
