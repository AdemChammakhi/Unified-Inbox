/**
 * metaSendError.js — turn a Meta Send API failure into something an agent
 * can act on.
 *
 * Agents are not developers: "(#100) Param message[text] must be less than
 * 1000 characters" is a support ticket, while "Message trop long (1 240
 * caractères) — Instagram limite à 1 000" is a fix they make in five seconds.
 *
 * Rule of the module: the raw Meta text is ALWAYS carried through in `error`,
 * even when we recognise the case. Nothing is ever swallowed — a failure we
 * cannot classify must still tell the agent what Meta said, because a generic
 * "Failed to send message" strands them with no next step.
 */

"use strict";

/** Meta's own text limits, per platform. */
const TEXT_LIMITS = { instagram: 1000, facebook: 2000, whatsapp: 4096 };

const PLATFORM_LABEL = {
  instagram: "Instagram",
  facebook: "Messenger",
  whatsapp: "WhatsApp",
};

/**
 * @param {Error} err - the axios error from the Send API call
 * @param {string} platform
 * @returns {{status: number, message: string, error: string|undefined}}
 */
function describeMetaSendError(err, platform) {
  const meta = err?.response?.data?.error;
  const raw = meta?.message || err?.message || "";
  const code = meta?.code;
  const sub = meta?.error_subcode;
  const label = PLATFORM_LABEL[platform] || platform;

  // No Meta error body: a transport problem, not a rejection
  if (!meta) {
    if (err?.code === "ECONNABORTED" || /timeout/i.test(raw)) {
      return {
        status: 504,
        message:
          "Meta n'a pas répondu à temps. Le message n'est pas parti — réessayez.",
        error: raw,
      };
    }
    return {
      status: 502,
      message: `Impossible de joindre ${label}. Réessayez dans un instant.`,
      error: raw,
    };
  }

  // Outside the 24-hour reply window
  if (code === 10 || sub === 2018278 || sub === 2534022) {
    return {
      status: 400,
      message:
        "Ce client a écrit il y a plus de 24 heures — Meta bloque les réponses au-delà. " +
        "La conversation se rouvre dès qu'il vous écrit à nouveau.",
      error: raw,
    };
  }

  // HUMAN_AGENT tag not approved for this app
  if (code === 100 && /cannot tag/i.test(raw)) {
    return {
      status: 400,
      message:
        "Fenêtre de réponse expirée, et l'app n'a pas l'autorisation « Human Agent » pour l'étendre. " +
        "La conversation se rouvre quand le client réécrit.",
      error: raw,
    };
  }

  // Standard Access: only people with a role on the app can be messaged
  if (code === 200) {
    return {
      status: 400,
      message:
        `${label} bloque les réponses aux vrais clients : l'app n'a que l'accès Standard. ` +
        "Demandez l'accès avancé (App Review) sur developers.facebook.com.",
      error: raw,
    };
  }

  // Message too long — the single most common cause for a long quote
  const limit = TEXT_LIMITS[platform];
  if (/must be less than|too long|length/i.test(raw) && /message|text/i.test(raw)) {
    return {
      status: 400,
      message: limit
        ? `Message trop long pour ${label} (limite : ${limit} caractères). Envoyez-le en deux fois.`
        : `Message trop long pour ${label}. Envoyez-le en deux fois.`,
      error: raw,
    };
  }

  // Recipient not reachable by this Page
  if ((code === 100 && sub === 2018001) || /no matching user/i.test(raw)) {
    return {
      status: 400,
      message:
        "Destinataire introuvable pour cette page. La conversation vient peut-être d'un autre canal — répondez depuis le bon onglet.",
      error: raw,
    };
  }

  // Person unavailable: blocked the page, deactivated, or restricted
  if (code === 551 || sub === 1545041 || /not available/i.test(raw)) {
    return {
      status: 400,
      message:
        "Ce compte n'est plus joignable (client ayant bloqué la page ou compte désactivé).",
      error: raw,
    };
  }

  // Rate limited by Meta
  if (code === 4 || code === 17 || code === 613 || code === 32) {
    return {
      status: 429,
      message:
        "Meta limite temporairement les envois. Patientez quelques minutes puis réessayez.",
      error: raw,
    };
  }

  // Token trouble
  if (code === 190) {
    return {
      status: 401,
      message:
        "Le jeton d'accès Meta a expiré ou est invalide. Prévenez l'administrateur.",
      error: raw,
    };
  }

  // Unclassified — surface Meta's own words rather than a dead end
  return {
    status: 502,
    message: raw
      ? `${label} a refusé l'envoi : ${raw}`
      : `${label} a refusé l'envoi (raison non précisée).`,
    error: raw,
    code,
    subcode: sub,
  };
}

module.exports = { describeMetaSendError, TEXT_LIMITS };
