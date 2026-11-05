const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Same wording as the login refusal in routes/auth.js.
const ACCOUNT_DISABLED = "Ce compte est désactivé. Contactez un administrateur.";

// Protect routes - verify JWT token
const protect = async (req, res, next) => {
  let token;

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      message:
        "Server misconfiguration: JWT_SECRET is missing. Configure it via environment variables (Kubernetes Secret / .env).",
    });
  }

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select("-password");
      if (!req.user) {
        return res.status(401).json({ message: "Not authorized, user not found" });
      }
      // A disabled account loses access at once, not when its token expires.
      if (req.user.isActive === false) {
        return res.status(401).json({ message: ACCOUNT_DISABLED });
      }
      return next();
    } catch (error) {
      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

// Restrict to specific roles
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Not authorized for this role" });
    }
    next();
  };
};

module.exports = { protect, authorize, ACCOUNT_DISABLED };
