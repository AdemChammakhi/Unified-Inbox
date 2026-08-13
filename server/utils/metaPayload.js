/**
 * metaPayload.js — normalizers for Meta webhook payloads.
 *
 * Turns the platform-specific shapes Meta sends into the flat `context` and
 * `attachments` structures stored on Message (see models/Message.js).
 *
 * Payload shapes verified against Meta's developer docs (Aug 2026):
 *  - Messenger messages / messaging_referrals:
 *      message.referral & standalone referral = { ref, source, type, ad_id,
 *      ads_context_data: { ad_title, photo_url, video_url, post_id,
 *      product_id, flow_id } }
 *      message.attachments[] = { type, payload: { url, title, sticker_id } }
 *      types: audio | file | image | sticker | video | fallback | reel |
 *             ig_reel | post | ig_post | appointment_booking
 *  - Instagram messaging:
 *      message.reply_to.story = { url, id }
 *      attachments[] type "share" / "story_mention" with payload.url
 *      message.referral with ads_context_data (no post_id/product_id)
 *  - WhatsApp Cloud API:
 *      messages[].referral = { source_url, source_id, source_type, headline,
 *      body, media_type, image_url, video_url, thumbnail_url, ctwa_clid }
 *      media messages carry { id, mime_type, sha256, caption, filename }
 *
 * Every helper returns null / [] rather than throwing, so a malformed or
 * newly-added payload variant can never break message ingestion.
 */

"use strict";

/** Attachment types that are contextual references, not user-sent media. */
const CONTEXT_ATTACHMENT_TYPES = new Set([
  "share",
  "story_mention",
  "post",
  "ig_post",
  "reel",
  "ig_reel",
]);

/**
 * Build a context object from a Meta referral (Messenger / Instagram).
 * @param {object} referral - message.referral or a standalone referral event
 * @returns {object|null}
 */
function parseMetaReferral(referral) {
  if (!referral || typeof referral !== "object") return null;
  const ctx = referral.ads_context_data || {};
  const isAd = referral.source === "ADS" || !!referral.ad_id;

  const context = {
    kind: isAd ? "ad" : "referral",
    source: referral.source || null,
    adId: referral.ad_id || null,
    title: ctx.ad_title || null,
    photoUrl: ctx.photo_url || null,
    videoUrl: ctx.video_url || null,
    postId: ctx.post_id || null,
    productId: ctx.product_id || null,
    url: referral.referer_uri || null,
    ref: referral.ref || null,
  };

  // Only keep it if we actually learned something identifying
  const meaningful =
    context.adId ||
    context.title ||
    context.postId ||
    context.photoUrl ||
    context.url ||
    context.ref;
  return meaningful ? context : null;
}

/**
 * Build a context object from a WhatsApp Cloud API referral
 * (Click-to-WhatsApp ads). Shape differs from Messenger/Instagram.
 * @param {object} referral - messages[].referral
 * @returns {object|null}
 */
function parseWhatsAppReferral(referral) {
  if (!referral || typeof referral !== "object") return null;

  const context = {
    kind: referral.source_type === "post" ? "post" : "ad",
    source: referral.source_type || null,
    adId: referral.source_id || null,
    title: referral.headline || null,
    body: referral.body || null,
    photoUrl: referral.image_url || referral.thumbnail_url || null,
    videoUrl: referral.video_url || null,
    url: referral.source_url || null,
    ctwaClid: referral.ctwa_clid || null,
    ref: referral.ref || null,
  };

  const meaningful =
    context.adId || context.title || context.url || context.ctwaClid;
  return meaningful ? context : null;
}

/**
 * Extract context from an Instagram/Messenger message object:
 * an ad referral, a story reply, or a shared post/reel.
 * Referral wins when several are present — it carries the most attribution.
 * @param {object} message - the webhook `message` object
 * @returns {object|null}
 */
function parseMessageContext(message) {
  if (!message || typeof message !== "object") return null;

  const fromReferral = parseMetaReferral(message.referral);
  if (fromReferral) return fromReferral;

  // Instagram story reply: message.reply_to.story = { url, id }
  const story = message.reply_to?.story;
  if (story && (story.url || story.id)) {
    return {
      kind: "story_reply",
      title: "Replied to your story",
      photoUrl: story.url || null,
      url: story.url || null,
      postId: story.id || null,
    };
  }

  // Shared post / reel / story mention arrives as an attachment
  const shared = (message.attachments || []).find((a) =>
    CONTEXT_ATTACHMENT_TYPES.has(a?.type),
  );
  if (shared) {
    const url = shared.payload?.url || null;
    const isMention = shared.type === "story_mention";
    return {
      kind: isMention ? "story_mention" : "share",
      title: isMention
        ? "Mentioned you in a story"
        : shared.payload?.title || "Shared a post",
      photoUrl: url,
      url,
      postId: shared.payload?.id ? String(shared.payload.id) : null,
    };
  }

  return null;
}

/**
 * Normalize Messenger/Instagram message.attachments into our schema.
 * Contextual types (share, story_mention, post, reel) are excluded — those
 * are surfaced as `context` instead so they render as a card, not as media.
 * @param {object} message
 * @returns {Array<object>}
 */
function parseMetaAttachments(message) {
  const list = message?.attachments;
  if (!Array.isArray(list)) return [];

  return list
    .filter((a) => a && a.type && !CONTEXT_ATTACHMENT_TYPES.has(a.type))
    .map((a) => ({
      type: a.type,
      url: a.payload?.url || null,
      name: a.payload?.title || null,
    }))
    .filter((a) => a.url);
}

/** WhatsApp inbound media message types → our attachment type. */
const WA_MEDIA_TYPES = {
  image: "image",
  video: "video",
  audio: "audio",
  voice: "audio",
  document: "file",
  sticker: "image",
};

/**
 * Normalize a WhatsApp inbound media message into our attachment schema.
 * WhatsApp sends only a media ID — the binary must be fetched with the access
 * token and its URL expires in ~5 min, so we store the ID and point `url` at
 * our own authenticated proxy route.
 * @param {object} msg - one entry from value.messages[]
 * @returns {Array<object>}
 */
function parseWhatsAppAttachments(msg) {
  if (!msg || typeof msg !== "object") return [];
  const mapped = WA_MEDIA_TYPES[msg.type];
  if (!mapped) return [];

  const media = msg[msg.type];
  if (!media?.id) return [];

  return [
    {
      type: mapped,
      mediaId: media.id,
      url: `/api/whatsapp/media/${encodeURIComponent(media.id)}`,
      name: media.filename || null,
      mimeType: media.mime_type || null,
    },
  ];
}

/**
 * Text body of a WhatsApp message.
 * Covers every inbound type that would otherwise render as an empty bubble:
 * media captions, reactions (customer taps an emoji on a message), shared
 * locations, button/list replies from welcome-message flows, contact cards
 * and unsupported types.
 * @param {object} msg
 * @returns {string}
 */
function whatsAppMessageText(msg) {
  if (!msg) return "";
  if (msg.text?.body) return msg.text.body;

  switch (msg.type) {
    case "reaction":
      // Reaction with empty emoji = the customer REMOVED a reaction
      return msg.reaction?.emoji
        ? `${msg.reaction.emoji} (reaction)`
        : "(reaction removed)";
    case "location": {
      const loc = msg.location || {};
      const label = loc.name || loc.address || "Shared location";
      if (loc.latitude != null && loc.longitude != null) {
        return `📍 ${label} — https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      }
      return `📍 ${label}`;
    }
    case "button":
      return msg.button?.text || "";
    case "interactive":
      return (
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        ""
      );
    case "contacts": {
      const names = (msg.contacts || [])
        .map((c) => c.name?.formatted_name)
        .filter(Boolean);
      return names.length > 0 ? `👤 Contact: ${names.join(", ")}` : "";
    }
    case "order":
      return "🛒 Sent an order";
    case "unsupported":
      return "[Message not supported by WhatsApp — view it on the phone]";
    default: {
      const media = msg[msg.type];
      if (media?.caption) return media.caption;
      return "";
    }
  }
}

/**
 * Pick the Message.messageType enum value for a set of attachments.
 * @param {Array<object>} attachments
 * @returns {string}
 */
function messageTypeFor(attachments) {
  if (!attachments || attachments.length === 0) return "text";
  const t = attachments[0].type;
  if (t === "image" || t === "video" || t === "audio") return t;
  if (t === "file") return "document";
  return "attachment";
}

/**
 * Normalize attachments from the Graph API conversations endpoint
 * (GET /{conv-id}?fields=messages{attachments}) — a different shape from
 * webhooks: { data: [ { id, image_data:{url}, video_data:{url}, file_url,
 * name, mime_type } ] }.
 * @param {object} attachments - the raw `attachments` field of a message
 * @returns {Array<object>}
 */
function parseGraphAttachments(attachments) {
  const list = attachments?.data;
  if (!Array.isArray(list)) return [];

  return list
    .map((a) => {
      const mime = a.mime_type || "";
      const type = a.image_data
        ? "image"
        : a.video_data
          ? "video"
          : mime.startsWith("audio")
            ? "audio"
            : "file";
      return {
        type,
        url: a.image_data?.url || a.video_data?.url || a.file_url || null,
        name: a.name || null,
        mimeType: mime || null,
      };
    })
    .filter((a) => a.url);
}

module.exports = {
  parseMetaReferral,
  parseWhatsAppReferral,
  parseMessageContext,
  parseMetaAttachments,
  parseWhatsAppAttachments,
  parseGraphAttachments,
  whatsAppMessageText,
  messageTypeFor,
};
