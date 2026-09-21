/**
 * dossierDocuments.js — pièces jointes du dossier client.
 *
 *   GET    /api/dossier-documents?platform=&customerId=   list, newest first
 *   POST   /api/dossier-documents                          multipart upload
 *   GET    /api/dossier-documents/:id/download             authenticated stream
 *   DELETE /api/dossier-documents/:id                      admin, manager or uploader
 *
 * The files are sensitive (passport copies), so they are NOT under the
 * public /uploads static mount: they live in server/uploads/dossiers/ (same
 * persisted volume, so they survive deploys), server/index.js answers 404 for
 * /uploads/dossiers/*, and this download route is the only way to read one.
 *
 * Download auth: Bearer header OR ?token= query param, the same fallback the
 * WhatsApp media proxy uses, because a plain <a href> cannot send headers.
 *
 * Everything is keyed by the CUSTOMER id (CLAUDE.md §6); a t_… thread id is
 * refused so a dossier never splits across the two id shapes.
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const DossierDocument = require("../models/DossierDocument");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { sanitizeId, sanitizePlatform } = require("../utils/sanitize");

const router = express.Router();

const DOSSIER_DIR = path.join(__dirname, "../uploads/dossiers");
if (!fs.existsSync(DOSSIER_DIR)) fs.mkdirSync(DOSSIER_DIR, { recursive: true });

const PLATFORMS = new Set(["instagram", "facebook", "whatsapp", "email"]);
const DOC_TYPES = new Set(DossierDocument.DOC_TYPES);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_LABEL = 120;
const MAX_ID_LENGTH = 512;
const STORED_NAME_RE = /^[a-f0-9]{32}(\.[a-z0-9]{1,5})?$/;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MSG = {
  platform: "Plateforme invalide.",
  customerId: "Identifiant client invalide.",
  threadId:
    "Identifiant client invalide : le dossier doit être rattaché au client, pas au fil de discussion.",
  docType: "Type de document invalide.",
  label: `Le libellé ne doit pas dépasser ${MAX_LABEL} caractères.`,
  noFile: "Aucun fichier reçu ou type de fichier non autorisé (images, PDF, Word, Excel).",
  tooBig: "Fichier trop volumineux (15 Mo maximum).",
  badUpload: "Envoi invalide.",
  badId: "Identifiant de document invalide.",
  notFound: "Document introuvable.",
  fileMissing: "Le fichier n’est plus disponible sur le serveur.",
  forbidden: "Seul l’auteur du document, un manager ou un administrateur peut le supprimer.",
  listFailed: "Impossible de charger les documents.",
  uploadFailed: "Impossible d’enregistrer le document.",
  downloadFailed: "Impossible de télécharger le document.",
  deleteFailed: "Impossible de supprimer le document.",
};

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Busboy decodes multipart file names as latin1 while browsers send UTF-8,
 * so "été.pdf" arrives as "Ã©tÃ©.pdf". Re-decode, keeping the original when
 * the bytes were not valid UTF-8 after all.
 */
function decodeOriginalName(name) {
  const raw = String(name || "");
  if (!/[\x80-\xff]/.test(raw)) return raw; // pure ASCII, nothing to fix
  const decoded = Buffer.from(raw, "latin1").toString("utf8");
  return decoded.includes("�") ? raw : decoded;
}

/** Extension from the browser's file name, restricted to [a-z0-9]{1,5}. */
function safeExtension(originalName) {
  const ext = path
    .extname(originalName || "")
    .toLowerCase()
    .replace(/^\./, "");
  return /^[a-z0-9]{1,5}$/.test(ext) ? `.${ext}` : "";
}

/** Validate the identity fields shared by list and upload. */
function parseIdentity(source) {
  const platform = sanitizePlatform(source.platform);
  if (!platform || !PLATFORMS.has(platform)) return { error: MSG.platform };

  const customerId = sanitizeId(source.customerId);
  if (!customerId || customerId.length > MAX_ID_LENGTH) {
    return { error: MSG.customerId };
  }
  if (customerId.startsWith("t_")) return { error: MSG.threadId };

  return { platform, customerId };
}

function unlinkQuiet(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("[dossier] unlink failed:", filePath, err.message);
    }
  });
}

/** Absolute path of a stored file, or null if the name is not ours. */
function storedPath(storedName) {
  if (typeof storedName !== "string" || !STORED_NAME_RE.test(storedName)) {
    return null;
  }
  return path.join(DOSSIER_DIR, storedName);
}

/**
 * Content-Disposition for a download: an ASCII-only `filename` for old
 * clients plus an RFC 5987 `filename*` carrying the real UTF-8 name.
 */
function contentDisposition(originalName, fallback) {
  const raw = String(originalName || fallback || "document")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f"\\/]/g, "")
    .trim()
    .slice(0, 180);
  const name = raw || fallback || "document";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Shape sent to the client. */
function toJSON(doc) {
  const u = doc.uploadedBy;
  return {
    id: String(doc._id),
    platform: doc.platform,
    customerId: doc.customerId,
    docType: doc.docType,
    label: doc.label || "",
    originalName: doc.originalName || "",
    mimeType: doc.mimeType,
    size: doc.size,
    uploadedBy:
      u && typeof u === "object" && u.firstName !== undefined
        ? {
            id: String(u._id),
            firstName: u.firstName,
            lastName: u.lastName,
          }
        : u
          ? { id: String(u) }
          : null,
    createdAt: doc.createdAt,
  };
}

/**
 * Auth for the download route: Bearer header first, then ?token=, since an
 * <a href> cannot send headers. Loads the user like `protect` does.
 */
async function protectHeaderOrQuery(req, res, next) {
  if (!process.env.JWT_SECRET) {
    return res
      .status(500)
      .json({ message: "Server misconfiguration: JWT_SECRET is missing." });
  }
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) token = header.split(" ")[1];
  if (!token && typeof req.query.token === "string") token = req.query.token;
  if (!token) return res.status(401).json({ message: "Not authorized, no token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");
    if (!req.user) {
      return res.status(401).json({ message: "Not authorized, user not found" });
    }
    return next();
  } catch {
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
}

/* ------------------------------------------------------------------------ */
/* Multer                                                                   */
/* ------------------------------------------------------------------------ */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOSSIER_DIR),
  filename: (req, file, cb) => {
    cb(
      null,
      `${crypto.randomBytes(16).toString("hex")}${safeExtension(file.originalname)}`,
    );
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
}).single("file");

/** Runs multer and turns its errors into French 400s. */
function receiveFile(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (req.file) unlinkQuiet(req.file.path);
    if (err instanceof multer.MulterError) {
      const message = err.code === "LIMIT_FILE_SIZE" ? MSG.tooBig : MSG.badUpload;
      return res.status(400).json({ message, error: err.code });
    }
    console.error("[dossier] upload error:", err.message);
    return res.status(400).json({ message: MSG.badUpload, error: err.message });
  });
}

/* ------------------------------------------------------------------------ */
/* Routes                                                                   */
/* ------------------------------------------------------------------------ */

// GET /api/dossier-documents?platform=&customerId=
router.get("/", protect, async (req, res) => {
  const identity = parseIdentity(req.query);
  if (identity.error) return res.status(400).json({ message: identity.error });

  try {
    const docs = await DossierDocument.find({
      platform: identity.platform,
      customerId: identity.customerId,
    })
      .sort({ createdAt: -1 })
      .limit(500)
      .populate("uploadedBy", "firstName lastName")
      .lean();
    return res.json({ documents: docs.map(toJSON) });
  } catch (err) {
    console.error("[dossier] list failed:", err.message);
    return res.status(500).json({ message: MSG.listFailed, error: err.message });
  }
});

// POST /api/dossier-documents — multipart: file, platform, customerId, docType, label
router.post("/", protect, receiveFile, async (req, res) => {
  const filePath = req.file?.path;
  const fail = (status, message) => {
    unlinkQuiet(filePath);
    return res.status(status).json({ message });
  };

  if (!req.file) return fail(400, MSG.noFile);
  // Belt and braces: fileFilter already refused anything else.
  if (!ALLOWED_MIME.has(req.file.mimetype)) return fail(400, MSG.noFile);

  const body = req.body || {};
  const identity = parseIdentity(body);
  if (identity.error) return fail(400, identity.error);

  const docType = sanitizeId(body.docType);
  if (!docType || !DOC_TYPES.has(docType)) return fail(400, MSG.docType);

  // Plain-text label; a leading "$" is fine here (it never reaches a query).
  const labelRaw = body.label === undefined ? "" : body.label;
  if (typeof labelRaw !== "string") return fail(400, MSG.label);
  const label = labelRaw.replace(/\s+/g, " ").trim();
  if (label.length > MAX_LABEL) return fail(400, MSG.label);

  try {
    const created = await DossierDocument.create({
      platform: identity.platform,
      customerId: identity.customerId,
      docType,
      label,
      originalName: decodeOriginalName(req.file.originalname).slice(0, 255),
      storedName: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user._id,
    });
    const doc = await DossierDocument.findById(created._id)
      .populate("uploadedBy", "firstName lastName")
      .lean();
    return res.status(201).json({ document: toJSON(doc) });
  } catch (err) {
    console.error("[dossier] create failed:", err.message);
    unlinkQuiet(filePath);
    return res.status(500).json({ message: MSG.uploadFailed, error: err.message });
  }
});

// GET /api/dossier-documents/:id/download — Bearer header or ?token=
router.get("/:id/download", protectHeaderOrQuery, async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: MSG.badId });
  }

  try {
    const doc = await DossierDocument.findById(id).lean();
    if (!doc) return res.status(404).json({ message: MSG.notFound });

    const filePath = storedPath(doc.storedName);
    if (!filePath) return res.status(404).json({ message: MSG.fileMissing });

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      if (err.code === "ENOENT") {
        return res.status(404).json({ message: MSG.fileMissing });
      }
      throw err;
    }
    if (!stat.isFile()) return res.status(404).json({ message: MSG.fileMissing });

    res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      contentDisposition(doc.originalName, doc.storedName),
    );
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(filePath);
    stream.on("error", (err) => {
      console.error("[dossier] stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ message: MSG.downloadFailed });
      } else {
        res.destroy();
      }
    });
    return stream.pipe(res);
  } catch (err) {
    console.error("[dossier] download failed:", err.message);
    return res.status(500).json({ message: MSG.downloadFailed, error: err.message });
  }
});

// DELETE /api/dossier-documents/:id — admin, manager, or the uploader
router.delete("/:id", protect, async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: MSG.badId });
  }

  try {
    const doc = await DossierDocument.findById(id).lean();
    if (!doc) return res.status(404).json({ message: MSG.notFound });

    const role = req.user.role;
    const isOwner =
      doc.uploadedBy && String(doc.uploadedBy) === String(req.user._id);
    if (role !== "admin" && role !== "manager" && !isOwner) {
      return res.status(403).json({ message: MSG.forbidden });
    }

    await DossierDocument.deleteOne({ _id: doc._id });

    const filePath = storedPath(doc.storedName);
    if (filePath) {
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error("[dossier] unlink failed:", filePath, err.message);
        }
      }
    }

    return res.json({ ok: true, id: String(doc._id) });
  } catch (err) {
    console.error("[dossier] delete failed:", err.message);
    return res.status(500).json({ message: MSG.deleteFailed, error: err.message });
  }
});

module.exports = router;
module.exports.DOSSIER_DIR = DOSSIER_DIR;
