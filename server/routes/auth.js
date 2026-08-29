const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { protect, authorize } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

// Generate JWT
const generateToken = (id) => {
  if (!process.env.JWT_SECRET) {
    throw new Error(
      "Server misconfiguration: JWT_SECRET is missing. Configure it via environment variables (Kubernetes Secret / .env).",
    );
  }
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });
};

// POST /api/auth/create-user — Admin only
router.post("/create-user", protect, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied: admins only" });
    }

    const { firstName, lastName, email, password, role } = req.body;

    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Validate role
    if (!["admin", "manager", "marketing"].includes(role)) {
      return res.status(400).json({ message: "Invalid role selected" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: String(email) });
    if (existingUser) {
      return res
        .status(400)
        .json({ message: "User already exists with this email" });
    }

    // Create user — remember who opened it so the creator can manage it later
    const user = await User.create({
      firstName,
      lastName,
      email,
      password,
      role,
      createdBy: req.user._id,
    });

    res.status(201).json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ── Account management (admin only) ─────────────────────────────────────────
// An admin manages the accounts they created. `scope=all` widens the view to
// every account, which is what makes the agents of those accounts visible —
// a manager created by another admin still has to be findable when they hold
// a conversation lock.

// GET /api/auth/users?scope=mine|all
router.get("/users", protect, authorize("admin"), async (req, res) => {
  try {
    const scope = req.query.scope === "all" ? "all" : "mine";
    const filter = scope === "mine" ? { createdBy: req.user._id } : {};
    const users = await User.find(filter)
      .select("-password")
      .populate("createdBy", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      scope,
      users: users.map((u) => ({
        _id: u._id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.role,
        isActive: u.isActive !== false,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        isSelf: String(u._id) === String(req.user._id),
        createdBy: u.createdBy
          ? {
              _id: u.createdBy._id,
              name: `${u.createdBy.firstName || ""} ${u.createdBy.lastName || ""}`.trim(),
              email: u.createdBy.email,
            }
          : null,
      })),
    });
  } catch (error) {
    console.error("[Users] list failed:", error.message);
    return res.status(500).json({ message: "Impossible de charger les comptes" });
  }
});

// PUT /api/auth/users/:id — update name, email, role, active state, password
router.put("/users/:id", protect, authorize("admin"), async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "Compte introuvable" });
    }

    const { firstName, lastName, email, role, isActive, password } = req.body;

    if (role !== undefined) {
      if (!["admin", "manager", "marketing"].includes(role)) {
        return res.status(400).json({ message: "Rôle invalide" });
      }
      // Don't let an admin demote themselves and lock everyone out of
      // account management.
      if (String(target._id) === String(req.user._id) && role !== "admin") {
        return res.status(400).json({
          message: "Vous ne pouvez pas changer votre propre rôle.",
        });
      }
      target.role = role;
    }

    if (isActive !== undefined) {
      if (String(target._id) === String(req.user._id) && isActive === false) {
        return res
          .status(400)
          .json({ message: "Vous ne pouvez pas désactiver votre propre compte." });
      }
      target.isActive = Boolean(isActive);
    }

    if (email !== undefined && email !== target.email) {
      const clash = await User.findOne({
        email: String(email).toLowerCase(),
        _id: { $ne: target._id },
      });
      if (clash) {
        return res
          .status(400)
          .json({ message: "Cette adresse email est déjà utilisée." });
      }
      target.email = email;
    }

    if (firstName !== undefined) target.firstName = firstName;
    if (lastName !== undefined) target.lastName = lastName;
    // Assigning triggers the pre-save hash — never store it in the clear
    if (password) {
      if (String(password).length < 6) {
        return res
          .status(400)
          .json({ message: "Le mot de passe doit faire au moins 6 caractères." });
      }
      target.password = password;
    }

    await target.save();
    return res.json({
      user: {
        _id: target._id,
        firstName: target.firstName,
        lastName: target.lastName,
        email: target.email,
        role: target.role,
        isActive: target.isActive,
      },
    });
  } catch (error) {
    console.error("[Users] update failed:", error.message);
    return res
      .status(500)
      .json({ message: "Impossible de mettre à jour le compte" });
  }
});

// DELETE /api/auth/users/:id
router.delete("/users/:id", protect, authorize("admin"), async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user._id)) {
      return res
        .status(400)
        .json({ message: "Vous ne pouvez pas supprimer votre propre compte." });
    }
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "Compte introuvable" });
    }
    // Release anything they were holding so no conversation stays locked to
    // an account that no longer exists.
    const ConversationLock = require("../models/ConversationLock");
    const released = await ConversationLock.deleteMany({
      lockedBy: target._id,
    });
    await target.deleteOne();
    return res.json({
      success: true,
      releasedLocks: released.deletedCount || 0,
    });
  } catch (error) {
    console.error("[Users] delete failed:", error.message);
    return res.status(500).json({ message: "Impossible de supprimer le compte" });
  }
});

// POST /api/auth/login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: String(email) });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // A suspended account must not be able to sign in — otherwise disabling
    // someone would be cosmetic.
    if (user.isActive === false) {
      return res.status(403).json({
        message: "Ce compte est désactivé. Contactez un administrateur.",
      });
    }

    res.json({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      token: generateToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/auth/me - Get current user
router.get("/me", protect, async (req, res) => {
  res.json(req.user);
});

module.exports = router;
