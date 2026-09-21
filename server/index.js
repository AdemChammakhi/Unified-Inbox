const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const connectDB = require("./config/db");

// Load .env from project root (one level up from server/)
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Connect to MongoDB
connectDB();

const app = express();

// Create HTTP server and attach Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

// Make io accessible in routes
app.set("io", io);

const jwt = require("jsonwebtoken");

// Authenticate Socket.IO connections
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    console.warn("[Socket] Authentication failed: Token missing");
    return next(new Error("Authentication error: Token missing"));
  }

  if (!process.env.JWT_SECRET) {
    console.error("[Socket] Server configuration error: JWT_SECRET not configured");
    return next(new Error("Server configuration error: JWT_SECRET missing"));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    console.warn("[Socket] Authentication failed: Invalid token", err.message);
    next(new Error("Authentication error: Invalid token"));
  }
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join", (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined room`);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// Middleware
app.set("trust proxy", 1); // trust Nginx reverse proxy for real client IPs
app.disable("x-powered-by"); // don't advertise Express (ZAP 10036)

// Security headers for API and /uploads responses. The frontend container
// sets its own (see client/nginx.conf) — these cover everything the backend
// serves directly.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), xr-spatial-tracking=()",
  );
  if (req.path.startsWith("/api/")) {
    // API responses carry customer data — never store them
    res.setHeader("Cache-Control", "no-store");
    // JSON needs no scripts, styles or framing
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  }
  next();
});
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  }),
);
const {
  apiLimiter,
  webhookLimiter,
  exportLimiter,
} = require("./middleware/rateLimiter");

// Support tickets carry base64 screenshots, which blow past express.json's
// 100KB default. Mounted BEFORE the global parser with its own larger limit,
// so only this router accepts big bodies — every other endpoint keeps the
// tight default.
app.use(
  "/api/support",
  apiLimiter,
  express.json({ limit: "8mb" }),
  require("./routes/support"),
);

app.use(
  express.json({
    // Keep the raw body so webhook routes can verify Meta's
    // X-Hub-Signature-256 HMAC against the exact bytes received.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Customer dossier documents (passport copies, invoices…) share the uploads
// volume but must never be public: only the authenticated download route in
// routes/dossierDocuments.js may read them. Mounted BEFORE the static handler.
app.use("/uploads/dossiers", (req, res) => res.sendStatus(404));

// Uploaded media for outbound messages — must be publicly reachable because
// Meta fetches media by URL (filenames are 128-bit random, so unguessable).
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    maxAge: "7d",
    immutable: true,
    index: false,
    dotfiles: "deny",
  }),
);

// Routes with specific rate limiters
app.use("/api/webhooks", webhookLimiter, require("./routes/webhooks"));
app.use("/api/uploads", apiLimiter, require("./routes/uploads"));

// Routes with general API rate limiter
app.use("/api/auth", apiLimiter, require("./routes/auth"));
app.use("/api/dashboard", apiLimiter, require("./routes/dashboard"));
app.use("/api/instagram", apiLimiter, require("./routes/instagram"));
app.use("/api/facebook", apiLimiter, require("./routes/facebook"));
app.use("/api/whatsapp", apiLimiter, require("./routes/whatsapp"));
app.use("/api/email", apiLimiter, require("./routes/email"));
app.use("/api/classifications", apiLimiter, require("./routes/classifications"));
app.use("/api/locks", apiLimiter, require("./routes/locks"));
app.use("/api/conversations", apiLimiter, require("./routes/conversations"));
app.use("/api/analytics", apiLimiter, require("./routes/analytics"));
app.use("/api/exports", exportLimiter, require("./routes/exports"));
app.use("/api/leads", apiLimiter, require("./routes/leads"));
app.use("/api/lead-insights", apiLimiter, require("./routes/leadInsights"));
app.use("/api/partners", apiLimiter, require("./routes/partners"));
app.use("/api/message-templates", apiLimiter, require("./routes/messageTemplates"));
app.use(
  "/api/dossier-documents",
  apiLimiter,
  require("./routes/dossierDocuments"),
);

// Avoid serving a stale client build during local dev runs.
const isLocalDevRun =
  process.env.NODE_ENV === "development" ||
  process.env.npm_lifecycle_event === "server:dev";

// Serve React client build for non-dev runs (production-like behavior).
const clientBuildPath = path.join(__dirname, "../client/build");
if (!isLocalDevRun && fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));

  // Catch-all: any non-API route serves index.html so React Router handles it
  app.get("*", apiLimiter, (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
  });
} else {
  // Dev mode fallback
  app.get("/", apiLimiter, (req, res) => {
    res.json({ message: "Unified Inbox API is running" });
  });
}

// Subscribes the app to the Page's messaging webhook fields (messages,
// referrals, echoes...). See server/services/metaSubscription.js.
const { subscribePageToMessaging } = require("./services/metaSubscription");

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  subscribePageToMessaging();
});

module.exports = app;
