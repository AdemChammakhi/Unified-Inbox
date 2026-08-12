/**
 * conversationService.js
 *
 * Shared helper used by every webhook/email route to resolve the correct
 * Channel, Contact and Conversation documents before saving a Message.
 *
 * All callers pass a `platform` + `externalSenderId` and get back a
 * Conversation ObjectId they can attach the Message to.
 */

"use strict";

const mongoose = require("mongoose");
const { Channel, Contact, Conversation } = require("../models");

/**
 * Map a Message.messageType value onto the lastMessage.type enum
 * (which has no "attachment"/"other" members).
 */
const LAST_MESSAGE_TYPE_MAP = {
  attachment: "document",
  other: "unsupported",
};

function toLastMessageType(type) {
  const t = type || "text";
  return LAST_MESSAGE_TYPE_MAP[t] || t;
}

/**
 * Map from platform name to the env var holding the platform account ID.
 * Used to seed the Channel document on first run.
 */
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
  email: null,
  tiktok: null,
};

/**
 * Find or lazily create the Channel document for a given platform.
 * Cached in-process after first creation so repeated webhook calls don't
 * hit MongoDB for channel lookup on every message.
 */
const _channelCache = {};

async function getOrCreateChannel(platform) {
  if (_channelCache[platform]) return _channelCache[platform];

  const accountId = process.env[PLATFORM_ACCOUNT_ID_ENV[platform]];
  const tokenRef = PLATFORM_TOKEN_ENV[platform];

  let channel = await Channel.findOne({
    platform,
    externalId: accountId || platform,
  });

  if (!channel) {
    channel = await Channel.create({
      platform,
      name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Channel`,
      externalId: accountId || platform,
      accessTokenRef: tokenRef || undefined,
      isActive: true,
      isVerified: true,
    });
  }

  _channelCache[platform] = channel;
  return channel;
}

/**
 * Find or create the Channel, Contact, and Conversation for an incoming
 * message, then return the Conversation document.
 *
 * This is the single entry point used by ALL webhook handlers.
 *
 * @param {object} opts
 * @param {string}  opts.platform          - "facebook" | "instagram" | "whatsapp" | "email"
 * @param {string}  opts.externalSenderId  - Platform-native sender ID
 * @param {string}  [opts.senderName]      - Display name from platform
 * @param {string}  [opts.senderAvatar]    - Profile picture URL
 * @param {string}  [opts.senderUsername]  - @username (Instagram)
 * @returns {Promise<{channel, contact, conversation}>}
 */
async function getOrCreateConversation({
  platform,
  externalSenderId,
  senderName,
  senderAvatar,
  senderUsername,
}) {
  const channel = await getOrCreateChannel(platform);

  const contact = await Contact.findOrCreateByPlatformId(
    platform,
    externalSenderId,
    {
      name: senderName || senderUsername || externalSenderId,
      username: senderUsername || null,
      avatar: senderAvatar || null,
    },
  );

  const resolvedName = senderName || senderUsername || externalSenderId;

  const update = {
    $setOnInsert: {
      platform,
      externalId: externalSenderId,
      channelId: channel._id,
      contactId: contact._id,
      participantName: resolvedName,
      participantExternalId: externalSenderId,
    },
  };
  // Late-arriving avatars should reach existing conversations too
  if (senderAvatar) {
    update.$set = { participantAvatar: senderAvatar };
  } else {
    update.$setOnInsert.participantAvatar = null;
  }

  const conversation = await Conversation.findOneAndUpdate(
    { platform: String(platform), externalId: String(externalSenderId) },
    update,
    { upsert: true, new: true },
  );

  return { channel, contact, conversation };
}

/**
 * Atomically update lastMessage and counters on a Conversation after a
 * Message document has been saved.
 *
 * @param {ObjectId} conversationId
 * @param {object}   message   - Saved Message document
 */
async function updateConversationAfterMessage(conversationId, message) {
  const isInbound = message.direction === "inbound" || message.direction === "incoming";
  const normalizedDirection = isInbound ? "inbound" : "outbound";

  const query = {};
  if (mongoose.Types.ObjectId.isValid(conversationId)) {
    query._id = conversationId;
  } else {
    query.externalId = conversationId;
    query.platform = message.platform;
  }

  return Conversation.findOneAndUpdate(
    query,
    {
      $set: {
        lastMessage: {
          messageId: message._id,
          content: (message.content || message.text || "").substring(0, 200),
          type: toLastMessageType(message.messageType || message.type),
          direction: normalizedDirection,
          senderName: message.senderName || message.sender?.name || "",
          sentAt: message.timestamp || message.createdAt || new Date(),
        },
      },
      $inc: {
        messageCount: 1,
        unreadCount: isInbound ? 1 : 0,
      },
    },
    { new: true }
  );
}

/**
 * Batch-resolve stored avatars for a set of platform sender IDs.
 * Used by the conversation-list routes to give DB-only conversations
 * (created by webhooks, not yet returned by the Graph API) a profile
 * picture without any external API calls.
 *
 * @param {string} platform
 * @param {Iterable<string>} externalIds
 * @returns {Promise<Object<string,string>>} map externalId -> avatar URL
 */
async function getContactAvatarMap(platform, externalIds) {
  const ids = [...new Set([...externalIds].filter(Boolean))];
  if (ids.length === 0) return {};
  try {
    const contacts = await Contact.find({
      platformIdentities: {
        $elemMatch: { platform, externalId: { $in: ids } },
      },
    })
      .select("avatar platformIdentities.platform platformIdentities.externalId platformIdentities.avatar")
      .lean();

    const map = {};
    for (const c of contacts) {
      for (const ident of c.platformIdentities || []) {
        if (ident.platform !== platform) continue;
        const avatar = ident.avatar || c.avatar;
        if (ids.includes(ident.externalId) && avatar) {
          map[ident.externalId] = avatar;
        }
      }
    }
    return map;
  } catch (err) {
    console.error("Avatar map lookup failed (non-fatal):", err.message);
    return {};
  }
}

module.exports = {
  getOrCreateConversation,
  updateConversationAfterMessage,
  getOrCreateChannel,
  getContactAvatarMap,
};
