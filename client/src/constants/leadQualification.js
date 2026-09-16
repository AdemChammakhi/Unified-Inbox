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

/** Lead maturity levels, computed by the server. */
export const MATURITY = {
  chaud: { label: "Chaud", color: "#D9534F" },
  tiede: { label: "Tiède", color: "#E3A63C" },
  froid: { label: "Froid", color: "#5B9BD9" },
};

/** Sort order for the "maturity" mode, hottest first. */
export const MATURITY_RANK = { chaud: 0, tiede: 1, froid: 2 };

/** Conversation list orderings. */
export const SORT_MODES = [
  { key: "recent", label: "Plus récents" },
  { key: "received", label: "Plus de messages reçus" },
  { key: "maturity", label: "Maturité (chaud d'abord)" },
];
