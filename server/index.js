const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const connectDB = require("./config/db");

// Load .env from project root (one level up from server/)
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/webhooks", require("./routes/webhooks"));
app.use("/api/instagram", require("./routes/instagram"));

// Health check
app.get("/", (req, res) => {
  res.json({ message: "Unified Inbox API is running" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
