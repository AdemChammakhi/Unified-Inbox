const express = require("express");
const router = express.Router();
const conversations = require("../db/conversations");
const { protect } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");
const {
  STAGE_KEYS,
  QUALIFICATION_KEYS,
  TYPOLOGY_KEYS,
  isStage,
  isQualification,
  isTypology,
} = require("../constants/pipeline");

/**
 * The customer "dossier": funnel step ("Étape"), qualification, typologie of
 * the request and RDV date, kept on the customer's conversation row
 * (server/db/conversations.js: classification_id, qualification_id, motif_id,
 * appointment_*), one per customer per platform.
 *
 * The response keeps the historical shape the pages read — `classifications`
 * is a map key → STAGE code, `appointments` a map key → date — and adds
 * `dossiers`, a map key → { stage, qualification, typologie, appointmentAt }.
 * Every entry is listed under the customer id AND the thread id when one is
 * recorded, so the client's lookup by conversation id or first participant
 * finds it either way (CLAUDE.md §6).
 */

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
//   classification (stage code) | stage, qualification, typologie,
//   appointmentAt (ISO date, or null to clear) }
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

    if (body.qualification !== undefined) {
      if (!isQualification(body.qualification)) {
        return res.status(400).json({
          message: `Qualification invalide. Valeurs possibles : ${QUALIFICATION_KEYS.join(", ")}`,
        });
      }
      set.qualification = body.qualification;
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

    const result = await conversations.setDossier(conv.id, set, req.user._id);

    // Maturity reads the stage, the qualification and the RDV date, so cached
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
    console.error("Classification update error:", error.message);
    return res.status(500).json({ message: "Impossible de mettre à jour le dossier." });
  }
});

module.exports = router;
