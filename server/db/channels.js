/**
 * channels.js — one dbo.channels row per platform, created on first use.
 *
 * external_id is the platform account id from the environment (the Page id,
 * the Instagram account id, the WhatsApp phone number id, the mailbox), or
 * the platform name when that variable is unset. channel_credentials records
 * which environment variable holds the token — never the token itself.
 */

"use strict";

const { tx, lockKey, at } = require("./sql");

const PLATFORM_ACCOUNT_ID_ENV = {
  facebook: "FACEBOOK_PAGE_ID",
  instagram: "INSTAGRAM_ACCOUNT_ID",
  whatsapp: "WHATSAPP_PHONE_NUMBER_ID",
  email: "EMAIL_USER",
  tiktok: "TIKTOK_ACCOUNT_ID",
};

const PLATFORM_TOKEN_ENV = {
  facebook: "FACEBOOK_PAGE_ACCESS_TOKEN",
  instagram: "INSTAGRAM_ACCESS_TOKEN",
  whatsapp: "WHATSAPP_ACCESS_TOKEN",
};

const _cache = new Map(); // platform -> Promise<channel_id>

/** The account id our own messages carry on this platform (null when unset). */
function ownAccountId(platform) {
  const name = PLATFORM_ACCOUNT_ID_ENV[platform];
  const value = name ? process.env[name] : null;
  return value ? String(value).trim() : null;
}

async function createOrFind(platform) {
  const externalId = (ownAccountId(platform) || platform).slice(0, 255);
  return tx(async (t) => {
    await lockKey(t, `channel:${platform}`);
    const found = await t.scalar(
      `SELECT channel_id FROM dbo.channels WHERE platform = @platform AND external_id = @externalId`,
      { platform, externalId },
    );
    if (found) return found;
    const now = new Date();
    const id = await t.scalar(
      `INSERT dbo.channels (platform, name, external_id, is_active, is_verified, auto_reply,
                            created_date, created_time, updated_date, updated_time)
       OUTPUT INSERTED.channel_id
       VALUES (@platform, @name, @externalId, 1, 1, 0, @now_date, @now_time, @now_date, @now_time)`,
      {
        platform,
        name: `${platform.charAt(0).toUpperCase()}${platform.slice(1)} Channel`,
        externalId,
        ...at("now", now),
      },
    );
    if (PLATFORM_TOKEN_ENV[platform]) {
      await t.query(
        `INSERT dbo.channel_credentials (channel_id, access_token_ref, updated_date, updated_time)
         VALUES (@id, @ref, @now_date, @now_time)`,
        { id, ref: PLATFORM_TOKEN_ENV[platform], ...at("now", now) },
      );
    }
    return id;
  });
}

/** The channel id of a platform, created when missing. Cached per process. */
function channelIdOf(platform) {
  if (!_cache.has(platform)) {
    const pending = createOrFind(platform).catch((err) => {
      _cache.delete(platform);
      throw err;
    });
    _cache.set(platform, pending);
  }
  return _cache.get(platform);
}

module.exports = { channelIdOf, ownAccountId, PLATFORM_ACCOUNT_ID_ENV };
