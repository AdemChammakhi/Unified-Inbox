/**
 * leadMaturity.js — how warm a lead is, derived at read time.
 *
 * The rule management settled on (29 Sept 2026): a prospect who is answering
 * is Chaud, and only time cools a lead.
 *
 *   Chaud  the prospect wrote recently, or is waiting for our answer, or the
 *          dossier says so (a booking stage, a visit to the agency, an RDV,
 *          the priority flag)
 *   Tiède  we answered last and the prospect has been quiet for a few days,
 *          or the stage says nobody can reach them
 *   Froid  silent for SILENT_DAYS, or never wrote
 *   Gagné  the trip took place (stage "Départ"): a customer, not a lead
 *   Perdu  stage "Perdu"
 *
 * The number of messages decides nothing: a first message is as hot as the
 * tenth. The frein does not move the level either — it rides in the reason
 * as the explanation.
 *
 * `awaitingReply` says the prospect wrote last and nobody has answered
 * since. It is reported whatever the level: an unanswered message keeps a
 * lead Chaud until the silence threshold, and is still flagged after it.
 *
 * Nothing is stored: the level is recomputed from dates, the dossier and the
 * recorded frein every time it is read. Pure function, no database access;
 * `now` is injectable so the rules can be tested.
 */

"use strict";

const { freinLabel } = require("./leadFrein");
const {
  ENGAGED_STAGES,
  AGENCY_VISIT_STAGE,
  UNREACHABLE_STAGE,
  STAGE_LABEL,
} = require("../constants/pipeline");

const THRESHOLDS = Object.freeze({
  /** The prospect wrote within this many days: Chaud. */
  HOT_RECENT_DAYS: 3,
  /** Same, once the lead is qualified or holds an offer: a longer think. */
  HOT_ADVANCED_DAYS: 7,
  /** Quiet for this long: Froid. */
  SILENT_DAYS: 14,
  /** A past RDV still counts this long, while its outcome gets recorded. */
  RDV_GRACE_DAYS: 3,
});

/** Stages whose prospects are given HOT_ADVANCED_DAYS. */
const ADVANCED_STAGES = new Set(["qualifie", "offre_envoyee"]);

const LEVELS = Object.freeze({
  chaud: "Chaud",
  tiede: "Tiède",
  froid: "Froid",
  gagne: "Gagné",
  perdu: "Perdu",
});

/** Sort order, hottest first; closed dossiers last. */
const LEVEL_RANK = Object.freeze({
  chaud: 0,
  tiede: 1,
  froid: 2,
  gagne: 3,
  perdu: 4,
});

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

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function activity(days) {
  if (days <= 0) return "aujourd’hui";
  if (days === 1) return "hier";
  return `il y a ${days} j`;
}

/**
 * @param {object} p
 * @param {number} p.messagesIn        messages received from the prospect
 * @param {Date|string|null} p.lastIncomingAt  newest message FROM the prospect
 * @param {Date|string|null} [p.lastOutgoingAt] newest delivered reply TO them
 * @param {string|null} p.stage          Pipeline stage code (server/constants/pipeline.js)
 * @param {boolean} [p.isPriority]       Agent's urgency flag
 * @param {Date|string|null} p.appointmentAt  RDV date, independent of the stage
 * @param {{code: string, note?: string}|null} p.frein
 * @param {Date|number} [p.now]
 * @returns {{level: "chaud"|"tiede"|"froid"|"gagne"|"perdu", label: string,
 *            reason: string, awaitingReply: boolean}}
 */
function computeMaturity(p = {}) {
  const nowMs = toTime(p.now) ?? Date.now();
  const messagesIn = count(p.messagesIn);
  const stage = typeof p.stage === "string" ? p.stage : "";
  const lastIn = toTime(p.lastIncomingAt);
  const lastOut = toTime(p.lastOutgoingAt);

  // The prospect wrote last and nobody has answered since
  const awaitingReply =
    messagesIn > 0 && lastIn !== null && (lastOut === null || lastIn > lastOut);

  const frein = freinLabel(p.frein);
  const because = (reason) => (frein ? `${reason} · Frein : ${frein}` : reason);
  const out = (level, reason) => ({
    level,
    label: LEVELS[level],
    reason,
    awaitingReply,
  });

  // 1. Closed dossiers are not leads any more
  if (stage === "perdu") return out("perdu", because("Dossier perdu"));
  if (stage === "depart") return out("gagne", "Départ effectué");

  // 2. The customer has committed (booking, payment, confirmed dossier)
  if (ENGAGED_STAGES.has(stage)) {
    return out("chaud", because(STAGE_LABEL[stage] || "Dossier engagé"));
  }

  // 3. An appointment, coming or just held
  const at = toTime(p.appointmentAt);
  if (at !== null && at >= nowMs - THRESHOLDS.RDV_GRACE_DAYS * DAY_MS) {
    const day = ddmm.format(new Date(at));
    return out(
      "chaud",
      because(at >= nowMs ? `RDV le ${day}` : `RDV du ${day}, suite à donner`),
    );
  }

  // 4. The customer is expected at the agency
  if (stage === AGENCY_VISIT_STAGE) {
    return out("chaud", because("Déplacement agence"));
  }

  // 5. Nobody can reach the customer: Tiède at once, Froid once the silence
  //    threshold passes — unless they wrote again and wait for our answer,
  //    which makes them reachable, and Chaud. The clock is their last
  //    message, or our last attempt when they never wrote.
  if (stage === UNREACHABLE_STAGE) {
    const clock = lastIn ?? lastOut;
    const quiet =
      clock === null ? null : Math.max(0, Math.floor((nowMs - clock) / DAY_MS));
    if (quiet !== null && quiet >= THRESHOLDS.SILENT_DAYS) {
      return out("froid", because(`Client injoignable depuis ${quiet} j`));
    }
    if (awaitingReply) {
      return out(
        "chaud",
        because(`À répondre — le client a réécrit ${activity(quiet)}`),
      );
    }
    return out("tiede", because("Client injoignable"));
  }

  // 6. An agent's judgement is never overruled by a clock
  if (p.isPriority === true) return out("chaud", because("Marqué prioritaire"));

  // 7. Nothing from the prospect to measure
  if (messagesIn === 0) return out("froid", "Aucun message du prospect");
  if (lastIn === null) return out("tiede", because("Échange en cours"));

  // 8. Time since the prospect last wrote is the whole rule from here on
  const silentFor = Math.max(0, Math.floor((nowMs - lastIn) / DAY_MS));

  if (silentFor >= THRESHOLDS.SILENT_DAYS) {
    return out("froid", because(`Silencieux depuis ${silentFor} j`));
  }
  // They are waiting on us: the lead has not cooled, we are late
  if (awaitingReply) {
    return out(
      "chaud",
      because(`À répondre — message reçu ${activity(silentFor)}`),
    );
  }
  const hotDays = ADVANCED_STAGES.has(stage)
    ? THRESHOLDS.HOT_ADVANCED_DAYS
    : THRESHOLDS.HOT_RECENT_DAYS;
  if (silentFor <= hotDays) {
    return out("chaud", because(`Prospect actif ${activity(silentFor)}`));
  }
  return out("tiede", because(`Sans nouvelles depuis ${silentFor} j`));
}

module.exports = {
  THRESHOLDS,
  LEVELS,
  LEVEL_RANK,
  computeMaturity,
};
