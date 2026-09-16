/**
 * leadFrein.js — the main need or obstacle ("frein") behind a lead.
 *
 * At the end of an exchange the agent records why the prospect has not
 * committed yet: price, dates, distance, and so on. Management reads it on
 * the lead sheet and it feeds the maturity rules (a named obstacle means the
 * interest is real but the decision is pending).
 *
 * Storage: the data models are frozen, so the frein lives in the EXISTING
 * Contact.customFields (Mixed) field, keyed by the customer's platform id:
 *
 *   customFields.leadFrein        { code, note, setBy, setAt }  current value
 *   customFields.leadFreinHistory [ same shape ]                newest last, max 20
 *
 * Contacts are matched on platformIdentities (platform + externalId), the
 * customer id every list shape agrees on (see CLAUDE.md §6).
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

// Models are required lazily so the pure helpers (and leadMaturity, which
// uses freinLabel) never pull Mongoose in.
const models = () => ({
  Contact: require("../models/Contact"),
  User: require("../models/User"),
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

function hasIdentity(contact, platform, externalId) {
  return Boolean(
    contact &&
      (contact.platformIdentities || []).some(
        (p) => p && p.platform === platform && p.externalId === externalId,
      ),
  );
}

function toTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Record the frein for one customer. Creates the Contact when none exists.
 * Throws an Error with `status = 400` on invalid input.
 *
 * @returns {Promise<{code: string, note: string, setBy: string|null, setAt: Date}>}
 */
async function setFrein({ platform, customerId, code, note, userId }) {
  if (typeof platform !== "string" || !FREIN_PLATFORMS.has(platform)) {
    throw badRequest("Plateforme invalide.");
  }
  const externalId = typeof customerId === "string" ? customerId.trim() : "";
  if (!externalId || externalId.startsWith("$")) {
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

  const { Contact } = models();
  const filter = {
    platformIdentities: { $elemMatch: { platform, externalId } },
  };

  // Several contacts can share one identity (the find-or-create is not
  // atomic); write to the most recently touched one, which getFreins then
  // resolves by setAt anyway.
  let contact = await Contact.findOne(filter)
    .sort({ updatedAt: -1 })
    .select("_id customFields")
    .lean();
  if (!contact) {
    contact = await Contact.findOrCreateByPlatformId(platform, externalId, {});
    // That static matches platform and id without $elemMatch, so it can hand
    // back a merged contact holding them on two different identities. A
    // frein written there could never be read back; create the right one.
    if (!hasIdentity(contact, platform, externalId)) {
      const now = new Date();
      contact = await Contact.create({
        displayName: "Unknown",
        platformIdentities: [
          { platform, externalId, name: "Unknown", lastSeenAt: now },
        ],
        firstContactAt: now,
        lastContactAt: now,
      });
    }
  }

  const customFields = contact.customFields;
  const canDotSet =
    customFields === undefined ||
    (customFields !== null &&
      typeof customFields === "object" &&
      !Array.isArray(customFields));

  if (canDotSet) {
    const history = customFields && customFields.leadFreinHistory;
    if (history === undefined || Array.isArray(history)) {
      await Contact.updateOne(
        { _id: contact._id },
        {
          $set: { "customFields.leadFrein": frein },
          $push: {
            "customFields.leadFreinHistory": {
              $each: [frein],
              $slice: -HISTORY_MAX,
            },
          },
        },
      );
    } else {
      // A malformed history cannot take $push; start it afresh.
      await Contact.updateOne(
        { _id: contact._id },
        {
          $set: {
            "customFields.leadFrein": frein,
            "customFields.leadFreinHistory": [frein],
          },
        },
      );
    }
  } else {
    // customFields is null or not an object: dotted paths cannot be created
    // under it, so replace it with a fresh object holding only the frein.
    await Contact.updateOne(
      { _id: contact._id },
      { $set: { customFields: { leadFrein: frein, leadFreinHistory: [frein] } } },
    );
  }

  return frein;
}

/**
 * Current frein for many customers of one platform.
 * Two queries in total: one Contact, one User.
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

  const { Contact, User } = models();
  const contacts = await Contact.find({
    platformIdentities: {
      $elemMatch: { platform, externalId: { $in: ids } },
    },
    "customFields.leadFrein.code": { $exists: true, $ne: null },
  })
    .select("platformIdentities customFields.leadFrein")
    .lean();

  const wanted = new Set(ids);
  const best = new Map(); // customerId -> raw frein
  for (const contact of contacts) {
    const frein = contact.customFields && contact.customFields.leadFrein;
    if (!frein || !isValidFreinCode(frein.code)) continue;
    for (const identity of contact.platformIdentities || []) {
      if (identity.platform !== platform) continue;
      const id = identity.externalId;
      if (!wanted.has(id)) continue;
      const current = best.get(id);
      if (!current || toTime(frein.setAt) > toTime(current.setAt)) {
        best.set(id, frein);
      }
    }
  }
  if (best.size === 0) return result;

  const userIds = [
    ...new Set(
      [...best.values()]
        .map((f) => (f.setBy ? String(f.setBy) : ""))
        .filter((id) => /^[a-f0-9]{24}$/i.test(id)),
    ),
  ];
  const names = new Map();
  if (userIds.length > 0) {
    const users = await User.find({ _id: { $in: userIds } })
      .select("firstName lastName")
      .lean();
    for (const u of users) {
      names.set(
        String(u._id),
        `${u.firstName || ""} ${u.lastName || ""}`.trim(),
      );
    }
  }

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
