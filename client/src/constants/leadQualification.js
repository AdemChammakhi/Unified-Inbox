/**
 * leadQualification.js — shared vocabulary for lead maturity and freins.
 *
 * Codes and labels mirror server/utils/leadFrein.js and
 * server/utils/leadMaturity.js; keep both sides in step.
 */

/** Main need or obstacle recorded at the end of an exchange. */
export const FREINS = [
  { code: "prix", label: "Prix" },
  { code: "dates", label: "Dates" },
  { code: "distance", label: "Distance / proximité" },
  { code: "hebergement", label: "Hébergement" },
  { code: "transport", label: "Transport" },
  { code: "disponibilite", label: "Disponibilité" },
  { code: "comparaison", label: "Comparaison avec une autre offre" },
  { code: "autre", label: "Autre" },
];

/**
 * Lead maturity levels, computed by the server. A prospect who is answering
 * is Chaud and only silence cools a lead; Gagné and Perdu are closed
 * dossiers, not temperatures.
 */
export const MATURITY = {
  chaud: { label: "Chaud", color: "#D9534F" },
  tiede: { label: "Tiède", color: "#E3A63C" },
  froid: { label: "Froid", color: "#5B9BD9" },
  gagne: { label: "Gagné", color: "#3FA37A" },
  perdu: { label: "Perdu", color: "#8A93A6" },
};

/** Level order, hottest first; closed dossiers last. */
export const MATURITY_RANK = { chaud: 0, tiede: 1, froid: 2, gagne: 3, perdu: 4 };

/** Rank of a conversation whose maturity is not known (yet). */
export const UNKNOWN_MATURITY_RANK = 10;

/**
 * Position in the "maturity" sort: by level, and inside a level the
 * prospects waiting for our answer come first.
 */
export const maturitySortRank = (maturity) => {
  const rank = MATURITY_RANK[maturity?.level];
  if (rank === undefined) return UNKNOWN_MATURITY_RANK;
  return rank * 2 + (maturity.awaitingReply ? 0 : 1);
};

/** Conversation list orderings. */
export const SORT_MODES = [
  { key: "recent", label: "Plus récents" },
  { key: "received", label: "Plus de messages reçus" },
  { key: "maturity", label: "Maturité (à répondre, puis chaud)" },
];
