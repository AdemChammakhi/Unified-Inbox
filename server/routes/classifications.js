const express = require("express");
const router = express.Router();
const Classification = require("../models/Classification");
const { protect } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");
const {
  DEFAULT_STAGE,
  STAGE_KEYS,
  TYPOLOGY_KEYS,
  isStage,
  isTypology,
} = require("../constants/pipeline");

/**
 * The customer "dossier": pipeline stage, typologie of the request, priority
 * flag, RDV date and invoice reference, one record per customer per platform
 * (keyed by the customer id — see CLAUDE.md §6).
 *
 * The response keeps the historical shape the pages read — `classifications`
 * is a map customerId → STAGE code, `appointments` a map customerId → date —
 * and adds `dossiers`, a map customerId → { stage, typologie, invoiceRef,
 * isPriority, appointmentAt }.
 */

const publicDossier = (c) => ({
  stage: c.stage || DEFAULT_STAGE,
  typologie: c.typologie || "",
  invoiceRef: c.invoiceRef || "",
  isPriority: c.isPriority === true,
  appointmentAt: c.appointmentAt || null,
});

// GET /api/classifications?platform=instagram
router.get("/", protect, async (req, res) => {
  try {
    const { platform } = req.query;
    const safePlatform = platform ? sanitizePlatform(platform) : null;
    const filter = safePlatform ? { platform: safePlatform } : {};
    const rows = await Classification.find(filter)
      .select("conversationId stage typologie invoiceRef isPriority appointmentAt")
      .lean();

    const classifications = {};
    const appointments = {};
    const dossiers = {};
    rows.forEach((c) => {
      const d = publicDossier(c);
      classifications[c.conversationId] = d.stage;
      if (d.appointmentAt) appointments[c.conversationId] = d.appointmentAt;
      dossiers[c.conversationId] = d;
    });

    return res.json({ classifications, appointments, dossiers });
  } catch (error) {
    console.error("Classification fetch error:", error.message);
    return res.status(500).json({ message: "Impossible de charger les dossiers." });
  }
});

// PUT /api/classifications
// Body: { conversationId, participantId?, platform, and any of:
//   classification (stage code) | stage, typologie, invoiceRef, isPriority,
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

    if (body.isPriority !== undefined) {
      set.isPriority = body.isPriority === true || body.isPriority === "true";
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
    // thread as "t_…", while the DB-built list (webhook rows, or Meta in
    // backoff) keys it by the sender's id. Only the sender's id appears in
    // BOTH shapes (as the first participant), so that is the canonical key:
    // find the row under either id, and re-key it to the participant.
    const canonical = String(participantId || conversationId);
    const keys = [String(conversationId)];
    if (canonical !== String(conversationId)) keys.push(canonical);
    // Rows may exist under BOTH keys (one saved before the re-keying, one
    // after). Re-keying the thread row while a customer row exists would
    // trip the unique (conversationId, platform) index and fail the save —
    // so merge first: keep one row, delete the rest, then write.
    const rows = await Classification.find({
      conversationId: { $in: keys },
      platform: String(platform),
    })
      .sort({ updatedAt: -1 })
      .lean();

    set.conversationId = canonical;
    set.classifiedBy = req.user._id;

    let result;
    if (rows.length === 0) {
      result = await Classification.create({
        ...set,
        platform: String(platform),
      });
    } else {
      const keep = rows.find((r) => r.conversationId === canonical) || rows[0];
      const dropIds = rows.filter((r) => r._id !== keep._id).map((r) => r._id);
      if (dropIds.length > 0) {
        await Classification.deleteMany({ _id: { $in: dropIds } });
      }
      result = await Classification.findByIdAndUpdate(
        keep._id,
        { $set: set },
        { new: true, runValidators: true },
      );
    }

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

    return res.json({
      success: true,
      classification: result,
      dossier: publicDossier(result),
      conversationId: canonical,
    });
  } catch (error) {
    console.error("Classification update error:", error.message);
    return res.status(500).json({ message: "Impossible de mettre à jour le dossier." });
  }
});

module.exports = router;
