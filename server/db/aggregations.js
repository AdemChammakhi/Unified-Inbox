/**
 * aggregations.js
 *
 * Reusable MongoDB aggregation pipelines for the inbox system.
 *
 * All pipelines are designed around the indexes defined in each model.
 * Keep these in sync with the index definitions in server/models/.
 */

"use strict";

const mongoose = require("mongoose");
const { Conversation, Message, Contact } = require("../models");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const toId = (v) =>
  v instanceof mongoose.Types.ObjectId
    ? v
    : new mongoose.Types.ObjectId(String(v));

// ─────────────────────────────────────────────────────────────────────────────
// Inbox list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paginated inbox list.
 *
 * Uses the embedded `lastMessage` snapshot so NO join into `messages` is needed.
 * Lookups are performed only on `contacts` and `users`, which are tiny projections.
 *
 * Supported filters:
 *   channelId, status, platform, assignedTo, unreadOnly, tags, search (text)
 *
 * @param {object} opts
 * @param {string}  [opts.channelId]
 * @param {string}  [opts.status="open"]
 * @param {string}  [opts.platform]
 * @param {string}  [opts.assignedTo]
 * @param {boolean} [opts.unreadOnly=false]
 * @param {string[]} [opts.tags]
 * @param {string}  [opts.search]       Full-text search on participantName
 * @param {number}  [opts.page=1]
 * @param {number}  [opts.limit=20]
 * @returns {Promise<object[]>}
 */
async function getInboxList({
  channelId,
  status = "open",
  platform,
  assignedTo,
  unreadOnly = false,
  tags,
  search,
  page = 1,
  limit = 20,
} = {}) {
  const match = { deletedAt: null };

  if (channelId) match.channelId = toId(channelId);
  if (status) match.status = status;
  if (platform) match.platform = platform;
  if (assignedTo) match.assignedTo = toId(assignedTo);
  if (unreadOnly) match.unreadCount = { $gt: 0 };
  if (tags?.length) match.tags = { $in: tags };
  if (search) match.$text = { $search: search };

  const sortStage = search
    ? { score: { $meta: "textScore" }, "lastMessage.sentAt": -1 }
    : { "lastMessage.sentAt": -1 };

  return Conversation.aggregate([
    { $match: match },
    { $sort: sortStage },
    { $skip: (page - 1) * limit },
    { $limit: limit },

    // Resolve contact (lightweight projection only)
    {
      $lookup: {
        from: "contacts",
        localField: "contactId",
        foreignField: "_id",
        as: "contact",
        pipeline: [
          {
            $project: {
              displayName: 1,
              email: 1,
              phone: 1,
              avatar: 1,
              tags: 1,
              isVIP: 1,
            },
          },
        ],
      },
    },
    { $unwind: { path: "$contact", preserveNullAndEmptyArrays: true } },

    // Resolve assigned agent (name only)
    {
      $lookup: {
        from: "users",
        localField: "assignedTo",
        foreignField: "_id",
        as: "assignedAgent",
        pipeline: [{ $project: { firstName: 1, lastName: 1 } }],
      },
    },
    { $unwind: { path: "$assignedAgent", preserveNullAndEmptyArrays: true } },

    {
      $project: {
        platform: 1,
        externalId: 1,
        participantName: 1,
        participantAvatar: 1,
        lastMessage: 1,
        unreadCount: 1,
        messageCount: 1,
        status: 1,
        classification: 1,
        tags: 1,
        assignedAgent: 1,
        contact: 1,
        lockedBy: 1,
        aiSentiment: 1,
        createdAt: 1,
        updatedAt: 1,
        ...(search ? { score: { $meta: "textScore" } } : {}),
      },
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Message pagination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cursor-based message pagination for a conversation.
 *
 * Pass `before` (ISO date string) to load older messages.
 * Pass `after`  (ISO date string) to poll for newer messages (realtime catch-up).
 *
 * Returns messages in ascending order (oldest first) ready for display.
 *
 * @param {object} opts
 * @param {string}  opts.conversationId
 * @param {string}  [opts.before]   Load messages older than this timestamp
 * @param {string}  [opts.after]    Load messages newer than this timestamp
 * @param {number}  [opts.limit=50]
 * @returns {Promise<object[]>}
 */
async function getMessages({ conversationId, before, after, limit = 50 } = {}) {
  const match = {
    conversationId: toId(conversationId),
    deletedAt: null,
  };

  if (before) match.createdAt = { $lt: new Date(before) };
  if (after) match.createdAt = { $gt: new Date(after) };

  return Message.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $limit: limit },
    { $sort: { createdAt: 1 } }, // re-sort ascending for display

    // Hydrate attachments
    {
      $lookup: {
        from: "attachments",
        localField: "attachments",
        foreignField: "_id",
        as: "attachments",
        pipeline: [
          {
            $project: {
              url: 1,
              thumbnailUrl: 1,
              mimeType: 1,
              originalName: 1,
              size: 1,
              width: 1,
              height: 1,
              duration: 1,
            },
          },
        ],
      },
    },

    // Hydrate reply-to preview
    {
      $lookup: {
        from: "messages",
        localField: "replyTo",
        foreignField: "_id",
        as: "replyToMessage",
        pipeline: [
          { $project: { text: 1, type: 1, "sender.name": 1, createdAt: 1 } },
        ],
      },
    },
    { $unwind: { path: "$replyToMessage", preserveNullAndEmptyArrays: true } },

    {
      $project: {
        conversationId: 1,
        platform: 1,
        direction: 1,
        sender: 1,
        type: 1,
        text: 1,
        attachments: 1,
        replyToMessage: 1,
        status: 1,
        reactions: 1,
        location: 1,
        template: 1,
        aiIntent: 1,
        aiSentiment: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Unread badges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Total unread count per platform for use in the navigation badge.
 *
 * @param {string} [agentId]   When provided, only counts conversations
 *                             assigned to this agent or unassigned.
 * @returns {Promise<Array<{_id: string, totalUnread: number, conversationCount: number}>>}
 */
async function getUnreadBadges(agentId) {
  const match = {
    status: "open",
    deletedAt: null,
    unreadCount: { $gt: 0 },
  };

  if (agentId) {
    match.$or = [{ assignedTo: toId(agentId) }, { assignedTo: null }];
  }

  return Conversation.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$platform",
        totalUnread: { $sum: "$unreadCount" },
        conversationCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All conversations for a contact across all platforms.
 * Used on the contact detail / side panel.
 *
 * @param {string} contactId
 * @returns {Promise<object[]>}
 */
async function getContactConversationHistory(contactId) {
  return Conversation.aggregate([
    {
      $match: {
        contactId: toId(contactId),
        deletedAt: null,
      },
    },
    { $sort: { "lastMessage.sentAt": -1 } },
    {
      $project: {
        platform: 1,
        status: 1,
        lastMessage: 1,
        messageCount: 1,
        classification: 1,
        tags: 1,
        assignedTo: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message volume by day, broken down by platform and direction.
 * Powers the line chart on the admin dashboard.
 *
 * @param {object} opts
 * @param {string}  opts.startDate  ISO date string
 * @param {string}  opts.endDate    ISO date string
 * @param {string}  [opts.platform]
 * @returns {Promise<Array<{_id: {date, platform, direction}, count: number}>>}
 */
async function getMessageVolumeByDay({ startDate, endDate, platform } = {}) {
  const match = {
    createdAt: {
      $gte: new Date(startDate),
      $lte: new Date(endDate),
    },
  };
  if (platform) match.platform = platform;

  return Message.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          platform: "$platform",
          direction: "$direction",
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.date": 1, "_id.platform": 1 } },
  ]);
}

/**
 * Conversation status distribution (open / resolved / pending …) per platform.
 *
 * @param {string} [channelId]
 * @returns {Promise<Array<{_id: {platform, status}, count: number}>>}
 */
async function getStatusDistribution(channelId) {
  const match = { deletedAt: null };
  if (channelId) match.channelId = toId(channelId);

  return Conversation.aggregate([
    { $match: match },
    {
      $group: {
        _id: { platform: "$platform", status: "$status" },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.platform": 1, "_id.status": 1 } },
  ]);
}

/**
 * Average first-response time (time between conversation creation and first
 * outbound message) per platform.
 *
 * @param {object} opts
 * @param {string}  opts.startDate
 * @param {string}  opts.endDate
 * @returns {Promise<Array<{_id: string, avgResponseTimeMs: number}>>}
 */
async function getAvgFirstResponseTime({ startDate, endDate } = {}) {
  return Message.aggregate([
    {
      $match: {
        direction: "outbound",
        createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
      },
    },
    // For each conversation, grab the first outbound message timestamp
    {
      $group: {
        _id: "$conversationId",
        platform: { $first: "$platform" },
        firstOutboundAt: { $min: "$createdAt" },
      },
    },
    // Join the conversation to get its createdAt
    {
      $lookup: {
        from: "conversations",
        localField: "_id",
        foreignField: "_id",
        as: "conv",
        pipeline: [{ $project: { createdAt: 1 } }],
      },
    },
    { $unwind: "$conv" },
    {
      $project: {
        platform: 1,
        responseTimeMs: {
          $subtract: ["$firstOutboundAt", "$conv.createdAt"],
        },
      },
    },
    {
      $group: {
        _id: "$platform",
        avgResponseTimeMs: { $avg: "$responseTimeMs" },
        sampledConversations: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-text search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search conversations by participant name (conversation-level text index).
 *
 * @param {object} opts
 * @param {string}  opts.query
 * @param {string}  [opts.platform]
 * @param {number}  [opts.limit=20]
 * @returns {Promise<object[]>}
 */
async function searchConversations({ query, platform, limit = 20 } = {}) {
  const match = {
    deletedAt: null,
    $text: { $search: query },
  };
  if (platform) match.platform = platform;

  return Conversation.aggregate([
    { $match: match },
    { $sort: { score: { $meta: "textScore" }, "lastMessage.sentAt": -1 } },
    { $limit: limit },
    {
      $project: {
        platform: 1,
        participantName: 1,
        participantAvatar: 1,
        lastMessage: 1,
        unreadCount: 1,
        status: 1,
        score: { $meta: "textScore" },
      },
    },
  ]);
}

/**
 * Search message bodies within a specific conversation.
 *
 * @param {object} opts
 * @param {string}  opts.conversationId
 * @param {string}  opts.query
 * @param {number}  [opts.limit=30]
 * @returns {Promise<object[]>}
 */
async function searchMessages({ conversationId, query, limit = 30 } = {}) {
  return Message.aggregate([
    {
      $match: {
        conversationId: toId(conversationId),
        deletedAt: null,
        $text: { $search: query },
      },
    },
    { $sort: { score: { $meta: "textScore" }, createdAt: -1 } },
    { $limit: limit },
    {
      $project: {
        text: 1,
        type: 1,
        direction: 1,
        sender: 1,
        createdAt: 1,
        score: { $meta: "textScore" },
      },
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getInboxList,
  getMessages,
  getUnreadBadges,
  getContactConversationHistory,
  getMessageVolumeByDay,
  getStatusDistribution,
  getAvgFirstResponseTime,
  searchConversations,
  searchMessages,
};
