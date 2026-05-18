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
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Make io accessible in routes
app.set("io", io);

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
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/webhooks", require("./routes/webhooks"));
app.use("/api/instagram", require("./routes/instagram"));
app.use("/api/facebook", require("./routes/facebook"));
app.use("/api/email", require("./routes/email"));
app.use("/api/classifications", require("./routes/classifications"));
app.use("/api/locks", require("./routes/locks"));
app.use("/api/conversations", require("./routes/conversations"));
app.use("/api/analytics", require("./routes/analytics"));

// Avoid serving a stale client build during local dev runs.
const isLocalDevRun =
  process.env.NODE_ENV === "development" ||
  process.env.npm_lifecycle_event === "server:dev";

// Serve React client build for non-dev runs (production-like behavior).
const clientBuildPath = path.join(__dirname, "../client/build");
if (!isLocalDevRun && fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));

  // Catch-all: any non-API route serves index.html so React Router handles it
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
  });
} else {
  // Dev mode fallback
  app.get("/", (req, res) => {
    res.json({ message: "Unified Inbox API is running" });
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  subscribePageToMessaging();
});

// Subscribe the app to the Facebook Page's 'messages' field so the
// Instagram Messaging Send API (POST /{ig-user-id}/messages) works.
// Error code 3 "Application does not have the capability" is the symptom
// when this subscription is missing even if the token has the right scopes.
async function subscribePageToMessaging() {
  const axios = require("axios");
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token =
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
    process.env.INSTAGRAM_ACCESS_TOKEN;

  if (!pageId || !token) {
    console.warn(
      "[Startup] Skipping page subscription: FACEBOOK_PAGE_ID or page token not set",
    );
    return;
  }

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v24.0/${pageId}/subscribed_apps`,
      null,
      {
        params: {
          subscribed_fields:
            "messages,messaging_postbacks,message_deliveries,message_reads",
          access_token: token,
        },
      },
    );
    if (res.data?.success) {
      console.log("[Startup] Page subscription to messaging: OK");
    } else {
      console.warn("[Startup] Page subscription response:", res.data);
    }
  } catch (err) {
    console.warn(
      "[Startup] Page subscription failed (non-fatal):",
      err.response?.data?.error?.message || err.message,
    );
  }
}

module.exports = app;
