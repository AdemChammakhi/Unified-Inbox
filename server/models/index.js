/**
 * index.js — barrel export for all Mongoose models.
 *
 * Import from here instead of individual files so refactors only touch one place:
 *   const { Conversation, Message, Contact } = require("../models");
 */

module.exports = {
  Attachment: require("./Attachment"),
  Channel: require("./Channel"),
  Classification: require("./Classification"),
  Contact: require("./Contact"),
  Conversation: require("./Conversation"),
  ConversationLock: require("./ConversationLock"),
  Message: require("./Message"),
  User: require("./User"),
};
