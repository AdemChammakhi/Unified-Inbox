/**
 * pipeline.js — single source of truth for the commercial pipeline.
 *
 * Mirrored in client/src/constants/pipeline.js: keep the two in step.
 *
 * STAGES are management's steps ("Nouveau lead → … → Départ") plus two
 * that sit outside the line: "Client injoignable", a dossier on hold because
 * nobody can reach the customer, and "Perdu", the terminal stage that makes
 * loss analysis possible (see docs/PLAN-PILOTAGE-COMMERCIAL.md §2.2).
 * "En cours" (code qualification_en_cours), "Déplacement agence" and
 * "Client injoignable" were added on 29 Sept 2026 at management's request. TYPOLOGIES is the
 * nature of the request. Both replace the free-text era: values are codes,
 * labels are French.
 */

"use strict";

const STAGES = Object.freeze([
  { key: "nouveau_lead", label: "Nouveau lead", ordinal: 1 },
  { key: "a_contacter", label: "À contacter", ordinal: 2 },
  { key: "contact_etabli", label: "Contact établi", ordinal: 3 },
  // Shown as "En cours" (management's wording); the code keeps its full name
  { key: "qualification_en_cours", label: "En cours", ordinal: 4 },
  { key: "qualifie", label: "Qualifié", ordinal: 5 },
  { key: "offre_envoyee", label: "Offre envoyée", ordinal: 6 },
  { key: "en_reflexion", label: "En réflexion", ordinal: 7 },
  { key: "relance", label: "Relance", ordinal: 8 },
  { key: "deplacement_agence", label: "Déplacement agence", ordinal: 9 },
  { key: "reservation", label: "Réservation", ordinal: 10 },
  { key: "paiement", label: "Paiement", ordinal: 11 },
  { key: "dossier_confirme", label: "Dossier confirmé", ordinal: 12 },
  { key: "depart", label: "Départ", ordinal: 13, isWon: true },
  { key: "client_injoignable", label: "Client injoignable", ordinal: 90, isOnHold: true },
  { key: "perdu", label: "Perdu", ordinal: 99, isLost: true },
]);

const STAGE_KEYS = STAGES.map((s) => s.key);
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
const DEFAULT_STAGE = "nouveau_lead";

/** Stages where the customer has committed (booking or later). */
const ENGAGED_STAGES = new Set(["reservation", "paiement", "dossier_confirme", "depart"]);

/** The customer is expected at the agency: as warm as a lead gets. */
const AGENCY_VISIT_STAGE = "deplacement_agence";

/** Nobody can reach the customer: on hold until they write again. */
const UNREACHABLE_STAGE = "client_injoignable";

const TYPOLOGIES = Object.freeze([
  { key: "omra", label: "Omra" },
  { key: "visa", label: "Visa" },
  { key: "billetterie", label: "Billetterie" },
  { key: "hotels_sejours", label: "Hôtels / Séjours" },
  { key: "voyages_organises", label: "Voyages organisés" },
  { key: "transferts", label: "Transferts" },
  { key: "excursions", label: "Excursions / visites" },
  { key: "autres_services", label: "Autres services" },
]);

const TYPOLOGY_KEYS = TYPOLOGIES.map((t) => t.key);
const TYPOLOGY_LABEL = Object.fromEntries(TYPOLOGIES.map((t) => [t.key, t.label]));

/**
 * How the six pre-pipeline classifications map onto a stage (the mapping
 * approved in docs/PLAN-PILOTAGE-COMMERCIAL.md §4). "priorite" also sets the
 * isPriority flag; "rdv" keeps its appointment date, which is now independent
 * of the stage.
 */
const LEGACY_TO_STAGE = Object.freeze({
  non_classifie: "nouveau_lead",
  cible: "qualifie",
  hors_cible: "perdu",
  suivi: "relance",
  priorite: "a_contacter",
  rdv: "qualifie",
});

const isStage = (v) => typeof v === "string" && STAGE_LABEL[v] !== undefined;
const isTypology = (v) => typeof v === "string" && TYPOLOGY_LABEL[v] !== undefined;

module.exports = {
  STAGES,
  STAGE_KEYS,
  STAGE_LABEL,
  DEFAULT_STAGE,
  ENGAGED_STAGES,
  AGENCY_VISIT_STAGE,
  UNREACHABLE_STAGE,
  TYPOLOGIES,
  TYPOLOGY_KEYS,
  TYPOLOGY_LABEL,
  LEGACY_TO_STAGE,
  isStage,
  isTypology,
};
