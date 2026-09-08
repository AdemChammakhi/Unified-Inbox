const express = require("express");
const router = express.Router();
const Classification = require("../models/Classification");
const { protect } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");

// GET /api/classifications?platform=instagram
// Returns all classifications for a given platform
router.get("/", protect, async (req, res) => {
  try {
    const { platform } = req.query;
    const safePlatform = platform ? sanitizePlatform(platform) : null;
    const filter = safePlatform ? { platform: safePlatform } : {};
    const classifications = await Classification.find(filter)
      .select("conversationId classification appointmentAt")
      .lean();

    // Return as a map: { conversationId: classification }
    // Appointment dates ride in a parallel map so the existing shape — which
    // several views already read as a plain string — stays untouched.
    const map = {};
    const appointments = {};
    classifications.forEach((c) => {
      map[c.conversationId] = c.classification;
      if (c.appointmentAt) {
        appointments[c.conversationId] = c.appointmentAt;
      }
    });

    return res.json({ classifications: map, appointments });
  } catch (error) {
    console.error("Classification fetch error:", error.message);
    return res.status(500).json({ message: "Failed to fetch classifications" });
  }
});

// PUT /api/classifications
// Set or update classification for a conversation
router.put("/", protect, async (req, res) => {
  try {
    const conversationId = sanitizeId(req.body.conversationId);
    const platform = sanitizePlatform(req.body.platform);
    const { classification, appointmentAt } = req.body;
    const participantId = sanitizeId(req.body.participantId);

    if (!conversationId || !platform || !classification) {
      return res.status(400).json({
        message: "conversationId, platform, and classification are required",
      });
    }

    const valid = [
      "cible",
      "hors_cible",
      "non_classifie",
      "suivi",
      "priorite",
      "rdv",
    ];
    if (!valid.includes(classification)) {
      return res.status(400).json({
        message: `Invalid classification. Must be one of: ${valid.join(", ")}`,
      });
    }

    // An RDV is only useful if we know when it is — without a date it would
    // never surface in the agenda. Any other class clears a stale date.
    let appointment = null;
    if (classification === "rdv") {
      const parsed = appointmentAt ? new Date(appointmentAt) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) {
        return res.status(400).json({
          message: "An appointment date is required for RDV",
        });
      }
      appointment = parsed;
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
    const payload = {
      conversationId: canonical,
      classification: String(classification),
      appointmentAt: appointment,
      classifiedBy: req.user._id,
    };
    let result;
    if (rows.length === 0) {
      result = await Classification.create({
        ...payload,
        platform: String(platform),
      });
    } else {
      const keep =
        rows.find((r) => r.conversationId === canonical) || rows[0];
      const dropIds = rows.filter((r) => r._id !== keep._id).map((r) => r._id);
      if (dropIds.length > 0) {
        await Classification.deleteMany({ _id: { $in: dropIds } });
      }
      result = await Classification.findByIdAndUpdate(
        keep._id,
        { $set: payload },
        { new: true },
      );
    }

    return res.json({ success: true, classification: result });
  } catch (error) {
    console.error("Classification update error:", error.message);
    return res.status(500).json({ message: "Failed to update classification" });
  }
});

module.exports = router;
