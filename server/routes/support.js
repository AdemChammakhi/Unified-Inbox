/**
 * support.js — file and follow support tickets on the Better Call Fedi desk.
 *
 * Implements "The Fedi Wire" v1 contract. Every document we insert carries the
 * full shape (all fields present, arrays included even when empty) so tickets
 * sort, filter and render correctly in Fedi's triage app.
 *
 * Division of ownership, per the contract:
 *   we write  — projectKey, projectName, title, description, reporter*,
 *               screenshots, priority, comments (fromAdmin:false), timestamps
 *   Fedi owns — status transitions, priority re-triage, fixes[], his comments
 * Once filed we only ever append our own comments and bump updatedAt.
 *
 * The `tickets` collection is SHARED with other agencies' projects, so every
 * query here is scoped by projectKey — including single-ticket reads, so a
 * guessed _id can never surface another project's ticket.
 */

"use strict";

const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  getTicketsCollection,
  isConfigured,
  ObjectId,
  PROJECT_KEY,
  PROJECT_NAME,
} = require("../config/supportDb");

const PRIORITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10000;
const MAX_COMMENT = 5000;
const MAX_SCREENSHOTS = 4;
// MongoDB caps a whole document at 16MB. Stay well under it: the contract
// asks for ~400KB per encoded screenshot, so 6MB total is generous while
// leaving room for the comment thread to grow over the ticket's life.
const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;

const BASE64_IMAGE = /^(data:image\/[a-zA-Z+]+;base64,)?[A-Za-z0-9+/\s]+={0,2}$/;

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Shape a ticket for the client: never leak other projects' data. */
function publicTicket(doc, { includeScreenshots = false } = {}) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    title: doc.title || "",
    description: doc.description || "",
    status: doc.status || "OPEN",
    priority: PRIORITIES.has(doc.priority) ? doc.priority : "MEDIUM",
    reporterName: doc.reporterName || "",
    reporterEmail: doc.reporterEmail || "",
    comments: Array.isArray(doc.comments)
      ? doc.comments.map((c) => ({
          id: String(c._id || ""),
          author: c.author || "",
          fromAdmin: c.fromAdmin === true,
          text: c.text || "",
          createdAt: c.createdAt || null,
        }))
      : [],
    fixes: Array.isArray(doc.fixes)
      ? doc.fixes.map((f) => ({
          id: String(f._id || ""),
          description: f.description || "",
          version: f.version || "",
          appliedAt: f.appliedAt || null,
        }))
      : [],
    // Only report a count when the blobs were actually loaded — list queries
    // project them out, and a hard-coded 0 there would be a lie.
    ...(Array.isArray(doc.screenshots)
      ? { screenshotCount: doc.screenshots.length }
      : {}),
    ...(includeScreenshots
      ? { screenshots: Array.isArray(doc.screenshots) ? doc.screenshots : [] }
      : {}),
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

/** Uniform error response — distinguishes "not set up" from "desk down". */
function deskError(res, err, action) {
  console.error(`[Support] ${action} failed:`, err.message);
  return res.status(err.status || 502).json({
    message:
      err.status === 503 ? err.message : "Could not reach the support desk",
  });
}

// GET /api/support/status — is the desk reachable from this deployment?
router.get("/status", protect, (req, res) => {
  return res.json({
    configured: isConfigured(),
    projectKey: PROJECT_KEY,
    projectName: PROJECT_NAME,
  });
});

// GET /api/support/tickets — our project's tickets, newest activity first.
// Screenshots are excluded per the contract: they are heavy blobs and the
// list view never shows them.
router.get("/tickets", protect, async (req, res) => {
  try {
    const tickets = await getTicketsCollection();
    const docs = await tickets
      .find({ projectKey: PROJECT_KEY })
      .project({ screenshots: 0 })
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray();
    return res.json({ tickets: docs.map((d) => publicTicket(d)) });
  } catch (err) {
    return deskError(res, err, "list");
  }
});

// GET /api/support/tickets/:id — one ticket, with screenshots
router.get("/tickets/:id", protect, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid ticket id" });
  }
  try {
    const tickets = await getTicketsCollection();
    const doc = await tickets.findOne({
      _id: new ObjectId(req.params.id),
      projectKey: PROJECT_KEY, // scoped: never expose another project's ticket
    });
    if (!doc) return res.status(404).json({ message: "Ticket not found" });
    return res.json({ ticket: publicTicket(doc, { includeScreenshots: true }) });
  } catch (err) {
    return deskError(res, err, "fetch");
  }
});

// POST /api/support/tickets — file a new ticket
router.post("/tickets", protect, async (req, res) => {
  const title = str(req.body.title);
  const description = str(req.body.description);
  const priority = str(req.body.priority).toUpperCase() || "MEDIUM";
  const screenshots = Array.isArray(req.body.screenshots)
    ? req.body.screenshots
    : [];

  if (!title || !description) {
    return res
      .status(400)
      .json({ message: "A title and a description are required" });
  }
  if (title.length > MAX_TITLE) {
    return res
      .status(400)
      .json({ message: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  if (description.length > MAX_DESCRIPTION) {
    return res.status(400).json({
      message: `Description must be ${MAX_DESCRIPTION} characters or fewer`,
    });
  }
  if (!PRIORITIES.has(priority)) {
    return res
      .status(400)
      .json({ message: "Priority must be LOW, MEDIUM, HIGH or CRITICAL" });
  }
  if (screenshots.length > MAX_SCREENSHOTS) {
    return res
      .status(400)
      .json({ message: `At most ${MAX_SCREENSHOTS} screenshots per ticket` });
  }

  let totalBytes = 0;
  for (const shot of screenshots) {
    if (typeof shot !== "string" || !BASE64_IMAGE.test(shot)) {
      return res
        .status(400)
        .json({ message: "Screenshots must be base64-encoded images" });
    }
    totalBytes += shot.length;
  }
  if (totalBytes > MAX_SCREENSHOT_BYTES) {
    return res.status(400).json({
      message:
        "Screenshots are too large. Keep them under ~1280px and around 300KB each.",
    });
  }

  const now = Date.now();
  const reporterName =
    str(req.body.reporterName) ||
    `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
    "Unknown";
  const reporterEmail = str(req.body.reporterEmail) || req.user.email || "";

  const doc = {
    projectKey: PROJECT_KEY,
    projectName: PROJECT_NAME,
    title,
    description,
    reporterName,
    reporterEmail,
    screenshots,
    status: "OPEN", // contract: always OPEN at submission — Fedi owns transitions
    priority,
    comments: [],
    fixes: [], // contract: always empty — Fedi fills this
    createdAt: now,
    updatedAt: now,
  };

  try {
    const tickets = await getTicketsCollection();
    const result = await tickets.insertOne(doc);
    console.log(
      `[Support] Ticket filed by ${reporterName}: ${title} (${priority})`,
    );
    return res.status(201).json({
      ticket: publicTicket({ ...doc, _id: result.insertedId }),
    });
  } catch (err) {
    return deskError(res, err, "insert");
  }
});

// POST /api/support/tickets/:id/comments — reply on our side of the thread.
// Append-only: we never edit or remove Fedi's comments, and our comments are
// always fromAdmin:false.
router.post("/tickets/:id/comments", protect, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid ticket id" });
  }
  const text = str(req.body.text);
  if (!text) return res.status(400).json({ message: "A message is required" });
  if (text.length > MAX_COMMENT) {
    return res
      .status(400)
      .json({ message: `Message must be ${MAX_COMMENT} characters or fewer` });
  }

  const now = Date.now();
  const comment = {
    _id: new ObjectId(),
    author:
      `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
      req.user.email ||
      "Reporter",
    fromAdmin: false, // contract: our side never claims admin authorship
    text,
    createdAt: now,
  };

  try {
    const tickets = await getTicketsCollection();
    // Driver 5 returns {value}, driver 6 returns the document directly
    const result = await tickets.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), projectKey: PROJECT_KEY },
      { $push: { comments: comment }, $set: { updatedAt: now } },
      { returnDocument: "after", projection: { screenshots: 0 } },
    );
    const doc = result && result.value !== undefined ? result.value : result;
    if (!doc || !doc._id) {
      return res.status(404).json({ message: "Ticket not found" });
    }
    return res.json({ ticket: publicTicket(doc) });
  } catch (err) {
    return deskError(res, err, "comment");
  }
});

module.exports = router;
