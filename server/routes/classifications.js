const express = require("express");
const router = express.Router();
const conversations = require("../db/conversations");
const { findPartner, agencyLabel } = require("./partners");
const { protect } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");
const {
  STAGE_KEYS,
  TYPOLOGY_KEYS,
  isStage,
  isTypology,
} = require("../constants/pipeline");

/**
 * The customer "dossier": pipeline stage, typologie of the request, invoice
 * reference, phone, PAX, priority flag, comment, and the RDV (date, place,
 * agency, responsible agent), one per customer per platform. It lives on the
 * customer's conversation row and on their contact
 * (server/db/conversations.js: the stage as its (Étape, Qualification) pair,
 * the typologie as motif_id, the RDV date as appointment_*, the phone in
 * contacts.phone, everything else in the "dossier" custom field).
 *
 * The response keeps the historical shape the pages read — `classifications`
 * is a map key → STAGE code, `appointments` a map key → date — and adds
 * `dossiers`, a map key → { stage, typologie, invoiceRef, phone, pax,
 * isPriority, appointmentAt, appointmentPlace, appointmentAgencyId,
 * appointmentAgencyName, appointmentAgent, comment, commentAt }. Every entry
 * is listed under the customer id AND the thread id when one is recorded, so
 * the client's lookup by conversation id or first participant finds it
 * either way (CLAUDE.md §6).
 */

const COMMENT_MAX = 1000;
const PLACE_MAX = 60;
const AGENT_MAX = 120;

const oneLine = (v, max) =>
  String(v || "").replace(/\s+/g, " ").trim().slice(0, max);

// GET /api/classifications?platform=instagram
router.get("/", protect, async (req, res) => {
  try {
    const { platform } = req.query;
    const safePlatform = platform ? sanitizePlatform(platform) : null;
    const rows = await conversations.dossiers(safePlatform);

    const classifications = {};
    const appointments = {};
    const dossiers = {};
    rows.forEach((c) => {
      const d = conversations.publicDossier(c);
      for (const key of new Set([c.customerId, c.externalId].filter(Boolean))) {
        classifications[key] = d.stage;
        if (d.appointmentAt) appointments[key] = d.appointmentAt;
        dossiers[key] = d;
      }
    });

    return res.json({ classifications, appointments, dossiers });
  } catch (error) {
    console.error("Classification fetch error:", error.message);
    return res.status(500).json({ message: "Impossible de charger les dossiers." });
  }
});

// PUT /api/classifications
// Body: { conversationId, participantId?, platform, and any of:
//   classification (stage code) | stage, typologie, invoiceRef, phone, pax,
//   isPriority, comment, appointmentAt (ISO date, or null to clear the whole
//   RDV), appointmentPlace (gouvernorat), appointmentAgencyId (partners
//   directory id, or null), appointmentAgent (free text) }
router.put("/", protect, async (req, res) => {
  try {
    const conversationId = sanitizeId(req.body.conversationId);
    const platform = sanitizePlatform(req.body.platform);
    const participantId = sanitizeId(req.body.participantId);
    const body = req.body || {};

    if (!conversationId || !platform) {
      return res.status(400).json({
        message: "conversationId et platform sont obligatoires.",
      });
    }

    const set = {};

    const stage = body.stage !== undefined ? body.stage : body.classification;
    if (stage !== undefined) {
      if (!isStage(stage)) {
        return res.status(400).json({
          message: `Étape invalide. Valeurs possibles : ${STAGE_KEYS.join(", ")}`,
        });
      }
      set.stage = stage;
    }

    if (body.typologie !== undefined) {
      const t = body.typologie === null ? "" : body.typologie;
      if (t !== "" && !isTypology(t)) {
        return res.status(400).json({
          message: `Typologie invalide. Valeurs possibles : ${TYPOLOGY_KEYS.join(", ")}`,
        });
      }
      set.typologie = t;
    }

    if (body.invoiceRef !== undefined) {
      if (body.invoiceRef !== null && typeof body.invoiceRef !== "string") {
        return res.status(400).json({ message: "Référence de facture invalide." });
      }
      set.invoiceRef = String(body.invoiceRef || "").trim().slice(0, 60);
    }

    if (body.phone !== undefined) {
      if (body.phone !== null && typeof body.phone !== "string") {
        return res.status(400).json({ message: "Numéro de téléphone invalide." });
      }
      // Digits, "+", and the usual separators; anything else is noise
      const phone = String(body.phone || "")
        .replace(/[^\d+\s().-]/g, "")
        .replace(/\(\s*\)/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 30);
      if (phone && phone.replace(/\D/g, "").length < 6) {
        return res.status(400).json({
          message: "Numéro de téléphone trop court (6 chiffres minimum).",
        });
      }
      set.phone = phone;
    }

    if (body.pax !== undefined) {
      if (body.pax === null || body.pax === "") {
        set.pax = null;
      } else {
        const pax = typeof body.pax === "string" ? Number(body.pax.trim()) : body.pax;
        if (!Number.isInteger(pax) || pax < 1 || pax > 999) {
          return res.status(400).json({
            message: "Nombre de PAX invalide (un entier entre 1 et 999).",
          });
        }
        set.pax = pax;
      }
    }

    if (body.isPriority !== undefined) {
      set.isPriority = body.isPriority === true || body.isPriority === "true";
    }

    if (body.comment !== undefined) {
      if (body.comment !== null && typeof body.comment !== "string") {
        return res.status(400).json({ message: "Commentaire invalide." });
      }
      const comment = String(body.comment || "")
        .replace(/\r\n?/g, "\n")
        .trim();
      if (comment.length > COMMENT_MAX) {
        return res.status(400).json({
          message: `Commentaire trop long (${COMMENT_MAX} caractères maximum).`,
        });
      }
      set.comment = comment;
      set.commentBy = comment ? String(req.user._id) : null;
      set.commentAt = comment ? new Date() : null;
    }

    if (body.appointmentAt !== undefined) {
      if (body.appointmentAt === null || body.appointmentAt === "") {
        set.appointmentAt = null;
      } else {
        const parsed = new Date(body.appointmentAt);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ message: "Date de rendez-vous invalide." });
        }
        set.appointmentAt = parsed;
      }
    }

    // Where the appointment takes place and who receives the customer.
    // Removing the date removes them too: they describe that appointment.
    if (set.appointmentAt === null) {
      set.appointmentPlace = "";
      set.appointmentAgencyId = "";
      set.appointmentAgencyName = "";
      set.appointmentAgent = "";
    } else {
      if (body.appointmentPlace !== undefined) {
        if (body.appointmentPlace !== null && typeof body.appointmentPlace !== "string") {
          return res.status(400).json({ message: "Lieu du rendez-vous invalide." });
        }
        set.appointmentPlace = oneLine(body.appointmentPlace, PLACE_MAX);
      }

      if (body.appointmentAgencyId !== undefined) {
        const id = body.appointmentAgencyId;
        if (id === null || id === "") {
          set.appointmentAgencyId = "";
          set.appointmentAgencyName = "";
        } else {
          if (typeof id !== "string") {
            return res.status(400).json({ message: "Agence invalide." });
          }
          // The read-only partners library (routes/partners.js)
          const partner = findPartner(id);
          if (!partner) {
            return res.status(400).json({
              message: "Agence introuvable dans l'annuaire.",
            });
          }
          set.appointmentAgencyId = partner._id;
          set.appointmentAgencyName = agencyLabel(partner);
          // The agency settles the place: a Sousse agency is in Sousse
          // whatever was picked before it.
          if (partner.governorate) {
            set.appointmentPlace = oneLine(partner.governorate, PLACE_MAX);
          }
        }
      }

      if (body.appointmentAgent !== undefined) {
        if (body.appointmentAgent !== null && typeof body.appointmentAgent !== "string") {
          return res.status(400).json({ message: "Agent responsable invalide." });
        }
        set.appointmentAgent = oneLine(body.appointmentAgent, AGENT_MAX);
      }
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).json({ message: "Aucun champ à mettre à jour." });
    }

    // A conversation has no single stable id: Meta's list keys an Instagram
    // thread as "t_…", while the DB-built list keys it by the sender's id.
    // Either key finds the customer's conversation; without one yet, it is
    // created for the customer (the participant when given), or for the
    // thread alone when the customer is not known.
    let conv = await conversations.resolve(
      platform,
      [conversationId, participantId].filter(Boolean),
      { includeDeleted: true },
    );
    if (!conv) {
      const customer =
        participantId ||
        (conversations.isThreadId(platform, conversationId) ? null : conversationId);
      conv = customer
        ? await conversations.ensureForCustomer({ platform, customerId: customer })
        : await conversations.ensureForThread({ platform, threadId: conversationId });
    } else if (conv.deletedAt) {
      conv = conv.customerId
        ? await conversations.ensureForCustomer({ platform, customerId: conv.customerId })
        : await conversations.ensureForThread({ platform, threadId: conv.externalId });
    }

    // The row's own fields go to their parameters; the rest is the contact's
    // "dossier" custom field (see db/conversations.setDossier).
    const { stage: newStage, typologie, appointmentAt, phone, ...extras } = set;
    const result = await conversations.setDossier(
      conv.id,
      { stage: newStage, typologie, appointmentAt, phone, extras },
      req.user._id,
    );

    // Maturity reads the stage, the priority flag and the RDV date, so cached
    // lead insights are stale, and so is the Leads sheet. Required lazily:
    // both are optional to this route.
    try {
      const { clearInsightsCache } = require("./leadInsights");
      if (typeof clearInsightsCache === "function") clearInsightsCache();
    } catch (err) {
      console.error("Lead insights cache clear failed:", err.message);
    }
    try {
      const { clearLeadsCache } = require("./leads");
      if (typeof clearLeadsCache === "function") clearLeadsCache();
    } catch (err) {
      console.error("Leads cache clear failed:", err.message);
    }

    const dossier = conversations.publicDossier(result);
    return res.json({
      success: true,
      classification: {
        conversationId: result.key,
        platform: result.platform,
        ...dossier,
        classifiedBy: result.classifiedBy,
        updatedAt: result.classifiedAt,
      },
      dossier,
      conversationId: result.key,
    });
  } catch (error) {
    // The phone number is unique per contact (contacts.phone)
    if (error && error.status === 409) {
      return res.status(409).json({ message: error.message });
    }
    console.error("Classification update error:", error.message);
    return res.status(500).json({ message: "Impossible de mettre à jour le dossier." });
  }
});

module.exports = router;
