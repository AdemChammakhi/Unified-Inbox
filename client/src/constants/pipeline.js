/**
 * The lead model, as shown to agents. Mirror of
 * server/constants/pipeline.js — keep the two in step.
 *
 * A lead carries two independent fields: its Étape (STAGES, the sales
 * funnel step reached) and its Qualification (QUALIFICATIONS, where it
 * stands now, loss reasons included).
 */

export const STAGES = [
  { key: "nouveau_lead", label: "Nouveau lead", color: "#6E7A96" },
  { key: "contact_etabli", label: "Contact établi", color: "#5B9BD9" },
  { key: "offre_presentee", label: "Offre présentée", color: "#4EC3C3" },
  { key: "devis_envoye", label: "Devis envoyé", color: "#A98BD6" },
  { key: "reservation_passee", label: "Réservation passée", color: "#3FA37A" },
  { key: "paiement_en_cours", label: "Paiement en cours", color: "#2E8B57" },
  { key: "dossier_confirme", label: "Dossier confirmé", color: "#1F7A4F" },
];

export const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
export const STAGE_COLORS = Object.fromEntries(STAGES.map((s) => [s.key, s.color]));
export const DEFAULT_STAGE = "nouveau_lead";

// `group` is the server's qualification group: "Gagné" counts as won,
// "Perdu" holds the loss reasons.
export const QUALIFICATIONS = [
  { key: "nouveau_lead", label: "Nouveau lead", group: "Nouveau", color: "#6E7A96" },
  { key: "en_attente_reponse", label: "En attente de réponse", group: "En cours", color: "#E3A63C" },
  { key: "en_cours", label: "En cours", group: "En cours", color: "#5B9BD9" },
  { key: "en_reflexion", label: "En réflexion", group: "En cours", color: "#A98BD6" },
  { key: "dossier_confirme", label: "Dossier confirmé", group: "Gagné", color: "#1F7A4F" },
  { key: "injoignable", label: "Injoignable", group: "Perdu", color: "#D98CB3" },
  { key: "non_interesse", label: "Non intéressé", group: "Perdu", color: "#E2685F" },
  { key: "prix_trop_eleve", label: "Prix trop élevé", group: "Perdu", color: "#E07B39" },
  { key: "offre_concurrente", label: "Offre concurrente", group: "Perdu", color: "#C0504D" },
  { key: "reservation_annulee", label: "Réservation annulée", group: "Perdu", color: "#B03A48" },
];

export const QUALIFICATION_LABELS = Object.fromEntries(QUALIFICATIONS.map((q) => [q.key, q.label]));
export const QUALIFICATION_COLORS = Object.fromEntries(QUALIFICATIONS.map((q) => [q.key, q.color]));
export const QUALIFICATION_GROUPS = Object.fromEntries(QUALIFICATIONS.map((q) => [q.key, q.group]));
export const DEFAULT_QUALIFICATION = "nouveau_lead";

export const TYPOLOGIES = [
  { key: "omra", label: "Omra" },
  { key: "visa", label: "Visa" },
  { key: "billetterie", label: "Billetterie" },
  { key: "hotels_sejours", label: "Hôtels / Séjours" },
  { key: "voyages_organises", label: "Voyages organisés" },
  { key: "transferts", label: "Transferts" },
  { key: "excursions", label: "Excursions / visites" },
  { key: "autres_services", label: "Autres services" },
];

export const TYPOLOGY_LABELS = Object.fromEntries(TYPOLOGIES.map((t) => [t.key, t.label]));

/** Colour of a stage, with the "Nouveau lead" grey for anything unknown. */
export const stageColor = (key) => STAGE_COLORS[key] || STAGE_COLORS.nouveau_lead;
export const stageLabel = (key) => STAGE_LABELS[key] || STAGE_LABELS.nouveau_lead;

/** Same for a qualification: "Nouveau lead" for anything unknown. */
export const qualificationColor = (key) =>
  QUALIFICATION_COLORS[key] || QUALIFICATION_COLORS.nouveau_lead;
export const qualificationLabel = (key) =>
  QUALIFICATION_LABELS[key] || QUALIFICATION_LABELS.nouveau_lead;
