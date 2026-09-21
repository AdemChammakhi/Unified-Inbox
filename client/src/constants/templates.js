/**
 * Message templates (modèles de messages) — shared helpers.
 *
 * A template body may carry placeholders that are filled at insert time:
 *   {{prenom}}  the customer's first name
 *   {{nom}}     the customer's full name as shown in the inbox
 *   {{agent}}   the signed-in agent's name
 * Unknown placeholders are left untouched so the agent sees them and edits.
 */

export const PLACEHOLDERS = [
  { token: "{{prenom}}", label: "Prénom du client" },
  { token: "{{nom}}", label: "Nom complet du client" },
  { token: "{{agent}}", label: "Nom de l'agent" },
];

export const PLATFORM_OPTIONS = [
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "email", label: "Email" },
];

export const TEMPLATE_MAX = { title: 120, category: 60, body: 4096 };

/** Placeholder names that look like a Meta fallback ("User 1234") are not names. */
const looksLikePlaceholderName = (name) => /^user\s*\d+$/i.test(name || "");

export function fillTemplate(body, { customerName = "", agentName = "" } = {}) {
  const fullName = looksLikePlaceholderName(customerName) ? "" : String(customerName || "").trim();
  const firstName = fullName.split(/\s+/)[0] || "";
  return String(body || "")
    .replace(/\{\{\s*prenom\s*\}\}/gi, firstName)
    .replace(/\{\{\s*nom\s*\}\}/gi, fullName)
    .replace(/\{\{\s*agent\s*\}\}/gi, String(agentName || "").trim());
}

/** Clipboard write with the execCommand fallback for non-secure contexts. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
