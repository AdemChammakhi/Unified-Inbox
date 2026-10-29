const jwt = require("jsonwebtoken");
const users = require("../db/users");

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
      // Tokens issued before the SQL Server migration carry a MongoDB id,
      // which is no user id any more: they are refused like any unknown user.
      req.user = await users.findById(decoded.id);
      if (!req.user) {
        return res.status(401).json({ message: "Not authorized, user not found" });
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

module.exports = { protect, authorize };
