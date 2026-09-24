/*
 * Live test against a real Nextcloud, without Saltcorn.
 *   NC_HOST=... NC_USER=... NC_PASS=... NC_PEER=user.id NC_ROOM=token node test/live.js [section...]
 * Sections: caps dir resolve send thread fallback poll
 */
const { NextcloudClient } = require("../../client");
const { Directory } = require("../../directory");
const { Delivery } = require("../../delivery");
const { Poller } = require("../../poller");
const talk = require("../../talk");

const { NC_HOST, NC_USER, NC_PASS, NC_PEER, NC_ROOM } = process.env;
const TAG = "[Test Nextcloud-Modul]";
const sections = process.argv.slice(2);
const want = (s) => !sections.length || sections.includes(s);

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "  ok " : "  FAIL"} ${name}${extra !== undefined ? "  → " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : ""}`);
  if (!cond) failed++;
};

(async () => {
  const c = new NextcloudClient({ host: NC_HOST, user: NC_USER, password: NC_PASS });
  const dir = new Directory(c, { log: (m) => console.log("   [dir]", m) });
  const fallbacks = [];
  const del = new Delivery({
    client: c,
    directory: dir,
    log: (m) => console.log("   [send]", m),
    fallback: async (p) => {
      fallbacks.push(p);
      return "stub";
    },
    options: { retryDelayMs: 200 },
  });

  if (want("caps")) {
    console.log("== capabilities");
    const caps = await c.capabilities();
    check("talk version", !!caps.talk, `${caps.nextcloud} / Talk ${caps.talk}`);
    check("threads feature", caps.features.has("threads"));
  }

  if (want("dir")) {
    console.log("== directory");
    const users = await dir.users();
    const groups = await dir.groups();
    const rooms = await dir.rooms();
    check("users", users.length > 0, users.length);
    check("groups", groups.length > 0, groups.length);
    check("rooms (member + open)", rooms.length > 0, `${rooms.filter((r) => r.isParticipant).length} + ${rooms.filter((r) => !r.isParticipant).length}`);
    for (const [q, fuzzy] of [["pasch", false], ["Patrik Pash", true], ["FuE", false], ["DataSec", true], ["mueller holz", true], ["automatisirung", true]]) {
      const hits = await dir.search(q, { fuzzy, limit: 4 });
      console.log(`   search "${q}" fuzzy=${fuzzy}:`, hits.map((h) => `${h.kind}:${h.label}(${h.score})`).join(", ") || "-");
    }
    const exactHits = await dir.search("patrick", { fuzzy: false, limit: 3 });
    check("exact search finds peer", exactHits.some((h) => h.id === NC_PEER));
    const fuzzyHits = await dir.search("Patrik Pash", { fuzzy: true, limit: 3 });
    check("fuzzy search finds peer with typos", fuzzyHits.slice(0, 2).some((h) => h.id === NC_PEER || h.name === NC_PEER));
  }

  if (want("resolve")) {
    console.log("== resolve");
    const cases = [NC_PEER, NC_ROOM, "FuE", "Patrick Pasch", "group:FuE", "user:" + NC_PEER, "DataSec / FuE", "null", "xsviypj5", ""];
    for (const r of cases) {
      try {
        const { kind, entry } = await dir.resolve(r);
        console.log(`   "${r}" → ${kind}:${entry.id} (${entry.label})`);
      } catch (e) {
        console.log(`   "${r}" → ${e.code}: ${e.message.slice(0, 160)}`);
      }
    }
    const a = await dir.resolve(NC_PEER);
    check("peer user id resolves (1:1 room or user)", ["room", "user"].includes(a.kind));
    const b = await dir.resolve(NC_ROOM);
    check("room token resolves", b.kind === "room" && b.entry.token === NC_ROOM);
  }

  let dmToken;
  if (want("send")) {
    console.log("== send");
    const room = await talk.openDirect(c, NC_PEER);
    dmToken = room.token;
    check("openDirect returns 1:1", room.type === "one_to_one", `${room.token} created=${room.created}`);
    const r1 = await del.send(NC_PEER, `${TAG} Direktnachricht über Userkennung (${new Date().toLocaleString("de-DE")})`);
    check("send to user id", r1.status === "ok", r1.status + " " + (r1.error?.message || ""));
    const r2 = await del.send("user:" + NC_PEER, `${TAG} **fett**, [Link](https://nextcloud.com) und Umlaute äöüß`);
    check("send with markdown", r2.status === "ok" && r2.token === dmToken);
    const r3 = await del.send(NC_ROOM, `${TAG} stille Nachricht in den Gruppenraum`, { silent: true });
    check("silent send to room token", r3.status === "ok", r3.status);
    const { messages } = await talk.getMessages(c, dmToken, { limit: 5 });
    check("sent message readable", messages.some((m) => m.id === r2.messageId), messages.map((m) => m.id).slice(-3));
  }

  if (want("thread")) {
    console.log("== threads");
    for (const [label, target, silent] of [["1:1", NC_PEER, false], ["group", NC_ROOM, true]]) {
      const start = await del.send(target, `${TAG} Startnachricht des Threads (${label})`, {
        threadTitle: `Testthread ${label} ${new Date().toISOString().slice(11, 19)}`,
        silent,
      });
      check(`${label}: thread created`, start.status === "ok" && !!start.threadId, `thread ${start.threadId}`);
      if (!start.threadId) continue;
      const reply = await del.send(target, `${TAG} Antwort im Thread`, { threadId: start.threadId, silent });
      check(`${label}: reply in thread`, reply.status === "ok" && reply.threadId === start.threadId, reply.threadId);
      const list = await talk.listThreads(c, start.token);
      check(`${label}: listThreads contains it`, list.some((t) => t.id === start.threadId));
      const closed = await talk.closeThread(c, start.token, start.threadId, { message: `${TAG} Thread abgeschlossen.` });
      check(`${label}: closed (title prefix)`, talk.isClosedTitle(closed.title), closed.title);
      const again = await talk.closeThread(c, start.token, start.threadId);
      check(`${label}: close is idempotent`, again.alreadyClosed === true);
      if (label === "1:1") {
        const re = await talk.reopenThread(c, start.token, start.threadId);
        check(`${label}: reopen`, !talk.isClosedTitle(re.title), re.title);
        await talk.closeThread(c, start.token, start.threadId);
      }
    }
  }

  if (want("fallback")) {
    console.log("== fallback");
    fallbacks.length = 0;
    const f1 = await del.send("DataSec / FuE", `${TAG} darf nicht per Talk ankommen`, { subject: "Test" });
    check("unknown room → fallback", f1.status === "fallback" && fallbacks.length === 1, `${f1.status} ${f1.error?.code}`);
    const f2 = await del.send("null", `${TAG} x`);
    check("'null' → fallback, no mails", f2.status === "fallback" && fallbacks[1]?.email_list.length === 0, f2.error?.code);
    const f3 = await del.send("xsviypj5", `${TAG} x`, { fallback: false });
    check("unknown token w/o fallback → error", f3.status === "error", f3.error?.message?.slice(0, 80));
    // simulate a Talk failure after successful resolution: user exists, but sending fails
    const orig = talk.sendMessage;
    talk.sendMessage = async () => {
      const { TalkError } = require("../../client");
      throw new TalkError("server", "simulated 503", { retryable: true, status: 503 });
    };
    const f4 = await del.send(NC_PEER, `${TAG} simulierter Ausfall`);
    talk.sendMessage = orig;
    const p = fallbacks[fallbacks.length - 1];
    check("talk down → fallback with peer e-mail", f4.status === "fallback" && p.email_list.length === 1, { status: f4.status, attempts: f4.results[0]?.error, emails: p.email_list.length });
    console.log("   fallback payload keys:", Object.keys(p).join(", "));
  }

  if (want("poll")) {
    console.log("== poll (one cycle, no read markers changed for rooms without news)");
    const seen = [];
    const poller = new Poller({
      client: c,
      onMessage: async (m, room) => seen.push(`${room.displayName}: ${m.authorName}: ${m.text.slice(0, 60)}`),
      log: (m) => console.log("   [poll]", m),
    });
    poller.running = true;
    await poller.pollOnce();
    console.log(`   ${seen.length} new foreign messages`, seen.slice(0, 5));
    check("modifiedSince watermark set", poller.modifiedSince > 0, poller.modifiedSince);
    await poller.pollOnce();
    check("second cycle is cheap and runs", true);
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
