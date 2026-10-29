/**
 * storedMedia.js — make an attachment URL fit message.attachment_url.
 *
 * The column is nvarchar(500) (database/sqlserver/schema, decision D5). Our
 * own URLs (uploads, the WhatsApp media proxy) are short, but the signed CDN
 * URLs Meta sends for customer media run past 500 characters — and expire
 * anyway. Those files are copied to the uploads volume and the message keeps
 * our URL instead (decision E10). Only Meta's CDN hosts are fetched.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { UPLOAD_DIR } = require("../routes/uploads");

const MAX_URL = 500;
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 15000;

const ALLOWED_HOSTS = ["fbcdn.net", "fbsbx.com", "cdninstagram.com", "facebook.com", "instagram.com", "whatsapp.net"];

const EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
};

/** Shown instead of a media-only message whose file could not be kept. */
const UNAVAILABLE_TEXT = "[Pièce jointe indisponible]";

function allowedSource(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function publicUrl(fileName) {
  const base = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  return `${base}/uploads/${fileName}`;
}

async function download(url) {
  const res = await axios.get(url, {
    responseType: "stream",
    timeout: TIMEOUT_MS,
    maxRedirects: 3,
    maxContentLength: MAX_BYTES,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const fileName = `${crypto.randomBytes(16).toString("hex")}${EXTENSIONS[type] || ""}`;
  const target = path.join(UPLOAD_DIR, fileName);
  await new Promise((resolve, reject) => {
    let bytes = 0;
    const out = fs.createWriteStream(target, { flags: "wx" });
    const fail = (err) => {
      res.data.destroy();
      out.destroy();
      fs.unlink(target, () => reject(err));
    };
    res.data.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) fail(new Error("attachment larger than 25 MB"));
    });
    res.data.on("error", fail);
    out.on("error", fail);
    out.on("finish", resolve);
    res.data.pipe(out);
  });
  return publicUrl(fileName);
}

/**
 * The URL to store for an attachment: itself when it fits, else a copy on
 * the uploads volume; null when it cannot be kept.
 * @param {string|null|undefined} url
 * @returns {Promise<string|null>}
 */
async function storableUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  const trimmed = url.trim();
  if (trimmed.length <= MAX_URL) return trimmed;
  if (!allowedSource(trimmed)) return null;
  try {
    const copy = await download(trimmed);
    return copy.length <= MAX_URL ? copy : null;
  } catch (err) {
    console.warn("[Media] attachment not kept:", err.message);
    return null;
  }
}

/**
 * The attachment URL and message type to store for a normalized attachment
 * list (utils/metaPayload shapes): the first attachment only (decision D3).
 * @returns {Promise<{attachmentUrl: string|null, lost: boolean}>}
 */
async function firstAttachmentUrl(attachments) {
  const first = Array.isArray(attachments) ? attachments.find((a) => a && a.url) : null;
  if (!first) return { attachmentUrl: null, lost: false };
  const stored = await storableUrl(first.url);
  return { attachmentUrl: stored, lost: !stored };
}

module.exports = { storableUrl, firstAttachmentUrl, UNAVAILABLE_TEXT };
