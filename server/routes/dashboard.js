const express = require("express");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// GET /api/dashboard/admin - Admin only
router.get("/admin", protect, authorize("admin"), (req, res) => {
  res.json({
    role: "admin",
    message: "Welcome to the Admin Dashboard",
    features: [
      "Manage all users",
      "View all conversations across channels",
      "System configuration",
      "Analytics & Reports",
      "Channel integrations (WhatsApp, Messenger, Instagram, TikTok, Email)",
    ],
  });
});

// GET /api/dashboard/manager - Manager only
router.get("/manager", protect, authorize("manager"), (req, res) => {
  res.json({
    role: "manager",
    message: "Welcome to the Manager Dashboard",
    features: [
      "Team performance overview",
      "Assign conversations to agents",
      "View sales pipeline",
      "Monitor response times",
      "Generate team reports",
    ],
  });
});

// GET /api/dashboard/marketing - Marketing only
router.get("/marketing", protect, authorize("marketing"), (req, res) => {
  res.json({
    role: "marketing",
    message: "Welcome to the Marketing Dashboard",
    features: [
      "Campaign management",
      "Broadcast messages",
      "Audience segmentation",
      "Content scheduling",
      "Campaign analytics",
    ],
  });
});

module.exports = router;
