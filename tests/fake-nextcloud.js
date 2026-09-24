/*
 * Minimal in-process Nextcloud (Talk + provisioning) for unit tests.
 * Supports fault injection: fail(method, pathRegex, {status, times, lostResponse}).
 */
const http = require("http");

const ok = (res, data, status = 200, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: status }, data } }));
};
const err = (res, status, message = "error") => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ocs: { meta: { status: "failure", statuscode: status, message }, data: [] } }));
};

class FakeNextcloud {
  constructor({ bot = "bot" } = {}) {
    this.bot = bot;
    this.users = {};
    this.groups = {};
    this.rooms = {};
    this.messages = {}; // token -> [msg]
    this.readMarker = {}; // token -> id
    this.threadNotify = {};
    this.nextId = 1000;
    this.faults = [];
    this.requests = [];
    this.now = 1700000000;
  }

  addUser(id, displayname, email, groups = [], enabled = true) {
    this.users[id] = { id, displayname, email, groups, enabled };
    for (const g of groups) (this.groups[g] ||= { id: g, displayname: g, members: [] }).members.push(id);
  }
  addRoom({ token, name, displayName, type = 2, members = [this.bot], listable = 0, participantsGroups = [] }) {
    this.rooms[token] = { token, name: name || displayName, displayName: displayName || name, type, members, listable, participantsGroups, lastActivity: this.now };
    this.messages[token] ||= [];
    return this.rooms[token];
  }
  incoming(token, actorId, text, extra = {}) {
    return this._store(token, actorId, { message: text, ...extra });
  }
  fail(method, pathRe, { status = 503, times = 1, lostResponse = false } = {}) {
    this.faults.push({ method, pathRe, status, times, lostResponse });
  }

  _store(token, actorId, body) {
    const id = ++this.nextId;
    this.now++;
    const room = this.rooms[token];
    room.lastActivity = this.now;
    const m = {
      id,
      token,
      actorType: "users",
      actorId,
      actorDisplayName: this.users[actorId]?.displayname || actorId,
      timestamp: this.now,
      message: body.message,
      messageParameters: {},
      messageType: body.messageType || "comment",
      systemMessage: body.systemMessage || "",
      referenceId: body.referenceId || "",
      reactions: {},
      markdown: true,
      isReplyable: true,
      threadId: id,
    };
    if (body.threadTitle) Object.assign(m, { isThread: true, threadId: id, threadTitle: body.threadTitle });
    else if (body.threadId) {
      const root = this.messages[token].find((x) => x.id === +body.threadId);
      Object.assign(m, { isThread: true, threadId: +body.threadId, threadTitle: root?.threadTitle });
    }
    if (body.replyTo) m.parent = this.messages[token].find((x) => x.id === +body.replyTo);
    this.messages[token].push(m);
    if (actorId === this.bot) this.readMarker[token] = id; // Talk moves the sender's marker
    return m;
  }

  _roomOut(r) {
    const msgs = this.messages[r.token];
    const member = r.members.includes(this.bot);
    return {
      token: r.token,
      name: r.name,
      displayName: r.displayName,
      type: r.type,
      listable: r.listable,
      participantType: member ? 3 : 4,
      attendeeId: member ? 1 : undefined,
      lastActivity: r.lastActivity,
      lastReadMessage: this.readMarker[r.token] || 0,
      lastMessage: msgs.length ? msgs[msgs.length - 1] : undefined,
      unreadMessages: msgs.filter((m) => m.id > (this.readMarker[r.token] || 0)).length,
    };
  }

  _thread(token, id) {
    const root = this.messages[token].find((m) => m.id === id && m.isThread);
    if (!root) return null;
    const all = this.messages[token].filter((m) => m.threadId === id && m.isThread);
    return {
      thread: { id, roomToken: token, title: root.threadTitle, lastMessageId: all[all.length - 1].id, lastActivity: this.now, numReplies: all.length - 1 },
      attendee: { notificationLevel: this.threadNotify[`${token}:${id}`] || 0 },
      first: root,
      last: all[all.length - 1],
    };
  }

  handle(req, res, body) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/^\/ocs\/v2\.php/, "");
    const q = Object.fromEntries(url.searchParams.entries());
    this.requests.push(`${req.method} ${p}`);

    const f = this.faults.find((x) => x.times > 0 && x.method === req.method && x.pathRe.test(p));
    if (f) {
      f.times--;
      if (f.lostResponse) {
        // the server did the work, but the answer never arrives
        this._route(req, p, q, body, { writeHead() {}, end() {} });
        req.socket.destroy();
        return;
      }
      return err(res, f.status, "injected fault");
    }
    this._route(req, p, q, body, res);
  }

  _route(req, p, q, body, res) {
    let m;
    const M = req.method;
    if (M === "GET" && p === "/cloud/capabilities")
      return ok(res, {
        version: { string: "34.0.2" },
        capabilities: { spreed: { version: "24.0.4", features: ["threads", "chat-reference-id", "reactions", "edit-messages", "delete-messages", "markdown-messages"], config: { chat: { "max-length": 200 } } } },
      });
    if (M === "GET" && p === "/cloud/users/details") {
      const all = Object.values(this.users);
      const off = +q.offset || 0;
      const lim = +q.limit || 1000;
      return ok(res, { users: Object.fromEntries(all.slice(off, off + lim).map((u) => [u.id, u])) });
    }
    if (M === "GET" && (m = p.match(/^\/cloud\/users\/([^/]+)$/))) {
      const u = this.users[decodeURIComponent(m[1])];
      return u ? ok(res, u) : err(res, 404, "user not found");
    }
    if (M === "GET" && p === "/cloud/groups/details") {
      if (+q.limit >= 1000) return err(res, 500, "LDAP size limit"); // like grandmaster
      const all = Object.values(this.groups).map((g) => ({ id: g.id, displayname: g.displayname, usercount: g.members.length }));
      const off = +q.offset || 0;
      return ok(res, { groups: all.slice(off, off + (+q.limit || 1000)) });
    }
    if (M === "GET" && (m = p.match(/^\/cloud\/groups\/([^/]+)\/users$/))) {
      const g = this.groups[decodeURIComponent(m[1])];
      return g ? ok(res, { users: g.members }) : err(res, 404);
    }
    const R = "/apps/spreed/api/v4";
    const C = "/apps/spreed/api/v1";
    if (M === "GET" && p === `${R}/room`) {
      const since = +q.modifiedSince || 0;
      const rooms = Object.values(this.rooms).filter((r) => r.members.includes(this.bot) && r.lastActivity > since);
      return ok(res, rooms.map((r) => this._roomOut(r)), 200, { "X-Nextcloud-Talk-Modified-Before": String(this.now) });
    }
    if (M === "GET" && p === `${R}/listed-room`)
      return ok(res, Object.values(this.rooms).filter((r) => r.listable && !r.members.includes(this.bot)).map((r) => this._roomOut(r)));
    if (M === "POST" && p === `${R}/room`) {
      if (body.roomType === 1) {
        if (!this.users[body.invite]) return err(res, 404, "user not found");
        const existing = Object.values(this.rooms).find((r) => r.type === 1 && r.name === body.invite);
        if (existing) return ok(res, this._roomOut(existing), 200);
        const r = this.addRoom({ token: "dm" + body.invite.replace(/\W/g, ""), name: body.invite, displayName: this.users[body.invite].displayname, type: 1, members: [this.bot, body.invite] });
        return ok(res, this._roomOut(r), 201);
      }
      return err(res, 400);
    }
    if ((m = p.match(new RegExp(`^${R}/room/([^/]+)(/.*)?$`)))) {
      const r = this.rooms[m[1]];
      const sub = m[2] || "";
      if (!r) return err(res, 404, "room not found");
      if (sub === "/participants/active" && M === "POST") {
        if (!r.listable) return err(res, 404);
        if (!r.members.includes(this.bot)) r.members.push(this.bot);
        return ok(res, this._roomOut(r));
      }
      if (sub === "/participants/active" && M === "DELETE") return ok(res, []);
      if (!r.members.includes(this.bot)) return err(res, 404, "not a participant");
      if (sub === "" && M === "GET") return ok(res, this._roomOut(r));
      if (sub === "/participants" && M === "GET")
        return ok(res, [
          ...r.members.map((u) => ({ actorType: "users", actorId: u, displayName: this.users[u]?.displayname || u, participantType: 3 })),
          ...r.participantsGroups.map((g) => ({ actorType: "groups", actorId: g, displayName: g, participantType: 3 })),
        ]);
    }
    if ((m = p.match(new RegExp(`^${C}/chat/([^/]+)(/.*)?$`)))) {
      const token = m[1];
      const sub = m[2] || "";
      const r = this.rooms[token];
      if (!r || !r.members.includes(this.bot)) return err(res, 404, "room not found");
      const msgs = this.messages[token];
      if (sub === "" && M === "POST") {
        if (!body.message) return err(res, 400);
        return ok(res, this._store(token, this.bot, body), 201);
      }
      if (sub === "" && M === "GET") {
        const limit = +q.limit || 100;
        let out;
        if (q.lookIntoFuture === "1") out = msgs.filter((x) => x.id > (+q.lastKnownMessageId || 0)).slice(0, limit);
        else out = msgs.filter((x) => !q.lastKnownMessageId || x.id < +q.lastKnownMessageId).slice(-limit).reverse();
        if (q.threadId) out = out.filter((x) => x.threadId === +q.threadId && x.isThread);
        if (!out.length) {
          res.writeHead(304);
          return res.end();
        }
        return ok(res, out, 200, { "X-Chat-Last-Given": String(out[out.length - 1].id) });
      }
      if (sub === "/read" && M === "POST") {
        this.readMarker[token] = +body.lastReadMessage;
        return ok(res, this._roomOut(r));
      }
      if (sub === "/threads/recent" && M === "GET")
        return ok(res, msgs.filter((x) => x.isThread && x.threadId === x.id).map((x) => this._thread(token, x.id)));
      let t;
      if ((t = sub.match(/^\/threads\/(\d+)$/))) {
        const th = this._thread(token, +t[1]);
        if (!th) return err(res, 404);
        if (M === "PUT") {
          msgs.filter((x) => x.threadId === +t[1] && x.isThread).forEach((x) => (x.threadTitle = body.threadTitle));
          return ok(res, this._thread(token, +t[1]));
        }
        return ok(res, th);
      }
      if ((t = sub.match(/^\/threads\/(\d+)\/notify$/)) && M === "POST") {
        this.threadNotify[`${token}:${t[1]}`] = body.level;
        return ok(res, this._thread(token, +t[1]));
      }
    }
    if ((m = p.match(new RegExp(`^${C}/reaction/([^/]+)/(\\d+)$`))) && M === "POST") {
      const msg = this.messages[m[1]]?.find((x) => x.id === +m[2]);
      if (!msg) return err(res, 404);
      msg.reactions[body.reaction] = (msg.reactions[body.reaction] || 0) + 1;
      return ok(res, { [body.reaction]: [{ actorId: this.bot }] }, 201);
    }
    return err(res, 404, `fake: no route for ${M} ${p}`);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        let body = {};
        try {
          body = data ? JSON.parse(data) : {};
        } catch (e) {}
        this.handle(req, res, body);
      });
    });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.host = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }
}

// standard fixture used by most tests
const standardFake = async () => {
  const f = new FakeNextcloud({ bot: "bot" });
  f.addUser("bot", "Bot", "bot@example.com");
  f.addUser("patrick.pasch", "Patrick Pasch", "pp@example.com", ["FuE"]);
  f.addUser("anna.mueller", "Anna Müller", "anna@example.com", ["FuE", "DataSec"]);
  f.addUser("jens", "Jens Ohne Mail", "", ["FuE"]);
  f.addUser("old.user", "Old User", "old@example.com", [], false);
  f.addRoom({ token: "fueroom1", displayName: "FuE", members: ["bot", "patrick.pasch", "anna.mueller"] });
  f.addRoom({ token: "privroom", displayName: "DataSec / FuE", members: ["patrick.pasch"] });
  f.addRoom({ token: "openroom", displayName: "Automatisierung", members: ["anna.mueller"], listable: 1 });
  f.addRoom({ token: "grproom1", displayName: "Kunde MüllerHolz", members: ["bot"], participantsGroups: ["DataSec"] });
  return await f.start();
};

module.exports = { FakeNextcloud, standardFake };
