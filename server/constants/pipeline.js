/**
 * pipeline.js — single source of truth for the lead model.
 *
 * Mirrored in client/src/constants/pipeline.js: keep the two in step.
 *
 * The model is the SQL Server scripts' (database/sqlserver/schema, revised
 * 5 Oct 2026, used unaltered). A lead carries two independent fields:
 *
 *  - STAGES, the "Étape": the sales funnel step reached, stored in
 *    conversations.classification_id. The labels are exactly those
 *    CK_classifications_label allows.
 *  - QUALIFICATIONS, the "Qualification": where the lead stands now, loss
 *    reasons included, stored in conversations.qualification_id; each change
 *    is a row of conversation_qualification_history. The labels are exactly
 *    those CK_qualifications_label allows. `group` is the
 *    qualification_group the warehouse reads ("Gagné" counts as won).
 *
 * TYPOLOGIES is the nature of the request (motifs_contact). Values are codes,
 * labels are French.
 */

"use strict";

const STAGES = Object.freeze([
  { key: "nouveau_lead", label: "Nouveau lead", ordinal: 1 },
  { key: "contact_etabli", label: "Contact établi", ordinal: 2 },
  { key: "offre_presentee", label: "Offre présentée", ordinal: 3 },
  { key: "devis_envoye", label: "Devis envoyé", ordinal: 4 },
  { key: "reservation_passee", label: "Réservation passée", ordinal: 5 },
  { key: "paiement_en_cours", label: "Paiement en cours", ordinal: 6 },
  { key: "dossier_confirme", label: "Dossier confirmé", ordinal: 7 },
]);

const QUALIFICATIONS = Object.freeze([
  { key: "nouveau_lead", label: "Nouveau lead", group: "Nouveau", terminal: false, ordinal: 1 },
  { key: "en_attente_reponse", label: "En attente de réponse", group: "En cours", terminal: false, ordinal: 2 },
  { key: "en_cours", label: "En cours", group: "En cours", terminal: false, ordinal: 3 },
  { key: "en_reflexion", label: "En réflexion", group: "En cours", terminal: false, ordinal: 4 },
  { key: "dossier_confirme", label: "Dossier confirmé", group: "Gagné", terminal: true, ordinal: 5 },
  { key: "injoignable", label: "Injoignable", group: "Perdu", terminal: false, ordinal: 6 },
  { key: "non_interesse", label: "Non intéressé", group: "Perdu", terminal: true, ordinal: 7 },
  { key: "prix_trop_eleve", label: "Prix trop élevé", group: "Perdu", terminal: true, ordinal: 8 },
  { key: "offre_concurrente", label: "Offre concurrente", group: "Perdu", terminal: true, ordinal: 9 },
  { key: "reservation_annulee", label: "Réservation annulée", group: "Perdu", terminal: true, ordinal: 10 },
]);

const STAGE_KEYS = STAGES.map((s) => s.key);
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
const DEFAULT_STAGE = "nouveau_lead";

const QUALIFICATION_KEYS = QUALIFICATIONS.map((q) => q.key);
const QUALIFICATION_LABEL = Object.fromEntries(QUALIFICATIONS.map((q) => [q.key, q.label]));
const QUALIFICATION_GROUP = Object.fromEntries(QUALIFICATIONS.map((q) => [q.key, q.group]));
const DEFAULT_QUALIFICATION = "nouveau_lead";

/** Funnel steps where the customer has committed (booking or later). */
const ENGAGED_STAGES = new Set(["reservation_passee", "paiement_en_cours", "dossier_confirme"]);

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
 * The 12-stage pipeline the app used until the revised scripts (Oct 2026),
 * as [stage, qualification] of the current model. Only the one-time MongoDB
 * migration reads it. A lost lead's funnel step was never recorded, so it
 * restarts at the first step; its loss reason comes from its frein when one
 * was recorded (LOSS_REASON_BY_FREIN), else "Non intéressé".
 */
const PREVIOUS_STAGE_TO_MODEL = Object.freeze({
  nouveau_lead: ["nouveau_lead", "nouveau_lead"],
  a_contacter: ["nouveau_lead", "en_cours"],
  contact_etabli: ["contact_etabli", "en_cours"],
  qualifie: ["contact_etabli", "en_cours"],
  offre_envoyee: ["offre_presentee", "en_attente_reponse"],
  en_reflexion: ["offre_presentee", "en_reflexion"],
  relance: ["offre_presentee", "en_attente_reponse"],
  reservation: ["reservation_passee", "en_cours"],
  paiement: ["paiement_en_cours", "en_cours"],
  dossier_confirme: ["dossier_confirme", "dossier_confirme"],
  depart: ["dossier_confirme", "dossier_confirme"],
  perdu: ["nouveau_lead", "non_interesse"],
});

/** Frein codes (utils/leadFrein.js) that name a loss reason of the model. */
const LOSS_REASON_BY_FREIN = Object.freeze({
  prix: "prix_trop_eleve",
  comparaison: "offre_concurrente",
});

/**
 * How the six classifications that predate the 12-stage pipeline mapped onto
 * it (docs/PLAN-PILOTAGE-COMMERCIAL.md §4); the migration chains it through
 * PREVIOUS_STAGE_TO_MODEL.
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
const isQualification = (v) => typeof v === "string" && QUALIFICATION_LABEL[v] !== undefined;
const isTypology = (v) => typeof v === "string" && TYPOLOGY_LABEL[v] !== undefined;
const isLostQualification = (v) => QUALIFICATION_GROUP[v] === "Perdu";
const isWonQualification = (v) => QUALIFICATION_GROUP[v] === "Gagné";

module.exports = {
  STAGES,
  STAGE_KEYS,
  STAGE_LABEL,
  DEFAULT_STAGE,
  ENGAGED_STAGES,
  QUALIFICATIONS,
  QUALIFICATION_KEYS,
  QUALIFICATION_LABEL,
  QUALIFICATION_GROUP,
  DEFAULT_QUALIFICATION,
  TYPOLOGIES,
  TYPOLOGY_KEYS,
  TYPOLOGY_LABEL,
  PREVIOUS_STAGE_TO_MODEL,
  LOSS_REASON_BY_FREIN,
  LEGACY_TO_STAGE,
  isStage,
  isQualification,
  isTypology,
  isLostQualification,
  isWonQualification,
};
