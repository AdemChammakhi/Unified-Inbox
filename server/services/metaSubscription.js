/**
 * metaSubscription.js
 *
 * Subscribes our app to the Facebook Page's messaging webhook fields at
 * startup (POST /{page-id}/subscribed_apps). Called once from server/index.js
 * after the HTTP server starts listening.
 *
 * Why it exists:
 *  - Error code 3 "Application does not have the capability" on the Instagram
 *    Send API is the symptom when the 'messages' subscription is missing, even
 *    when the token has the right scopes.
 *  - messaging_referrals is REQUIRED for ad-referral data: Meta only delivers
 *    ads_context_data when the Page is subscribed to BOTH messages and
 *    messaging_referrals. Without it, a customer clicking a sponsored post
 *    into an existing thread produces no referral event at all.
 *  - message_echoes makes Meta send us a copy of every message the Page sends,
 *    including replies typed in Business Suite or the Messenger app, so those
 *    replies are stored too (see the echo handling in routes/webhooks.js).
 *    Meta also requires the field to be ticked for the app itself, under
 *    App Dashboard > Webhooks > Page. Instagram needs no extra field: its
 *    echoes arrive on the Instagram 'messages' field.
 *
 * If Meta rejects the message_echoes field itself, we retry ONCE with the
 * previous list, so the existing subscription keeps working exactly as before,
 * and log what to enable. Any other failure (network, timeout, rate limit,
 * 5xx, unexpected body) is retried ONCE with the full list after a short
 * pause, and never downgrades the list: a failed call leaves the Page's
 * current subscription as it was.
 *
 * The HTTP client, environment, logger and retry pause are injectable for
 * tests:
 *   subscribePageToMessaging({ axios: stub, env: {...}, logger: {...},
 *                              retryDelayMs: 0 })
 * The function never throws; it resolves to a small status object.
 */

"use strict";

const defaultAxios = require("axios");

const GRAPH_API = "https://graph.facebook.com/v24.0";

/** The field list used before echoes were added. Kept as the fallback. */
const BASE_SUBSCRIBED_FIELDS = [
  "messages",
  "messaging_postbacks",
  "message_deliveries",
  "message_reads",
  "messaging_referrals",
  "messaging_optins",
];

const ECHO_FIELD = "message_echoes";

const SUBSCRIBED_FIELDS_WITH_ECHOES = [...BASE_SUBSCRIBED_FIELDS, ECHO_FIELD];

const ECHO_SETUP_HINT =
  "[Startup] Meta refused the 'message_echoes' field, so replies sent from " +
  "Business Suite or the Messenger app will NOT be stored. Enable " +
  "'message_echoes' in the Meta App Dashboard (Webhooks > Page) for this " +
  "app, then restart the backend.";

const DEFAULT_RETRY_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;

/** Meta's error text only, never the request config (it holds the token). */
function describeFailure(err) {
  return err?.response?.data?.error?.message || err?.message || String(err);
}

/**
 * True only when Meta's error clearly rejects the field list itself (the
 * app is not set up for message_echoes), as opposed to a passing failure.
 */
function isFieldRejection(err) {
  const apiError = err?.response?.data?.error;
  if (!apiError) return false;
  const text = String(apiError.message || "");
  if (/message_echoes/i.test(text)) return true;
  return Number(apiError.code) === 100 && /subscribed_fields/i.test(text);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postSubscription(http, pageId, token, fields) {
  const res = await http.post(
    `${GRAPH_API}/${encodeURIComponent(pageId)}/subscribed_apps`,
    null,
    {
      params: {
        subscribed_fields: fields.join(","),
        access_token: token,
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  return res?.data;
}

/**
 * One attempt with the full list (message_echoes included).
 * @returns {Promise<{ok: boolean, rejected: boolean, problem?: *}>}
 */
async function tryFullList(http, pageId, token) {
  try {
    const data = await postSubscription(
      http,
      pageId,
      token,
      SUBSCRIBED_FIELDS_WITH_ECHOES,
    );
    if (data?.success) return { ok: true, rejected: false };
    return { ok: false, rejected: false, problem: data };
  } catch (err) {
    return {
      ok: false,
      rejected: isFieldRejection(err),
      problem: describeFailure(err),
    };
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.axios]  - HTTP client with axios' post() signature
 * @param {object} [options.env]    - environment (defaults to process.env)
 * @param {object} [options.logger] - console-like logger (log, warn)
 * @param {number} [options.retryDelayMs] - pause before retrying after a
 *   passing failure (default 5000)
 * @returns {Promise<{subscribed: boolean, echoes: boolean, skipped?: boolean}>}
 */
async function subscribePageToMessaging(options = {}) {
  const http = options.axios || defaultAxios;
  const env = options.env || process.env;
  const logger = options.logger || console;

  const pageId = env.FACEBOOK_PAGE_ID;
  const token = env.FACEBOOK_PAGE_ACCESS_TOKEN || env.INSTAGRAM_ACCESS_TOKEN;

  if (!pageId || !token) {
    logger.warn(
      "[Startup] Skipping page subscription: FACEBOOK_PAGE_ID or page token not set",
    );
    return { subscribed: false, echoes: false, skipped: true };
  }

  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, options.retryDelayMs)
    : DEFAULT_RETRY_DELAY_MS;
  const fullListOk = () => {
    logger.log(
      "[Startup] Page subscription to messaging: OK (message_echoes included)",
    );
    return { subscribed: true, echoes: true };
  };

  // 1) Preferred: the previous fields plus message_echoes.
  let attempt = await tryFullList(http, pageId, token);
  if (attempt.ok) return fullListOk();

  // A passing failure: try the full list once more, never downgrade.
  if (!attempt.rejected) {
    logger.warn(
      `[Startup] Page subscription failed, retrying in ${Math.round(retryDelayMs / 1000)} s:`,
      attempt.problem,
    );
    await wait(retryDelayMs);
    attempt = await tryFullList(http, pageId, token);
    if (attempt.ok) return fullListOk();
    if (!attempt.rejected) {
      logger.warn(
        "[Startup] Page subscription failed again (non-fatal); the Page keeps its current subscription:",
        attempt.problem,
      );
      return { subscribed: false, echoes: false };
    }
  }

  logger.warn(
    "[Startup] Page subscription with message_echoes was refused, retrying without it:",
    attempt.problem,
  );

  // 2) Meta refused the field: retry ONCE with the previous list, so the old
  // behaviour is preserved.
  try {
    const data = await postSubscription(
      http,
      pageId,
      token,
      BASE_SUBSCRIBED_FIELDS,
    );
    if (data?.success) {
      logger.log(
        "[Startup] Page subscription to messaging: OK (without message_echoes)",
      );
      logger.warn(ECHO_SETUP_HINT);
      return { subscribed: true, echoes: false };
    }
    logger.warn("[Startup] Page subscription response:", data);
  } catch (err) {
    logger.warn("[Startup] Page subscription failed (non-fatal):", describeFailure(err));
  }
  return { subscribed: false, echoes: false };
}

module.exports = {
  subscribePageToMessaging,
  BASE_SUBSCRIBED_FIELDS,
  SUBSCRIBED_FIELDS_WITH_ECHOES,
  ECHO_FIELD,
};
