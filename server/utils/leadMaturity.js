/**
 * leadMaturity.js — how warm a lead is, derived at read time.
 *
 *   Chaud  confirmed need, near project, strong intent
 *   Tiède  real interest, decision pending for a specific reason
 *   Froid  low interest, distant project, too little information, or silent
 *
 * Nothing is stored: the level is recomputed from dates, message counts, the
 * classification and the recorded frein every time it is read. Pure function,
 * no database access; `now` is injectable so the rules can be tested.
 */

"use strict";

const { freinLabel } = require("./leadFrein");
const { ENGAGED_STAGES, STAGE_LABEL } = require("../constants/pipeline");

const THRESHOLDS = Object.freeze({
  HOT_RECENT_DAYS: 3,
  HOT_MIN_INCOMING: 3,
  SILENT_DAYS: 14,
  MIN_INCOMING_FOR_INTEREST: 2,
  RDV_GRACE_DAYS: 1,
});

const LEVELS = Object.freeze({
  chaud: "Chaud",
  tiede: "Tiède",
  froid: "Froid",
});

/** Sort order, hottest first. */
const LEVEL_RANK = Object.freeze({ chaud: 0, tiede: 1, froid: 2 });

const DAY_MS = 86400000;

const ddmm = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Africa/Tunis",
  day: "2-digit",
  month: "2-digit",
});

function toTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function daysSince(value, nowMs) {
  const t = toTime(value);
  if (t === null) return null;
  return Math.floor((nowMs - t) / DAY_MS);
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "1 message" / "3 messages" (French: 0 and 1 are singular). */
function plural(n, singular, pluralForm) {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

function activity(days) {
  if (days <= 0) return "aujourd’hui";
  if (days === 1) return "hier";
  return `il y a ${days} j`;
}

function result(level, reason) {
  return { level, label: LEVELS[level], reason };
}

/**
 * @param {object} p
 * @param {number} p.messagesIn        messages received from the prospect
 * @param {number} p.messagesOut       replies sent to the prospect
 * @param {Date|string|null} p.lastIncomingAt
 * @param {Date|string|null} [p.lastOutgoingAt]  accepted for callers; no rule uses it yet
 * @param {string|null} p.stage          Pipeline stage code (server/constants/pipeline.js)
 * @param {boolean} [p.isPriority]       Agent's urgency flag
 * @param {Date|string|null} p.appointmentAt  RDV date, independent of the stage
 * @param {{code: string, note?: string}|null} p.frein
 * @param {Date|number} [p.now]
 * @returns {{level: "chaud"|"tiede"|"froid", label: string, reason: string}}
 */
function computeMaturity(p = {}) {
  const nowMs = toTime(p.now) ?? Date.now();
  const messagesIn = count(p.messagesIn);
  const messagesOut = count(p.messagesOut);
  const stage = typeof p.stage === "string" ? p.stage : "";

  // 1. Lost: nothing else matters
  if (stage === "perdu") return result("froid", "Perdu");

  // 2. The customer has committed (booking, payment, confirmed, departed)
  if (ENGAGED_STAGES.has(stage)) {
    return result("chaud", STAGE_LABEL[stage] || "Dossier engagé");
  }

  // 3. Appointment booked and not long past
  const at = toTime(p.appointmentAt);
  if (at !== null && at >= nowMs - THRESHOLDS.RDV_GRACE_DAYS * DAY_MS) {
    return result("chaud", `RDV le ${ddmm.format(new Date(at))}`);
  }

  // 4. The prospect never wrote
  if (messagesIn === 0) return result("froid", "Aucun message du prospect");

  // 5. The prospect went quiet
  const silentFor = daysSince(p.lastIncomingAt, nowMs);
  if (silentFor !== null && silentFor >= THRESHOLDS.SILENT_DAYS) {
    return result("froid", `Silencieux depuis ${silentFor} j`);
  }

  // 6. An agent flagged it
  if (p.isPriority === true) return result("chaud", "Marqué prioritaire");

  // 6. A named obstacle: interest is real, the decision is pending
  const frein = freinLabel(p.frein);
  if (frein) return result("tiede", `Frein : ${frein}`);

  // 7. A live conversation with enough substance
  if (
    messagesIn >= THRESHOLDS.HOT_MIN_INCOMING &&
    messagesOut >= 1 &&
    silentFor !== null &&
    silentFor <= THRESHOLDS.HOT_RECENT_DAYS
  ) {
    return result(
      "chaud",
      `${plural(messagesIn, "message reçu", "messages reçus")}, actif ${activity(silentFor)}`,
    );
  }

  // 8. Not enough to go on
  if (messagesIn < THRESHOLDS.MIN_INCOMING_FOR_INTEREST) {
    return result(
      "froid",
      `Informations insuffisantes (${plural(messagesIn, "message", "messages")})`,
    );
  }

  // 9. Everything else is an exchange in progress
  return result(
    "tiede",
    `Échange en cours (${plural(messagesIn, "message reçu", "messages reçus")})`,
  );
}

module.exports = {
  THRESHOLDS,
  LEVELS,
  LEVEL_RANK,
  computeMaturity,
};
