/**
 * uploads.js — agent file uploads for outbound media messages.
 *
 * Files land in server/uploads/ with random names and are served statically
 * at /uploads (see server/index.js). Meta fetches media by URL, so the file
 * must be publicly reachable:
 *  - Instagram Send API ONLY accepts a public URL (image 8MB, audio/video 25MB)
 *  - Messenger Send API accepts payload.url
 *  - WhatsApp Cloud API accepts { link } (id-based upload recommended by Meta,
 *    link is fine at this scale)
 * Set PUBLIC_URL in .env to the site origin (e.g. https://yourdomain.com);
 * without it we fall back to the request's host header.
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { protect } = require("../middleware/auth");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "../uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Types Meta will accept across the four channels
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/ogg",
  "video/x-msvideo",
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/amr",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Unguessable name; keep a sanitized extension for content-type sniffing
    const ext = path
      .extname(file.originalname || "")
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, "")
      .slice(0, 10);
    cb(null, `${crypto.randomBytes(16).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // Meta's largest cap (video/audio 25MB)
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_MIME.has(file.mimetype));
  },
});

/** Broad media bucket used by the send routes and the UI. */
function mediaTypeOf(mimeType) {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

// POST /api/uploads — multipart field "file"; returns the public URL
router.post("/", protect, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ message: "No file received or unsupported file type" });
  }

  const base =
    (process.env.PUBLIC_URL || "").replace(/\/+$/, "") ||
    `${req.protocol}://${req.get("host")}`;
  const relPath = `/uploads/${req.file.filename}`;

  return res.json({
    url: `${base}${relPath}`,
    path: relPath,
    name: req.file.originalname || req.file.filename,
    mimeType: req.file.mimetype,
    mediaType: mediaTypeOf(req.file.mimetype),
    size: req.file.size,
  });
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.mediaTypeOf = mediaTypeOf;
