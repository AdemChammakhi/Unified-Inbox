/**
 * graphAuthGate.js — per-platform breaker for Graph profile lookups.
 *
 * While a Meta app lacks Advanced Access (no Business Verification), every
 * user-profile lookup for real customers fails with a permission error.
 * Retrying them on each webhook and heal cycle is pure waste. The first
 * permission-shaped error blocks that platform's lookups for an hour;
 * after the hour one probe runs again — so when App Review is granted,
 * names and pictures start resolving automatically, no deploy needed.
 *
 * Rate-limit errors (code 4 / 613) block for 15 minutes instead.
 * Network errors do NOT trip the gate — those are transient.
 */

"use strict";

const PERMISSION_BLOCK_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000; // 15 minutes

// Graph error codes that mean "not authorized for this data"
const PERMISSION_CODES = new Set([10, 190, 200, 210, 230]);
const RATE_LIMIT_CODES = new Set([4, 17, 613]);

const _blockedUntil = {}; // platform -> epoch ms
const _announced = {}; // platform -> bool, log the block only once per window

function isBlocked(platform) {
  return Date.now() < (_blockedUntil[platform] || 0);
}

/**
 * Inspect a failed Graph call. Returns true if the gate absorbed it
 * (caller should stop retrying this class of lookup for a while).
 */
function reportGraphError(platform, err) {
  const e = err?.response?.data?.error;
  if (!e) return false; // network / timeout — transient, do not trip

  const permission =
    PERMISSION_CODES.has(e.code) ||
    // code 100 subcode 33: "Unsupported get request … missing permissions"
    (e.code === 100 && e.error_subcode === 33);
  const rateLimit = RATE_LIMIT_CODES.has(e.code);
  if (!permission && !rateLimit) return false;

  const ms = permission ? PERMISSION_BLOCK_MS : RATE_LIMIT_BLOCK_MS;
  _blockedUntil[platform] = Date.now() + ms;
  if (!_announced[platform]) {
    _announced[platform] = true;
    console.warn(
      `[GraphAuthGate] ${platform} profile lookups blocked for ${Math.round(ms / 60000)} min — ` +
        `Meta says: (#${e.code}${e.error_subcode ? "/" + e.error_subcode : ""}) ${String(e.message).slice(0, 140)}. ` +
        (permission
          ? "This clears itself once the app has Advanced Access (App Review / Business Verification)."
          : "Rate limited — will retry automatically."),
    );
    // allow one announcement per new window
    setTimeout(() => {
      _announced[platform] = false;
    }, ms).unref?.();
  }
  return true;
}

module.exports = { isBlocked, reportGraphError };
