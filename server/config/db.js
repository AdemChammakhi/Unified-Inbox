const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const conn = await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    // One-shot, idempotent: re-key classifications saved under a Meta
    // thread id to the customer id. Never blocks or fails startup.
    require("../db/migrateClassificationKeys")()
      .then((r) => {
        if (r.rekeyed > 0) {
          console.log(`[Startup] Classification keys migrated: ${r.rekeyed}/${r.scanned}`);
        }
      })
      .catch((e) => console.error("[Startup] Classification key migration failed:", e.message));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
