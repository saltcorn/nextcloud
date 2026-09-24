/*
 * Polling listener without any server-side installation.
 *
 * - One cheap request per interval: room list with modifiedSince.
 * - Only changed rooms are fetched.
 * - Watermark = the account's read marker in Talk; it is advanced only after
 *   the event handler returned, so a crash/restart never loses messages
 *   (at-least-once, events carry the message id for de-duplication).
 * - Never dies: errors back off exponentially; auth errors pause until the
 *   configuration is saved again.
 */
const talk = require("./talk");

class Poller {
  constructor({ client, onMessage, shouldWatch, log, intervalMs = 5000, includeSystem = false }) {
    this.c = client;
    this.onMessage = onMessage; // async (message, room) => void
    this.shouldWatch = shouldWatch || (() => true); // (room) => bool
    this.log = log || (() => {});
    this.intervalMs = Math.max(2000, +intervalMs || 5000);
    this.includeSystem = includeSystem;
    this.running = false;
    this.timer = null;
    this.modifiedSince = 0;
    this.lastProcessed = {}; // token -> highest handled message id (in memory)
    this.failures = 0;
    this.status = { state: "stopped", lastPoll: null, lastError: null, events: 0 };
    this.fullRefreshEvery = 60; // cycles
    this.cycle = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.status.state = "running";
    this._schedule(0);
  }

  stop() {
    this.running = false;
    this.status.state = "stopped";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule(ms) {
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  async _tick() {
    if (!this.running) return;
    try {
      await this.pollOnce();
      this.failures = 0;
      this.status.lastError = null;
      this._schedule(this.intervalMs);
    } catch (e) {
      this.failures++;
      this.status.lastError = { code: e.code, message: e.message, at: new Date().toISOString() };
      const paused = e.code === "auth" || e.code === "auth_blocked";
      const delay = paused
        ? 10 * 60 * 1000
        : Math.min(5 * 60 * 1000, this.intervalMs * Math.pow(2, this.failures));
      this.log(`listener error (${e.code || "?"}): ${e.message}; retry in ${Math.round(delay / 1000)}s`);
      this._schedule(delay);
    }
  }

  async pollOnce() {
    this.cycle++;
    const full = this.cycle % this.fullRefreshEvery === 1;
    const { rooms, modifiedBefore } = await talk.listRooms(this.c, {
      modifiedSince: full ? undefined : this.modifiedSince,
    });
    this.status.lastPoll = new Date().toISOString();
    for (const room of rooms) {
      if (!this.running) return;
      if (!this.shouldWatch(room)) continue;
      const known = this.lastProcessed[room.token];
      const start = Math.max(room.lastReadMessage || 0, known || 0);
      if (!room.lastMessageId || room.lastMessageId <= start) {
        this.lastProcessed[room.token] = Math.max(start, room.lastMessageId || 0);
        continue;
      }
      await this._drainRoom(room, start);
    }
    if (modifiedBefore) this.modifiedSince = modifiedBefore;
  }

  async _drainRoom(room, after) {
    let cursor = after;
    for (let page = 0; page < 20; page++) {
      const { messages, lastGiven } = await talk.getMessages(this.c, room.token, {
        after: cursor,
        limit: 100,
        includeSystem: true,
      });
      if (!messages.length) break;
      for (const m of messages) {
        const own =
          m.authorType === "users" &&
          String(m.authorId).toLowerCase() === String(this.c.user).toLowerCase();
        const system = m.messageType === "system";
        if (!own && (!system || this.includeSystem) && !m.deleted) {
          // a failing handler must not block the room forever (poison message)
          try {
            await this.onMessage(m, room);
            this.status.events++;
          } catch (e) {
            this.log(`event handler failed for message ${m.id} in ${room.displayName}: ${e?.message || e}`);
          }
        }
        cursor = m.id;
        this.lastProcessed[room.token] = cursor;
      }
      try {
        await talk.markRead(this.c, room.token, cursor);
      } catch (e) {
        this.log(`could not set read marker in ${room.displayName}: ${e.message}`);
      }
      if (!lastGiven || messages.length < 100) break;
    }
  }
}

module.exports = { Poller };
