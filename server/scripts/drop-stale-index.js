/**
 * One-shot script: drops the stale unique index `uniq_platform_externalId`
 * from the messages collection that prevents outgoing messages with null
 * externalId from being created.
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  const collection = db.collection("messages");

  // List current indexes
  const indexes = await collection.indexes();
  console.log("Current indexes on messages:");
  indexes.forEach((idx) =>
    console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)} unique=${!!idx.unique}`)
  );

  // Drop the stale unique index if it exists
  const staleIndex = indexes.find((idx) => idx.name === "uniq_platform_externalId");
  if (staleIndex) {
    await collection.dropIndex("uniq_platform_externalId");
    console.log("\n✅ Dropped stale index: uniq_platform_externalId");
  } else {
    console.log("\n⚠️  Index uniq_platform_externalId not found — already removed.");
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
