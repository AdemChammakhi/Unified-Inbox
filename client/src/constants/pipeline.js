/**
 * The commercial pipeline, as shown to agents. Mirror of
 * server/constants/pipeline.js — keep the two in step.
 */

export const STAGES = [
  { key: "nouveau_lead", label: "Nouveau lead", color: "#6E7A96" },
  { key: "a_contacter", label: "À contacter", color: "#E3A63C" },
  { key: "contact_etabli", label: "Contact établi", color: "#5B9BD9" },
  { key: "qualifie", label: "Qualifié", color: "#5FBF8A" },
  { key: "offre_envoyee", label: "Offre envoyée", color: "#4EC3C3" },
  { key: "en_reflexion", label: "En réflexion", color: "#A98BD6" },
  { key: "relance", label: "Relance", color: "#D98CB3" },
  { key: "reservation", label: "Réservation", color: "#3FA37A" },
  { key: "paiement", label: "Paiement", color: "#2E8B57" },
  { key: "dossier_confirme", label: "Dossier confirmé", color: "#1F7A4F" },
  { key: "depart", label: "Départ", color: "#16633F" },
  { key: "perdu", label: "Perdu", color: "#E2685F" },
];

export const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
export const STAGE_COLORS = Object.fromEntries(STAGES.map((s) => [s.key, s.color]));
export const DEFAULT_STAGE = "nouveau_lead";

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
