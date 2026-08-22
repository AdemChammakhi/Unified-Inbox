/**
 * supportDb.js — connection to the shared "Better Call Fedi" help-desk cluster.
 *
 * This is a SEPARATE database from the app's own MongoDB: the `bettercallfedi`
 * cluster is shared with other agency projects, and Fedi's triage app reads
 * the same `tickets` collection. We therefore use the raw driver here rather
 * than Mongoose — the documents follow Fedi's wire contract, not our schemas.
 *
 * Wire contract: "The Fedi Wire" v1.
 *
 * The connection is lazy and optional: when BCF_URI is absent the support
 * feature reports itself as unconfigured instead of crashing the server, so
 * deployments without help-desk credentials keep working normally.
 *
 * SECURITY: BCF_URI never leaves the backend. The contract explicitly warns
 * against shipping the connection string to clients, so all reads and writes
 * go through our own authenticated /api/support routes.
 */

"use strict";

const { MongoClient, ObjectId } = require("mongodb");

const DB_NAME = "bettercallfedi";

/**
 * Project identity on the help desk. Deliberately hardcoded, NOT read from
 * the environment: this is a fixed property of the product, and letting it
 * vary per deployment would file staging tickets under a different key (or
 * an unregistered one) than production. Changing it is a code change.
 */
const PROJECT_KEY = "Medtour CRM";
const PROJECT_NAME = "Medtour CRM";

let _client = null;
let _connecting = null;

function isConfigured() {
  return Boolean((process.env.BCF_URI || "").trim());
}

/**
 * Get the shared `tickets` collection, connecting on first use.
 * Concurrent callers share one in-flight connection attempt.
 * @returns {Promise<import("mongodb").Collection>}
 */
async function getTicketsCollection() {
  if (!isConfigured()) {
    throw Object.assign(
      new Error(
        "Support desk is not configured on this server (BCF_URI is not set).",
      ),
      { status: 503 },
    );
  }

  if (_client) return _client.db(DB_NAME).collection("tickets");

  if (!_connecting) {
    _connecting = MongoClient.connect(process.env.BCF_URI.trim(), {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxPoolSize: 5,
    })
      .then((client) => {
        _client = client;
        console.log("[Support] Connected to Better Call Fedi help desk");
        client.on("close", () => {
          _client = null;
        });
        return client;
      })
      .finally(() => {
        _connecting = null;
      });
  }

  const client = await _connecting;
  return client.db(DB_NAME).collection("tickets");
}

module.exports = {
  getTicketsCollection,
  isConfigured,
  ObjectId,
  PROJECT_KEY,
  PROJECT_NAME,
  DB_NAME,
};
