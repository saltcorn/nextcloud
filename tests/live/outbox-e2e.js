/*
 * Outbox end-to-end test inside a Saltcorn process, while the server worker runs.
 *   NODE_PATH=<saltcorn cli node_modules> node test/outbox-e2e.js
 * A: real path – queued by functions/actions, delivered by the SERVER worker
 * B: simulated outage – held jobs processed by a test worker (retry, then fallback mail)
 * C: crash recovery – delivered but result never stored; the SERVER worker must not resend
 * Sends real Talk messages to NC_PEER and one real fallback mail.
 */
const { getState, init_multi_tenant } = require("@saltcorn/data/db/state");
const Plugin = require("@saltcorn/data/models/plugin");
const Trigger = require("@saltcorn/data/models/trigger");
const { TalkError } = require("../../client");
const talk = require("../../talk");
const store = require("../../outbox-store");
const { OutboxWorker, FINAL } = require("../../outbox");

const TAG = "[Test Nextcloud-Modul]";
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "  ok " : "  FAIL"} ${name}${extra !== undefined ? "  → " + JSON.stringify(extra) : ""}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LATER = () => new Date(Date.now() + 3600 * 1000); // held: invisible for the server worker

(async () => {
  await init_multi_tenant(async () => {}, false, []);
  getState().registerPlugin("base", require("@saltcorn/base-plugin"));
  await getState().refresh(true);
  const cfg = { ...(await Plugin.findOne({ name: "nextcloud" })).configuration, listen_rooms: "" };
  const plugin = require("../../index.js");
  getState().registerPlugin("nextcloud-outbox-test", plugin, cfg);
  await plugin.onLoad(cfg);
  const F = plugin.functions(cfg);
  const A = plugin.actions(cfg);
  const rt = () => require("../../runtime").getCtx();
  const peer = process.env.NC_PEER || "patrick.pasch";
  await store.ensureTable();
  const s = store.makeStore();
  const waitFinal = async (ids, maxS = 40) => {
    for (let i = 0; i < maxS * 2; i++) {
      const rows = await Promise.all(ids.map((id) => s.get(id)));
      if (rows.every((r) => FINAL.includes(r.status))) return rows;
      await sleep(500);
    }
    return await Promise.all(ids.map((id) => s.get(id)));
  };

  console.log("== A: real path via server worker");
  let t = Date.now();
  const q1 = await F.nextcloud_talk_send.run(peer, `${TAG} Warteschlange, mit Thread`, {
    threadTitle: `Queue-Test ${new Date().toISOString().slice(11, 19)}`,
  });
  const ms1 = Date.now() - t;
  check("legacy function returns queued immediately", q1.status === "queued" && q1.error === null && ms1 < 100, { ms: ms1 });
  const a1 = await A.nextcloud_talk_close_thread.run({
    row: { ref: `outbox:${q1.queueId}` },
    user: { id: 1, role_id: 1 },
    configuration: { room: peer, thread_id: "{{ ref }}", message: `${TAG} Thread über die Warteschlange geschlossen` },
  });
  check("close_thread action queued with outbox reference", a1.talk_status === "queued");
  const q2 = await F.nextcloud_talk_send.run("null", `${TAG} unbekannter Empfänger`);
  const [r1, r1c, r2] = await waitFinal([q1.queueId, a1.talk_queue_id, q2.queueId]);
  check("send job sent, thread id set", r1.status === "sent" && r1.thread_id === r1.message_id, { status: r1.status, thread: r1.thread_id });
  check("close job done after its dependency", r1c.status === "sent" && r1c.thread_id === r1.thread_id, { status: r1c.status, err: r1c.error });
  const th = await talk.getThread(rt().client, r1.token, r1.thread_id);
  check("thread title marked closed", talk.isClosedTitle(th.title), th.title);
  check("unknown recipient: final without retry", ["fallback", "failed"].includes(r2.status) && r2.attempts === 1, { status: r2.status, attempts: r2.attempts, fb: r2.fallback_info });
  const q0 = await F.nextcloud_talk_send.run(peer, `${TAG} normale Nachricht ohne Thread`);
  const [r0] = await waitFinal([q0.queueId]);
  check("plain message has no thread id", r0.status === "sent" && !r0.thread_id, { thread: r0.thread_id });

  console.log("== B: simulated outage (held job, test worker)");
  const worker = new OutboxWorker({
    store: s,
    getCtx: rt,
    runAction: async (name, row) => ((await Trigger.findOne({ name })) || (await Trigger.findDB({ name }))[0]).runWithoutRow({ row }),
    log: (m) => console.log("   [test worker]", m),
    maxAttempts: 2,
  });
  worker.running = true;
  const id3 = await store.enqueue({
    job: "send",
    recipient: peer,
    text: `${TAG} **Warteschlange + Fallback**: Talk war (simuliert) nicht erreichbar.`,
    options_json: JSON.stringify({ subject: `${TAG} Warteschlange + Fallback` }),
    reference_id: talk.newReferenceId(),
    source: "test",
    next_attempt_at: LATER(),
  });
  const orig = talk.sendMessage;
  talk.sendMessage = async () => {
    throw new TalkError("server", "simulated outage (test)", { status: 503, retryable: true });
  };
  const res1 = await worker.process(await s.get(id3));
  let r3 = await s.get(id3);
  const waitS = Math.round((new Date(r3.next_attempt_at) - Date.now()) / 1000);
  check("attempt 1 failed → requeued with backoff", res1 === "retry" && r3.status === "queued" && r3.attempts === 1 && waitS >= 9, { attempts: r3.attempts, next_in_s: waitS });
  await s.update(id3, { next_attempt_at: LATER() }); // keep it away from the server worker
  await worker.process(await s.get(id3));
  r3 = await s.get(id3);
  check("attempt 2 (last) → fallback mail", r3.status === "fallback" && r3.attempts === 2, { status: r3.status, fb: r3.fallback_info });
  talk.sendMessage = orig;
  const claimedTwice = await s.claim(id3, 9);
  check("finished job cannot be claimed again", claimedTwice === false);

  console.log("== C: crash recovery by the server worker (delivered, result never stored)");
  const ref = talk.newReferenceId();
  const text4 = `${TAG} nach simuliertem Absturz genau einmal`;
  const room = await talk.openDirect(rt().client, peer);
  await talk.sendMessage(rt().client, room.token, text4, { referenceId: ref });
  const id4 = await store.enqueue({
    job: "send",
    recipient: peer,
    text: text4,
    options_json: "{}",
    reference_id: ref,
    source: "test",
    status: "sending",
    attempts: 1,
    claimed_at: new Date(Date.now() - 10 * 60 * 1000),
  });
  const [r4] = await waitFinal([id4], 30);
  const { messages } = await talk.getMessages(rt().client, room.token, { limit: 30 });
  const copies = messages.filter((m) => m.referenceId === ref).length;
  check("stale job recovered by server worker", r4.status === "sent" && r4.attempts === 2, { status: r4.status, attempts: r4.attempts });
  check("message exists exactly once", copies === 1, copies);

  console.log("   outbox counts:", JSON.stringify(await s.counts()));
  console.log(failed ? `\n${failed} FAILED` : "\nall ok");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
