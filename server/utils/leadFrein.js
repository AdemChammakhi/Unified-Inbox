/**
 * leadFrein.js — the main need or obstacle ("frein") behind a lead.
 *
 * At the end of an exchange the agent records why the prospect has not
 * committed yet: price, dates, distance, and so on. Management reads it on
 * the lead sheet and it feeds the maturity rules (a named obstacle means the
 * interest is real but the decision is pending).
 *
 * Storage: the contact's custom fields (dbo.contact_custom_fields), two rows
 * per contact, each value JSON:
 *
 *   leadFrein         { code, note, setBy, setAt }  current value
 *   leadFreinHistory  [ same shape ]                newest last, max 20
 *
 * The contact is found through its platform identity (platform + customer
 * id), the customer id every list shape agrees on (see CLAUDE.md §6), and
 * created when missing.
 */

"use strict";

const FREINS = Object.freeze([
  { code: "prix", label: "Prix" },
  { code: "dates", label: "Dates" },
  { code: "distance", label: "Distance / proximité" },
  { code: "hebergement", label: "Hébergement" },
  { code: "transport", label: "Transport" },
  { code: "disponibilite", label: "Disponibilité" },
  { code: "comparaison", label: "Comparaison avec une autre offre" },
  { code: "autre", label: "Autre" },
]);

const LABEL_BY_CODE = new Map(FREINS.map((f) => [f.code, f.label]));

/** Platforms a frein can be recorded for (Contact identities we write). */
const FREIN_PLATFORMS = new Set(["instagram", "facebook", "whatsapp", "email"]);

const NOTE_MAX = 200;
const HISTORY_MAX = 20;

const FIELD = "leadFrein";
const HISTORY_FIELD = "leadFreinHistory";

// The data layer is required lazily so the pure helpers (and leadMaturity,
// which uses freinLabel) never open a database connection.
const store = () => ({
  sql: require("../db/sql"),
  contacts: require("../db/contacts"),
  users: require("../db/users"),
});

/** @returns {boolean} */
function isValidFreinCode(code) {
  return typeof code === "string" && LABEL_BY_CODE.has(code);
}

/**
 * Human label for a stored frein.
 * @param {{code: string, note?: string}|string|null|undefined} frein
 * @returns {string} "" when there is no (valid) frein
 */
function freinLabel(frein) {
  if (!frein) return "";
  const code = typeof frein === "string" ? frein : frein.code;
  if (!isValidFreinCode(code)) return "";
  const label = LABEL_BY_CODE.get(code);
  const note =
    typeof frein === "object" && typeof frein.note === "string"
      ? frein.note.trim()
      : "";
  if (code === "autre" && note) return `${label} : ${note}`;
  return label;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function cleanNote(note) {
  if (typeof note !== "string") return "";
  return note.trim().slice(0, NOTE_MAX);
}

function parseJson(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Record the frein for one customer. Creates the contact when none exists.
 * Throws an Error with `status = 400` on invalid input.
 *
 * @returns {Promise<{code: string, note: string, setBy: string|null, setAt: Date}>}
 */
async function setFrein({ platform, customerId, code, note, userId }) {
  if (typeof platform !== "string" || !FREIN_PLATFORMS.has(platform)) {
    throw badRequest("Plateforme invalide.");
  }
  const externalId = typeof customerId === "string" ? customerId.trim() : "";
  if (!externalId || externalId.startsWith("$") || externalId.length > 255) {
    throw badRequest("Client introuvable pour cette conversation.");
  }
  if (!isValidFreinCode(code)) {
    throw badRequest("Motif / frein invalide.");
  }

  const frein = {
    code,
    note: cleanNote(note),
    setBy: userId ? String(userId) : null,
    setAt: new Date(),
  };

  const { sql, contacts } = store();
  await sql.tx(async (t) => {
    const { contactId } = await contacts.ensureIdentity(t, {
      platform,
      externalId,
    });
    const history = parseJson(
      await contacts.readCustomField(t, contactId, HISTORY_FIELD),
    );
    const next = [...(Array.isArray(history) ? history : []), frein].slice(
      -HISTORY_MAX,
    );
    await contacts.writeCustomField(t, contactId, FIELD, JSON.stringify(frein));
    await contacts.writeCustomField(
      t,
      contactId,
      HISTORY_FIELD,
      JSON.stringify(next),
    );
  });

  return frein;
}

/**
 * Current frein for many customers of one platform.
 * Two queries in total: one for the frein fields, one for the users.
 *
 * @param {string} platform
 * @param {string[]} customerIds
 * @returns {Promise<Map<string, {code, label, note, setAt, setBy, setByName}>>}
 */
async function getFreins(platform, customerIds) {
  const result = new Map();
  if (typeof platform !== "string" || !FREIN_PLATFORMS.has(platform)) {
    return result;
  }
  const ids = [
    ...new Set(
      (Array.isArray(customerIds) ? customerIds : [])
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id && !id.startsWith("$")),
    ),
  ];
  if (ids.length === 0) return result;

  const { contacts, users } = store();
  const raw = await contacts.customFieldFor(platform, ids, FIELD);

  const best = new Map(); // customerId -> frein
  for (const [id, value] of raw) {
    const frein = parseJson(value);
    if (frein && isValidFreinCode(frein.code)) best.set(id, frein);
  }
  if (best.size === 0) return result;

  const names = await users.namesByIds(
    [...best.values()].map((f) => f.setBy).filter(Boolean),
  );

  for (const [id, frein] of best) {
    const setBy = frein.setBy ? String(frein.setBy) : null;
    result.set(id, {
      code: frein.code,
      label: freinLabel(frein),
      note: typeof frein.note === "string" ? frein.note : "",
      setAt: frein.setAt || null,
      setBy,
      setByName: (setBy && names.get(setBy)) || "",
    });
  }
  return result;
}

module.exports = {
  FREINS,
  NOTE_MAX,
  HISTORY_MAX,
  isValidFreinCode,
  freinLabel,
  setFrein,
  getFreins,
};
