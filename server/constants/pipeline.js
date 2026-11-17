/**
 * pipeline.js — single source of truth for the commercial pipeline.
 *
 * Mirrored in client/src/constants/pipeline.js: keep the two in step.
 *
 * STAGES are management's steps ("Nouveau lead → … → Départ") plus three
 * that sit outside the line: "Injoignable", a dossier on hold because
 * nobody can reach the customer, then "Non intéressé" and "Perdu", the
 * closing stages that make loss analysis possible (see
 * docs/PLAN-PILOTAGE-COMMERCIAL.md §2.2).
 * "En cours" (code qualification_en_cours), "Déplacement agence" and
 * "Injoignable" (client_injoignable) were added on 29 Sept 2026 at
 * management's request. Labels, the "non_interesse" stage and the typology
 * labels follow the process document PROC-GRC-V01 (« Processus opérationnel
 * de gestion des leads », Oct 2026). TYPOLOGIES is the nature of the
 * request. Both replace the free-text era: values are codes, labels are
 * French.
 *
 * Storage (database/sqlserver, decision D10): the SQL Server scripts know
 * no stage. They hold two fields with fixed label lists, an "Étape"
 * (`classifications`, 7 funnel steps) and a "Qualification"
 * (`qualifications`, 10 statuses in the groups Nouveau / En cours / Gagné /
 * Perdu). Each stage is stored as one fixed, distinct (Étape, Qualification)
 * pair — STAGE_TO_PAIR — and read back from it. Power BI reads the two
 * fields; the agents see the stages.
 */

"use strict";

const STAGES = Object.freeze([
  { key: "nouveau_lead", label: "Nouveau lead", ordinal: 1 },
  { key: "a_contacter", label: "À contacter", ordinal: 2 },
  { key: "contact_etabli", label: "Contact établi", ordinal: 3 },
  // Shown as "En cours" (management's wording); the code keeps its full name
  { key: "qualification_en_cours", label: "En cours", ordinal: 4 },
  { key: "qualifie", label: "Qualifié", ordinal: 5 },
  { key: "offre_envoyee", label: "Offre envoyée / Devis envoyé", ordinal: 6 },
  { key: "en_reflexion", label: "En réflexion", ordinal: 7 },
  { key: "relance", label: "À rappeler / Relance", ordinal: 8 },
  { key: "deplacement_agence", label: "Déplacement agence", ordinal: 9 },
  { key: "reservation", label: "Réservation", ordinal: 10 },
  { key: "paiement", label: "Paiement", ordinal: 11 },
  { key: "dossier_confirme", label: "Dossier confirmé", ordinal: 12 },
  { key: "depart", label: "Départ", ordinal: 13, isWon: true },
  { key: "client_injoignable", label: "Injoignable", ordinal: 90, isOnHold: true },
  { key: "non_interesse", label: "Non intéressé", ordinal: 95, isLost: true },
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

// ─── The two fields of the SQL Server scripts ────────────────────────────────

/**
 * "Étape": the only labels CK_classifications_label allows, in funnel
 * order. "Nouveau lead" is the step of every new conversation.
 */
const ETAPES = Object.freeze([
  { key: "nouveau_lead", label: "Nouveau lead", ordinal: 1 },
  { key: "contact_etabli", label: "Contact établi", ordinal: 2 },
  { key: "offre_presentee", label: "Offre présentée", ordinal: 3 },
  { key: "devis_envoye", label: "Devis envoyé", ordinal: 4 },
  { key: "reservation_passee", label: "Réservation passée", ordinal: 5 },
  { key: "paiement_en_cours", label: "Paiement en cours", ordinal: 6 },
  { key: "dossier_confirme", label: "Dossier confirmé", ordinal: 7 },
]);

/**
 * "Qualification": the only labels CK_qualifications_label allows, each in
 * the group the warehouse reads ("Gagné" counts as won) with its terminal
 * flag (decision E22). The app owns the groups: the scripts' lead import
 * files a label it does not know under Nouveau.
 */
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

/**
 * Stage → [Étape key, Qualification key]. Sixteen distinct pairs, so a
 * stored pair names exactly one stage (PAIR_TO_STAGE). The Étape follows
 * the funnel step the stage sits at; the Qualification tells the lead's
 * status there, and its group is what the warehouse counts: only "Départ"
 * is won (group Gagné), the three closing stages are lost (group Perdu).
 * A pair no stage owns (one written by the scripts' lead import, or by a
 * hand edit) reads as the stage of its Étape alone, see stageOfPair.
 */
const STAGE_TO_PAIR = Object.freeze({
  nouveau_lead: ["nouveau_lead", "nouveau_lead"],
  a_contacter: ["nouveau_lead", "en_attente_reponse"],
  contact_etabli: ["contact_etabli", "nouveau_lead"],
  qualification_en_cours: ["contact_etabli", "en_cours"],
  qualifie: ["contact_etabli", "en_attente_reponse"],
  offre_envoyee: ["offre_presentee", "en_attente_reponse"],
  en_reflexion: ["offre_presentee", "en_reflexion"],
  relance: ["devis_envoye", "en_attente_reponse"],
  deplacement_agence: ["devis_envoye", "en_cours"],
  reservation: ["reservation_passee", "en_cours"],
  paiement: ["paiement_en_cours", "en_cours"],
  dossier_confirme: ["dossier_confirme", "en_cours"],
  depart: ["dossier_confirme", "dossier_confirme"],
  client_injoignable: ["nouveau_lead", "injoignable"],
  non_interesse: ["nouveau_lead", "non_interesse"],
  perdu: ["contact_etabli", "non_interesse"],
});

const PAIR_TO_STAGE = Object.freeze(
  Object.fromEntries(Object.entries(STAGE_TO_PAIR).map(([stage, [e, q]]) => [`${e}|${q}`, stage])),
);

/** The stage of an Étape alone, for a pair no stage owns: its first stage on the line. */
const ETAPE_TO_STAGE = Object.freeze({
  nouveau_lead: "nouveau_lead",
  contact_etabli: "contact_etabli",
  offre_presentee: "offre_envoyee",
  devis_envoye: "relance",
  reservation_passee: "reservation",
  paiement_en_cours: "paiement",
  dossier_confirme: "dossier_confirme",
});

/**
 * The stage a stored (Étape key, Qualification key) pair means. A pair no
 * stage owns is read by its qualification when that settles it (won, lost,
 * unreachable), else by its Étape.
 */
function stageOfPair(etapeKey, qualificationKey) {
  const owned = PAIR_TO_STAGE[`${etapeKey}|${qualificationKey}`];
  if (owned) return owned;
  if (qualificationKey === "dossier_confirme") return "depart";
  if (qualificationKey === "injoignable") return UNREACHABLE_STAGE;
  if (qualificationKey === "non_interesse") return "non_interesse";
  if (["reservation_annulee", "prix_trop_eleve", "offre_concurrente"].includes(qualificationKey)) return "perdu";
  return ETAPE_TO_STAGE[etapeKey] || DEFAULT_STAGE;
}

const TYPOLOGIES = Object.freeze([
  { key: "omra", label: "Omra" },
  { key: "omra_a_la_carte", label: "Omra à la carte" },
  { key: "voyages_organises", label: "Voyages organisés" },
  // Relabelled by PROC-GRC-V01; the motifs_contact row keeps its id and is renamed
  { key: "hotels_sejours", label: "Hôtels en Tunisie", previousLabels: ["Hôtels / Séjours"] },
  { key: "visa", label: "Visa" },
  { key: "billetterie", label: "Billetterie" },
  { key: "transferts", label: "Transferts" },
  { key: "excursions", label: "Excursions / visites" },
  { key: "autres_services", label: "Autres prestations", previousLabels: ["Autres services"] },
]);

const TYPOLOGY_KEYS = TYPOLOGIES.map((t) => t.key);
const TYPOLOGY_LABEL = Object.fromEntries(TYPOLOGIES.map((t) => [t.key, t.label]));

/**
 * How the six pre-pipeline classifications map onto a stage (the mapping
 * approved in docs/PLAN-PILOTAGE-COMMERCIAL.md §4). "priorite" also sets the
 * isPriority flag; "rdv" keeps its appointment date, which is now independent
 * of the stage. Only the one-time MongoDB migration reads it.
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
  ETAPES,
  QUALIFICATIONS,
  STAGE_TO_PAIR,
  PAIR_TO_STAGE,
  stageOfPair,
  TYPOLOGIES,
  TYPOLOGY_KEYS,
  TYPOLOGY_LABEL,
  LEGACY_TO_STAGE,
  isStage,
  isTypology,
};
