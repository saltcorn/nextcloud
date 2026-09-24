/*
 * Nextcloud Talk operations on top of NextcloudClient.
 * All functions take the client as first argument and are stateless.
 */
const crypto = require("crypto");
const { TalkError } = require("./client");

const ROOM = "/ocs/v2.php/apps/spreed/api/v4";
const CHAT = "/ocs/v2.php/apps/spreed/api/v1";

const ROOM_TYPES = {
  1: "one_to_one",
  2: "group",
  3: "public",
  4: "changelog",
  5: "former_one_to_one",
  6: "note_to_self",
};

const enc = encodeURIComponent;

// ---------- normalisation ----------

// Replace rich object placeholders like {mention-user1} with readable text
const renderMessageText = (m) => {
  const params = m.messageParameters || {};
  return String(m.message || "").replace(/\{([a-z0-9-]+)\}/gi, (all, key) => {
    const p = params[key];
    if (!p) return all;
    if (p.type === "user" || p.type === "guest" || p.type === "call")
      return "@" + (p.name || p.id);
    if (p.type === "user-group" || p.type === "group")
      return "@" + (p.name || p.id);
    return p.name || p.id || all;
  });
};

const normalizeRoom = (r) =>
  r && {
    token: r.token,
    name: r.name,
    displayName: r.displayName,
    type: ROOM_TYPES[r.type] || String(r.type),
    typeId: r.type,
    description: r.description || "",
    readOnly: !!r.readOnly,
    listable: r.listable,
    isParticipant: r.participantType !== undefined && r.participantType !== 4
      ? true
      : !!r.attendeeId,
    unreadMessages: r.unreadMessages || 0,
    unreadMention: !!r.unreadMention,
    lastActivity: r.lastActivity,
    lastReadMessage: r.lastReadMessage,
    lastMessageId: r.lastMessage?.id,
    raw: r,
  };

const normalizeMessage = (m) =>
  m && {
    id: m.id,
    token: m.token,
    // Talk sets threadId to the own id on every message; only isThread marks thread membership
    threadId: m.isThread ? m.threadId || null : null,
    isThreadRoot: !!m.isThread && m.threadId === m.id,
    threadTitle: m.threadTitle || null,
    authorType: m.actorType,
    authorId: m.actorId,
    authorName: m.actorDisplayName,
    text: renderMessageText(m),
    rawText: m.message,
    timestamp: m.timestamp,
    date: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
    messageType: m.messageType,
    systemMessage: m.systemMessage || "",
    replyTo: m.parent?.id || null,
    referenceId: m.referenceId || "",
    reactions: m.reactions || {},
    silent: !!m.silent,
    edited: !!m.lastEditTimestamp,
    deleted: m.messageType === "comment_deleted" || !!m.deleted,
    raw: m,
  };

// ---------- rooms ----------

const listRooms = async (c, { modifiedSince } = {}) => {
  const { data, headers } = await c.get(`${ROOM}/room`, {
    query: {
      noStatusUpdate: 1,
      modifiedSince: modifiedSince || undefined,
    },
  });
  return {
    rooms: (data || []).map(normalizeRoom),
    modifiedBefore: +headers["x-nextcloud-talk-modified-before"] || null,
  };
};

const listListedRooms = async (c, searchTerm) => {
  const { data } = await c.get(`${ROOM}/listed-room`, {
    query: { searchTerm: searchTerm || undefined },
  });
  return (data || []).map((r) => ({ ...normalizeRoom(r), isParticipant: false }));
};

const getRoom = async (c, token) => {
  const { data } = await c.get(`${ROOM}/room/${enc(token)}`);
  return normalizeRoom(data);
};

// Returns the existing 1:1 room with this user or creates it.
const openDirect = async (c, userId) => {
  if (!userId) throw new TalkError("bad_request", "No user id given");
  if (userId.toLowerCase() === String(c.user).toLowerCase())
    return await noteToSelf(c);
  const { data, status } = await c.post(`${ROOM}/room`, {
    roomType: 1,
    invite: userId,
  });
  return { ...normalizeRoom(data), created: status === 201 };
};

const noteToSelf = async (c) => {
  const { data } = await c.get(`${ROOM}/room/note-to-self`);
  return normalizeRoom(data);
};

const createGroupRoom = async (c, { name, users = [], groups = [], description }) => {
  const participants = {};
  if (users.length) participants.users = users;
  if (groups.length) participants.groups = groups;
  const { data } = await c.post(`${ROOM}/room`, {
    roomType: 2,
    roomName: name,
    participants,
    description: description || undefined,
  });
  return { ...normalizeRoom(data), created: true };
};

// Join a listable (open) conversation permanently as participant
const joinListedRoom = async (c, token) => {
  await c.post(`${ROOM}/room/${enc(token)}/participants/active`, {
    force: true,
  });
  // leave the session again; the attendee entry stays
  try {
    await c.del(`${ROOM}/room/${enc(token)}/participants/active`);
  } catch (e) {}
  return await getRoom(c, token);
};

const getParticipants = async (c, token) => {
  const { data } = await c.get(`${ROOM}/room/${enc(token)}/participants`, {
    query: { includeStatus: 0 },
  });
  return (data || []).map((p) => ({
    type: p.actorType,
    id: p.actorId,
    name: p.displayName,
    participantType: p.participantType,
  }));
};

// ---------- messages ----------

const newReferenceId = () => crypto.randomBytes(32).toString("hex");

const sendMessage = async (
  c,
  token,
  text,
  { replyTo, threadId, threadTitle, silent, referenceId } = {},
) => {
  const body = { message: String(text ?? "") };
  if (!body.message.trim())
    throw new TalkError("bad_request", "Message text is empty");
  if (replyTo) body.replyTo = +replyTo;
  else if (threadTitle) {
    if (!(await c.hasFeature("threads")))
      throw new TalkError("unsupported", "This Talk server has no threads support");
    body.threadTitle = String(threadTitle).slice(0, 255);
  }
  if (threadId && !replyTo) body.threadId = +threadId;
  if (silent) body.silent = true;
  body.referenceId = referenceId || newReferenceId();
  const { data } = await c.post(`${CHAT}/chat/${enc(token)}`, body);
  return normalizeMessage(data);
};

// Newest-first history (lookIntoFuture=0) or messages after an id (lookIntoFuture=1, no wait)
const getMessages = async (
  c,
  token,
  { after, before, limit = 50, threadId, includeSystem = false } = {},
) => {
  const future = after !== undefined && after !== null;
  const { data, headers, status } = await c.get(`${CHAT}/chat/${enc(token)}`, {
    query: {
      lookIntoFuture: future ? 1 : 0,
      lastKnownMessageId: future ? after : before || undefined,
      limit: Math.min(+limit || 50, 200),
      timeout: future ? 0 : undefined,
      setReadMarker: 0,
      markNotificationsAsRead: 0,
      noStatusUpdate: 1,
      threadId: threadId || undefined,
    },
  });
  if (status === 304 || !data) return { messages: [], lastGiven: null };
  let messages = data.map(normalizeMessage);
  if (!includeSystem)
    messages = messages.filter((m) => m.messageType !== "system");
  messages.sort((a, b) => a.id - b.id);
  return { messages, lastGiven: +headers["x-chat-last-given"] || null };
};

const findByReferenceId = async (c, token, referenceId, { lookback = 50 } = {}) => {
  const { messages } = await getMessages(c, token, { limit: lookback, includeSystem: true });
  return messages.find((m) => m.referenceId === referenceId) || null;
};

const markRead = async (c, token, messageId) => {
  await c.post(`${CHAT}/chat/${enc(token)}/read`, {
    lastReadMessage: messageId ? +messageId : undefined,
  });
};

const editMessage = async (c, token, messageId, text) => {
  const { data } = await c.put(`${CHAT}/chat/${enc(token)}/${+messageId}`, {
    message: String(text),
  });
  return normalizeMessage(data);
};

const deleteMessage = async (c, token, messageId) => {
  const { data } = await c.del(`${CHAT}/chat/${enc(token)}/${+messageId}`);
  return normalizeMessage(data);
};

const react = async (c, token, messageId, reaction) => {
  const { data } = await c.post(`${CHAT}/reaction/${enc(token)}/${+messageId}`, {
    reaction,
  });
  return data;
};

const getReactions = async (c, token, messageId) => {
  const { data } = await c.get(`${CHAT}/reaction/${enc(token)}/${+messageId}`);
  return data || {};
};

// ---------- threads ----------

const normalizeThread = (t) =>
  t && {
    id: t.thread.id,
    token: t.thread.roomToken,
    title: t.thread.title,
    replies: t.thread.numReplies,
    lastActivity: t.thread.lastActivity,
    lastMessageId: t.thread.lastMessageId,
    notificationLevel: t.attendee?.notificationLevel,
    first: t.first ? normalizeMessage(t.first) : null,
    last: t.last ? normalizeMessage(t.last) : null,
  };

const listThreads = async (c, token, { limit = 50 } = {}) => {
  const { data } = await c.get(`${CHAT}/chat/${enc(token)}/threads/recent`, {
    query: { limit },
  });
  return (data || []).map(normalizeThread);
};

const getThread = async (c, token, threadId) => {
  const { data } = await c.get(`${CHAT}/chat/${enc(token)}/threads/${+threadId}`);
  return normalizeThread(data);
};

const renameThread = async (c, token, threadId, title) => {
  const { data } = await c.put(`${CHAT}/chat/${enc(token)}/threads/${+threadId}`, {
    threadTitle: String(title).slice(0, 255),
  });
  return normalizeThread(data);
};

// level: 0 default, 1 always, 2 mention, 3 never
const setThreadNotification = async (c, token, threadId, level) => {
  const { data } = await c.post(
    `${CHAT}/chat/${enc(token)}/threads/${+threadId}/notify`,
    { level: +level },
  );
  return normalizeThread(data);
};

const createThread = async (c, token, title, text, opts = {}) => {
  const msg = await sendMessage(c, token, text, { ...opts, threadTitle: title });
  return { threadId: msg.threadId || msg.id, message: msg };
};

// Talk has no "closed" state for threads. We mark closure in the title,
// which is the single source of truth and needs no local storage.
const DEFAULT_CLOSED_PREFIX = "✅ ";

const isClosedTitle = (title, prefix = DEFAULT_CLOSED_PREFIX) =>
  String(title || "").startsWith(prefix.trim());

const stripClosed = (title, prefix = DEFAULT_CLOSED_PREFIX) =>
  isClosedTitle(title, prefix)
    ? String(title).slice(prefix.trim().length).trimStart()
    : String(title);

const closeThread = async (
  c,
  token,
  threadId,
  { message, prefix = DEFAULT_CLOSED_PREFIX, mute = true } = {},
) => {
  const t = await getThread(c, token, threadId);
  if (isClosedTitle(t.title, prefix)) return { ...t, alreadyClosed: true };
  if (message) await sendMessage(c, token, message, { threadId });
  const renamed = await renameThread(c, token, threadId, prefix + stripClosed(t.title, prefix));
  if (mute) {
    try {
      await setThreadNotification(c, token, threadId, 3);
    } catch (e) {}
  }
  return { ...renamed, alreadyClosed: false };
};

const reopenThread = async (
  c,
  token,
  threadId,
  { message, prefix = DEFAULT_CLOSED_PREFIX } = {},
) => {
  const t = await getThread(c, token, threadId);
  if (!isClosedTitle(t.title, prefix)) return { ...t, wasOpen: true };
  const renamed = await renameThread(c, token, threadId, stripClosed(t.title, prefix));
  try {
    await setThreadNotification(c, token, threadId, 0);
  } catch (e) {}
  if (message) await sendMessage(c, token, message, { threadId });
  return { ...renamed, wasOpen: false };
};

module.exports = {
  ROOM_TYPES,
  renderMessageText,
  normalizeRoom,
  normalizeMessage,
  listRooms,
  listListedRooms,
  getRoom,
  openDirect,
  noteToSelf,
  createGroupRoom,
  joinListedRoom,
  getParticipants,
  newReferenceId,
  sendMessage,
  getMessages,
  findByReferenceId,
  markRead,
  editMessage,
  deleteMessage,
  react,
  getReactions,
  listThreads,
  getThread,
  renameThread,
  setThreadNotification,
  createThread,
  isClosedTitle,
  closeThread,
  reopenThread,
  DEFAULT_CLOSED_PREFIX,
};
