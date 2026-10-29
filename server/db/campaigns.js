/**
 * campaigns.js — the ads conversations come from, in dbo.campaigns.
 *
 * Meta referral payloads (Click-to-Messenger, Click-to-Instagram and
 * Click-to-WhatsApp ads) name the ad a customer tapped. The ad becomes a
 * campaign row (external_id = the ad id) and the conversation keeps the
 * FIRST ad that brought it (conversations.campaign_id is never overwritten).
 * The prospect sheet's "Source" column and the warehouse's campaign
 * dimension read it. Referrals that are not ads (m.me links, story replies,
 * shared posts) are not campaigns and are not stored (decision D3).
 */

"use strict";

const { tx, lockKey, at } = require("./sql");
const { fit, url500 } = require("./contacts");

/** campaigns.platform allows facebook, instagram and tiktok only. */
function campaignPlatform(platform, context) {
  if (platform === "instagram" || platform === "facebook") return platform;
  return /instagram\.com/i.test(context?.url || "") ? "instagram" : "facebook";
}

/**
 * Attach the ad of a referral to a conversation.
 * @param {object} conversation  { id, channelId } (conversations.js shape)
 * @param {string} platform      the conversation's platform
 * @param {object} context       parsed referral (utils/metaPayload)
 * @returns {Promise<number|null>} the campaign id, or null when not an ad
 */
async function recordReferral(conversation, platform, context) {
  if (!conversation || !context || context.kind !== "ad") return null;
  const adId = fit(context.adId, 255);
  if (!adId) return null;
  const plat = campaignPlatform(platform, context);
  const now = new Date();
  return tx(async (t) => {
    await lockKey(t, `campaign:${plat}:${adId}`);
    let id = await t.scalar(
      `SELECT TOP 1 campaign_id FROM dbo.campaigns WHERE platform = @plat AND external_id = @adId ORDER BY campaign_id`,
      { plat, adId },
    );
    const values = {
      title: fit(context.title, 255),
      preview: typeof context.body === "string" && context.body.trim() ? context.body.trim() : null,
      permalink: url500(context.url),
    };
    if (!id) {
      id = await t.scalar(
        `INSERT dbo.campaigns (channel_id, platform, external_id, title, content_preview, permalink, status,
                               diffusion_date, diffusion_time)
         OUTPUT INSERTED.campaign_id
         VALUES (@channelId, @plat, @adId, @title, @preview, @permalink, N'active', @now_date, @now_time)`,
        { channelId: conversation.channelId, plat, adId, ...values, ...at("now", now) },
      );
    } else {
      await t.query(
        `UPDATE dbo.campaigns SET title = COALESCE(title, @title), content_preview = COALESCE(content_preview, @preview),
                                  permalink = COALESCE(permalink, @permalink)
         WHERE campaign_id = @id`,
        { id, ...values },
      );
    }
    await t.query(
      `UPDATE dbo.conversations SET campaign_id = @id WHERE conversation_id = @conv AND campaign_id IS NULL`,
      { id, conv: conversation.id },
    );
    return id;
  });
}

module.exports = { recordReferral };
