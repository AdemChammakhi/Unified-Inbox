const express = require("express");
const router = express.Router();
const Classification = require("../models/Classification");
const { protect } = require("../middleware/auth");

// GET /api/classifications?platform=instagram
// Returns all classifications for a given platform
router.get("/", protect, async (req, res) => {
  try {
    const { platform } = req.query;
    const filter = platform ? { platform } : {};
    const classifications = await Classification.find(filter);

    // Return as a map: { conversationId: classification }
    const map = {};
    classifications.forEach((c) => {
      map[c.conversationId] = c.classification;
    });

    return res.json({ classifications: map });
  } catch (error) {
    console.error("Classification fetch error:", error.message);
    return res.status(500).json({ message: "Failed to fetch classifications" });
  }
});

// PUT /api/classifications
// Set or update classification for a conversation
router.put("/", protect, async (req, res) => {
  try {
    const { conversationId, platform, classification } = req.body;

    if (!conversationId || !platform || !classification) {
      return res.status(400).json({
        message: "conversationId, platform, and classification are required",
      });
    }

    const valid = ["cible", "hors_cible", "non_classifie", "suivi", "priorite"];
    if (!valid.includes(classification)) {
      return res.status(400).json({
        message: `Invalid classification. Must be one of: ${valid.join(", ")}`,
      });
    }

    const result = await Classification.findOneAndUpdate(
      { conversationId, platform },
      {
        classification,
        classifiedBy: req.user._id,
      },
      { upsert: true, new: true },
    );

    return res.json({ success: true, classification: result });
  } catch (error) {
    console.error("Classification update error:", error.message);
    return res.status(500).json({ message: "Failed to update classification" });
  }
});

module.exports = router;
