/*
 * Directory of users, groups and conversations with exact and fuzzy search,
 * plus strict recipient resolution for sending.
 */
const { TalkError } = require("./client");
const talk = require("./talk");

const PROV = "/ocs/v2.php/cloud";
const enc = encodeURIComponent;

// ---------- text helpers ----------

const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9@]+/g, " ")
    .trim();

const trigrams = (s) => {
  const t = new Set();
  const p = `  ${s} `;
  for (let i = 0; i < p.length - 2; i++) t.add(p.slice(i, i + 3));
  return t;
};

const trigramSimilarity = (a, b) => {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};

// Damerau-Levenshtein (optimal string alignment), bounded for short tokens
const editDistance = (a, b) => {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[m][n];
};

// Score 0..1 of how well query q matches one candidate string s
const scoreString = (q, s, fuzzy) => {
  const fq = fold(q);
  const fs = fold(s);
  if (!fq || !fs) return 0;
  if (fq === fs) return 1;
  if (fs.startsWith(fq)) return 0.9;
  const words = fs.split(" ");
  if (words.some((w) => w.startsWith(fq))) return 0.85;
  if (fs.includes(fq)) return 0.75;
  const cq = fq.replace(/ /g, "");
  const cs = fs.replace(/ /g, "");
  if (cq.length > 3 && cs.includes(cq)) return 0.7;
  const qwords = fq.split(" ");
  if (qwords.length > 1 && qwords.every((qw) => words.some((w) => w.startsWith(qw))))
    return 0.8;
  if (!fuzzy) return 0;
  // every query word close to some candidate word
  const perWord = qwords.map((qw) => {
    let best = 0;
    for (const w of words) {
      const dist = editDistance(qw, w.slice(0, Math.max(qw.length, w.length)));
      const allowed = qw.length <= 4 ? 1 : qw.length <= 8 ? 2 : 3;
      if (dist <= allowed) best = Math.max(best, 0.7 - dist * 0.1);
      else if (w.startsWith(qw.slice(0, -1)) && qw.length > 3) best = Math.max(best, 0.55);
    }
    return best;
  });
  const wordScore = perWord.every((x) => x > 0)
    ? perWord.reduce((a, b) => a + b, 0) / perWord.length
    : 0;
  const tri = trigramSimilarity(fq, fs) * 0.7;
  return Math.max(wordScore, tri);
};

// ---------- directory ----------

class Directory {
  constructor(client, { ttl = 10 * 60 * 1000, log } = {}) {
    this.c = client;
    this.ttl = ttl;
    this.log = log || (() => {});
    this.cache = {};
  }

  async _cached(key, loader, force) {
    const e = this.cache[key];
    const age = e ? Date.now() - e.at : Infinity;
    // forced reloads are rate limited so unknown recipients cannot hammer the server
    if (e && (force ? age < 30 * 1000 : age < this.ttl)) return e.value;
    try {
      const value = await loader();
      this.cache[key] = { value, at: Date.now() };
      return value;
    } catch (err) {
      // serve stale data rather than failing, but never hide auth errors
      if (e && err.code !== "auth" && err.code !== "auth_blocked") {
        this.log(`directory: using stale ${key}: ${err.message}`);
        return e.value;
      }
      throw err;
    }
  }

  invalidate(key) {
    if (key) delete this.cache[key];
    else this.cache = {};
  }

  // All users (needs admin or subadmin rights). Falls back to [] + flag if forbidden.
  async users(force) {
    return await this._cached(
      "users",
      async () => {
        const out = [];
        const limit = 200;
        for (let offset = 0; ; offset += limit) {
          const { data } = await this.c.get(`${PROV}/users/details`, {
            query: { limit, offset },
          });
          const list = Object.values(data?.users || {}).filter(
            (u) => u && typeof u === "object" && u.id,
          );
          for (const u of list)
            out.push({
              kind: "user",
              id: u.id,
              label: u.displayname || u["display-name"] || u.id,
              email: u.email || "",
              groups: u.groups || [],
              enabled: u.enabled !== false,
            });
          if (list.length < limit) break;
        }
        return out;
      },
      force,
    );
  }

  async groups(force) {
    return await this._cached(
      "groups",
      async () => {
        // paged: some user backends (LDAP) answer 500 on large limits
        const page = async (path, map) => {
          const out = [];
          const limit = 200;
          for (let offset = 0; ; offset += limit) {
            const { data } = await this.c.get(`${PROV}/${path}`, { query: { limit, offset } });
            const list = data?.groups || [];
            out.push(...list.map(map));
            if (list.length < limit) break;
          }
          return out;
        };
        try {
          return await page("groups/details", (g) => ({
            kind: "group",
            id: g.id,
            label: g.displayname || g.id,
            userCount: g.usercount,
            disabled: g.disabled,
          }));
        } catch (e) {
          if (e.code !== "server") throw e;
          this.log(`directory: groups/details failed (${e.message}), using plain group list`);
          return await page("groups", (id) => ({ kind: "group", id, label: id }));
        }
      },
      force,
    );
  }

  async groupMembers(groupId) {
    const { data } = await this.c.get(`${PROV}/groups/${enc(groupId)}/users`);
    return data?.users || [];
  }

  async user(userId) {
    const all = await this.users().catch(() => null);
    const hit = all?.find((u) => u.id.toLowerCase() === String(userId).toLowerCase());
    if (hit) return hit;
    const { data } = await this.c.get(`${PROV}/users/${enc(userId)}`);
    return {
      kind: "user",
      id: data.id,
      label: data.displayname || data.id,
      email: data.email || "",
      groups: data.groups || [],
      enabled: data.enabled !== false,
    };
  }

  // Rooms the account is member of, plus open (listable) rooms it could join
  async rooms(force) {
    return await this._cached(
      "rooms",
      async () => {
        const { rooms } = await talk.listRooms(this.c);
        const joined = rooms.map((r) => ({ ...r, kind: "room", isParticipant: true }));
        let listed = [];
        try {
          const known = new Set(joined.map((r) => r.token));
          listed = (await talk.listListedRooms(this.c))
            .filter((r) => !known.has(r.token))
            .map((r) => ({ ...r, kind: "room", isParticipant: false }));
        } catch (e) {
          this.log(`directory: listed rooms unavailable: ${e.message}`);
        }
        return [...joined, ...listed].map((r) => ({
          ...r,
          id: r.token,
          label: r.displayName || r.name,
        }));
      },
      force,
    );
  }

  async all({ types = ["user", "group", "room"] } = {}) {
    const res = [];
    if (types.includes("user")) res.push(...(await this.users().catch(this._forbiddenEmpty("users"))));
    if (types.includes("group")) res.push(...(await this.groups().catch(this._forbiddenEmpty("groups"))));
    if (types.includes("room")) res.push(...(await this.rooms()));
    return res;
  }

  _forbiddenEmpty(what) {
    return (e) => {
      if (e.code === "forbidden") {
        this.log(`directory: no permission to list ${what} (needs admin or subadmin)`);
        return [];
      }
      throw e;
    };
  }

  // Search: exact + substring always, fuzzy optional. Returns sorted hits with score.
  async search(query, { types, fuzzy = true, limit = 20, minScore = 0.3, includeDisabled = false } = {}) {
    const q = String(query ?? "").trim();
    const entries = await this.all({ types });
    if (!q) return entries.slice(0, limit).map((e) => ({ ...e, score: 1 }));
    const hits = [];
    for (const e of entries) {
      if (e.kind === "user" && !e.enabled && !includeDisabled) continue;
      const fields = [e.id, e.label];
      if (e.kind === "user") fields.push(e.email, e.email?.split("@")[0]);
      if (e.kind === "room") fields.push(e.name);
      const score = Math.max(...fields.filter(Boolean).map((f) => scoreString(q, f, fuzzy)));
      if (score >= minScore) hits.push({ ...e, score: Math.round(score * 100) / 100 });
    }
    // members before non-members, then score
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        (b.isParticipant === true) - (a.isParticipant === true) ||
        String(a.label).localeCompare(String(b.label)),
    );
    return hits.slice(0, limit);
  }

  /*
   * Strict resolution for sending. Never guesses: a recipient must match
   * exactly one entry by token, id, name, display name or e-mail
   * (case-insensitive). Supports prefixes "user:", "group:", "room:".
   * Returns { kind, entry } or throws TalkError not_found / ambiguous.
   */
  async resolve(recipient, { preferMembers = true } = {}) {
    let raw = String(recipient ?? "").trim();
    if (!raw) throw new TalkError("not_found", "Empty recipient");
    let forced = null;
    const m = raw.match(/^(user|group|room|token)\s*:\s*(.+)$/i);
    if (m) {
      forced = m[1].toLowerCase() === "token" ? "room" : m[1].toLowerCase();
      raw = m[2].trim();
    }
    const lc = raw.toLowerCase();
    const eq = (v) => v !== undefined && v !== null && String(v).toLowerCase() === lc;

    const tryKind = async (kind, force) => {
      let list;
      if (kind === "room") list = await this.rooms(force);
      else if (kind === "user") list = await this.users(force).catch(this._forbiddenEmpty("users"));
      else list = await this.groups(force).catch(this._forbiddenEmpty("groups"));
      let hits;
      if (kind === "room") {
        hits = list.filter((r) => r.token === raw);
        if (!hits.length) hits = list.filter((r) => eq(r.name) || eq(r.displayName));
        if (hits.length > 1 && preferMembers) {
          const members = hits.filter((r) => r.isParticipant);
          if (members.length) hits = members;
        }
      } else if (kind === "user") {
        hits = list.filter((u) => eq(u.id));
        if (!hits.length) hits = list.filter((u) => eq(u.email));
        if (!hits.length) hits = list.filter((u) => eq(u.label));
      } else {
        hits = list.filter((g) => eq(g.id));
        if (!hits.length) hits = list.filter((g) => eq(g.label));
      }
      return hits;
    };

    const order = forced ? [forced] : ["room", "user", "group"];
    for (const force of [false, true]) {
      for (const kind of order) {
        const hits = await tryKind(kind, force);
        if (hits.length === 1) return { kind, entry: hits[0] };
        if (hits.length > 1)
          throw new TalkError(
            "ambiguous",
            `Recipient "${recipient}" is ambiguous: ${hits
              .map((h) => `${kind}:${h.id} (${h.label})`)
              .join(", ")}`,
            { details: hits.map((h) => ({ kind, id: h.id, label: h.label })) },
          );
      }
      // unknown user id may simply not be in cache yet: try provisioning API directly
      if (!force && (!forced || forced === "user")) {
        try {
          const u = await this.user(raw);
          if (u) return { kind: "user", entry: u };
        } catch (e) {
          if (e.code === "auth" || e.code === "auth_blocked") throw e;
        }
      }
    }
    // a bare token of a room we are not member of
    if (/^[a-z0-9]{8,}$/.test(raw) && (!forced || forced === "room")) {
      try {
        const r = await talk.getRoom(this.c, raw);
        if (r) return { kind: "room", entry: { ...r, id: r.token, label: r.displayName, isParticipant: true } };
      } catch (e) {
        if (e.code === "auth" || e.code === "auth_blocked") throw e;
      }
    }
    const suggestions = await this.search(raw, { limit: 5, minScore: 0.5 }).catch(() => []);
    throw new TalkError(
      "not_found",
      `Recipient "${recipient}" not found or not accessible for the Nextcloud account` +
        (suggestions.length
          ? `. Did you mean: ${suggestions.map((s) => `${s.kind}:${s.id} (${s.label})`).join(", ")}?`
          : ""),
      { details: { suggestions: suggestions.map((s) => ({ kind: s.kind, id: s.id, label: s.label })) } },
    );
  }

  // E-mail addresses for a resolved recipient (used by the fallback)
  async emailsFor({ kind, entry }) {
    try {
      if (kind === "user") {
        const u = entry.email !== undefined ? entry : await this.user(entry.id);
        return u.email ? [u.email] : [];
      }
      if (kind === "group") {
        const ids = await this.groupMembers(entry.id);
        return await this._emailsForUserIds(ids);
      }
      if (kind === "room") {
        if (entry.type === "one_to_one") return await this._emailsForUserIds([entry.name]);
        const parts = await talk.getParticipants(this.c, entry.token);
        const groups = parts.filter((p) => p.type === "groups").map((p) => p.id);
        const ids = parts.filter((p) => p.type === "users").map((p) => p.id);
        for (const g of groups) ids.push(...(await this.groupMembers(g).catch(() => [])));
        return await this._emailsForUserIds(ids);
      }
    } catch (e) {
      this.log(`directory: cannot determine e-mails: ${e.message}`);
    }
    return [];
  }

  async _emailsForUserIds(ids) {
    const self = String(this.c.user).toLowerCase();
    const uniq = [...new Set(ids.filter(Boolean).map(String))].filter(
      (id) => id.toLowerCase() !== self,
    );
    const users = await this.users().catch(() => []);
    const out = [];
    for (const id of uniq) {
      let u = users.find((x) => x.id === id);
      if (!u) u = await this.user(id).catch(() => null);
      if (u && u.enabled !== false && u.email) out.push(u.email);
    }
    return [...new Set(out)];
  }
}

module.exports = { Directory, fold, scoreString, trigramSimilarity, editDistance };
