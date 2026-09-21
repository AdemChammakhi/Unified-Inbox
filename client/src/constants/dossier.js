/**
 * dossier.js — vocabulary of the customer dossier attachments.
 *
 * Codes mirror the `docType` enum in server/models/DossierDocument.js; keep
 * both sides in step.
 */

/** Kinds of document an agent can attach to a customer's dossier. */
export const DOC_TYPES = [
  { code: "facture", label: "Facture" },
  { code: "passeport_cin", label: "Copie passeport / CIN" },
  { code: "devis", label: "Devis" },
  { code: "voucher", label: "Voucher" },
  { code: "billet", label: "Billet" },
  { code: "administratif", label: "Document administratif" },
  { code: "autre", label: "Autre" },
];

/** French label for a docType code, falling back to the code itself. */
export const docTypeLabel = (code) =>
  DOC_TYPES.find((t) => t.code === code)?.label || code || "Document";

/** Largest upload the server accepts, in bytes (15 Mo). */
export const DOC_MAX_BYTES = 15 * 1024 * 1024;

/** `accept` attribute for the file input — the server's MIME allowlist. */
export const DOC_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
].join(",");
