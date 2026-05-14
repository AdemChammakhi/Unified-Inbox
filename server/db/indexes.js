/**
 * indexes.js
 *
 * Explicit index-creation script for MongoDB Atlas / production deployments.
 *
 * Run once after deploying new schema versions:
 *   node server/db/indexes.js
 *
 * Mongoose auto-creates indexes defined in schema files during development
 * (autoIndex:true by default), but in production you should set
 * autoIndex:false in the connection options and run this script as a
 * deployment step so index creation never blocks application startup.
 *
 * Usage:
 *   node server/db/indexes.js
 *
 * Environment variables required (same as server/index.js):
 *   MONGODB_URI
 */

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

// Import all models so their schemas (and thus their indexes) are registered
require("../models");

async function ensureIndexes() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGO_URI is not set");
    process.exit(1);
  }

  console.log("Connecting to MongoDB…");
  await mongoose.connect(uri, { autoIndex: false });
  console.log("Connected.");

  const modelNames = mongoose.modelNames();
  console.log(`\nEnsuring indexes for ${modelNames.length} models:\n`);

  for (const name of modelNames) {
    const model = mongoose.model(name);
    try {
      await model.ensureIndexes();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

ensureIndexes().catch((err) => {
  console.error(err);
  process.exit(1);
});
