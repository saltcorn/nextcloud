/*
 * Chat adapter for tool-independent chat UIs (exchange key "chat_adapters").
 *
 * Contract (every chat tool adapter implements the same shape):
 *   id, label
 *   capabilities()                          -> { threads, reactions, edit, delete, directMessages, search, ... }
 *   listConversations({ query })            -> [Conversation]
 *   getConversation(id)                     -> Conversation
 *   openDirect(userId)                      -> Conversation
 *   findContacts(query, { fuzzy, types })   -> [Contact]
 *   getMessages(convId, { after, before, limit, threadId }) -> [Message]  (ascending by id)
 *   sendMessage(convId, text, { replyTo, threadId, threadTitle, silent }) -> Message
 *   editMessage(convId, msgId, text)        -> Message
 *   deleteMessage(convId, msgId)            -> Message
 *   react(convId, msgId, emoji)
 *   markRead(convId, msgId)
 *   listThreads(convId)                     -> [Thread]
 *   createThread(convId, title, text)       -> { threadId, message }
 *   closeThread(convId, threadId, { message }) / reopenThread(...)
 *   getParticipants(convId)                 -> [Contact]
 *   subscribe(handler)                      -> unsubscribe()   handler(Message, Conversation)
 *
 * Conversation: { id, name, type, unread, lastActivity, isMember }
 * Message:      { id, conversationId, threadId, author: {id, name, type}, text, date, replyTo, reactions, edited, deleted }
 * Contact:      { id, name, type: "user"|"group"|"conversation", email?, score? }
 */
const talk = require("./talk");

const conv = (r) =>
  r && {
    id: r.token,
    name: r.displayName || r.name,
    type: r.type,
    unread: r.unreadMessages || 0,
    lastActivity: r.lastActivity ? new Date(r.lastActivity * 1000).toISOString() : null,
    isMember: r.isParticipant !== false,
  };

const msg = (m) =>
  m && {
    id: m.id,
    conversationId: m.token,
    threadId: m.threadId,
    threadTitle: m.threadTitle,
    author: { id: m.authorId, name: m.authorName, type: m.authorType },
    text: m.text,
    date: m.date,
    replyTo: m.replyTo,
    reactions: m.reactions,
    edited: m.edited,
    deleted: m.deleted,
    system: m.messageType === "system",
  };

const contact = (e) => ({
  id: e.kind === "room" ? e.token : e.id,
  name: e.label,
  type: e.kind === "room" ? "conversation" : e.kind,
  email: e.email,
  score: e.score,
});

module.exports = (getCtx) => {
  const subscribers = new Set();
  const adapter = {
    id: "nextcloud-talk",
    label: "Nextcloud Talk",
    async capabilities() {
      const { client } = getCtx();
      const caps = await client.capabilities();
      return {
        threads: caps.features.has("threads"),
        reactions: caps.features.has("reactions"),
        edit: caps.features.has("edit-messages"),
        delete: caps.features.has("delete-messages"),
        directMessages: true,
        search: true,
        markdown: caps.features.has("markdown-messages"),
        maxLength: caps.config?.chat?.["max-length"] || 32000,
        realtime: "polling",
      };
    },
    async listConversations({ query } = {}) {
      const { directory } = getCtx();
      if (query) return (await directory.search(query, { types: ["room"] })).map(conv);
      return (await directory.rooms()).map(conv);
    },
    async getConversation(id) {
      return conv(await talk.getRoom(getCtx().client, id));
    },
    async openDirect(userId) {
      return conv(await talk.openDirect(getCtx().client, userId));
    },
    async findContacts(query, { fuzzy = true, types } = {}) {
      return (await getCtx().directory.search(query, { fuzzy, types })).map(contact);
    },
    async getMessages(id, opts = {}) {
      return (await talk.getMessages(getCtx().client, id, opts)).messages.map(msg);
    },
    async sendMessage(id, text, opts = {}) {
      return msg(await talk.sendMessage(getCtx().client, id, text, opts));
    },
    async editMessage(id, messageId, text) {
      return msg(await talk.editMessage(getCtx().client, id, messageId, text));
    },
    async deleteMessage(id, messageId) {
      return msg(await talk.deleteMessage(getCtx().client, id, messageId));
    },
    async react(id, messageId, emoji) {
      return await talk.react(getCtx().client, id, messageId, emoji);
    },
    async markRead(id, messageId) {
      return await talk.markRead(getCtx().client, id, messageId);
    },
    async listThreads(id) {
      return await talk.listThreads(getCtx().client, id);
    },
    async createThread(id, title, text) {
      const r = await talk.createThread(getCtx().client, id, title, text);
      return { threadId: r.threadId, message: msg(r.message) };
    },
    async closeThread(id, threadId, opts = {}) {
      const { client, cfg } = getCtx();
      return await talk.closeThread(client, id, threadId, { prefix: cfg.closed_prefix, ...opts });
    },
    async reopenThread(id, threadId, opts = {}) {
      const { client, cfg } = getCtx();
      return await talk.reopenThread(client, id, threadId, { prefix: cfg.closed_prefix, ...opts });
    },
    async getParticipants(id) {
      return (await talk.getParticipants(getCtx().client, id)).map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type === "users" ? "user" : p.type,
      }));
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    // called by the listener
    _dispatch(m, room) {
      for (const h of subscribers) {
        try {
          Promise.resolve(h(msg(m), conv(room))).catch(() => {});
        } catch (e) {}
      }
    },
  };
  return adapter;
};
