const { NextcloudClient } = require("../client");
const { Directory } = require("../directory");
const { Delivery } = require("../delivery");
const { OutboxWorker, FINAL } = require("../outbox");
const talk = require("../talk");
const { standardFake } = require("./fake-nextcloud");

// same interface as outbox-store.js, in memory
const memoryStore = () => {
  const rows = new Map();
  let nextId = 1;
  return {
    rows,
    add(job) {
      const id = nextId++;
      const now = new Date();
      rows.set(id, { id, status: "queued", attempts: 0, created_at: now, next_attempt_at: now, reference_id: talk.newReferenceId(), ...job });
      return id;
    },
    async due(limit) {
      return [...rows.values()].filter((r) => r.status === "queued" && r.next_attempt_at <= new Date()).slice(0, limit).map((r) => ({ ...r }));
    },
    async get(id) {
      return rows.has(id) ? { ...rows.get(id) } : null;
    },
    async update(id, patch) {
      Object.assign(rows.get(id), patch);
    },
    async claim(id, attempts) {
      const r = rows.get(id);
      if (r.status !== "queued") return false;
      Object.assign(r, { status: "sending", claimed_at: new Date(), attempts });
      return true;
    },
    async requeueStale(ms) {
      for (const r of rows.values())
        if (r.status === "sending" && r.claimed_at < new Date(Date.now() - ms)) Object.assign(r, { status: "queued", next_attempt_at: new Date(0) });
    },
    async cleanup() {},
  };
};

let fake, rt, store, worker, actions;
const past = () => new Date(Date.now() - 1000);
beforeEach(async () => {
  fake = await standardFake();
  const client = new NextcloudClient({ host: fake.host, user: "bot", password: "x", timeout: 2000 });
  const directory = new Directory(client);
  rt = {
    cfg: { fallback_action: "mailFallback" },
    client,
    directory,
    queueDelivery: new Delivery({ client, directory, options: { retries: 1 } }),
  };
  store = memoryStore();
  actions = [];
  worker = new OutboxWorker({
    store,
    getCtx: () => rt,
    runAction: async (name, row) => actions.push({ name, row }),
    maxAttempts: 3,
  });
  worker.running = true;
});
afterEach(async () => await fake.stop());

const sentTo = (token) => fake.messages[token]?.filter((m) => m.actorId === "bot") || [];

describe("outbox worker", () => {
  it("delivers a queued message", async () => {
    const id = store.add({ job: "send", recipient: "fueroom1", text: "aus der Queue", options_json: "{}" });
    await worker.runOnce();
    const r = await store.get(id);
    expect(r.status).toBe("sent");
    expect(r.message_id).toBe(sentTo("fueroom1")[0].id);
  });

  it("retries temporary errors with backoff, then runs the fallback", async () => {
    fake.fail("POST", /\/chat\//, { status: 503, times: 10 });
    const id = store.add({ job: "send", recipient: "patrick.pasch", text: "x", options_json: '{"subject":"S"}' });
    await worker.runOnce();
    let r = await store.get(id);
    expect([r.status, r.attempts]).toEqual(["queued", 1]);
    expect(r.next_attempt_at - Date.now()).toBeGreaterThan(8000);
    for (let i = 0; i < 2; i++) {
      await store.update(id, { next_attempt_at: past() });
      await worker.runOnce();
    }
    r = await store.get(id);
    expect([r.status, r.attempts]).toEqual(["fallback", 3]);
    expect(actions[0].name).toBe("mailFallback");
    expect(actions[0].row.email_list).toEqual(["pp@example.com"]);
    expect(actions[0].row.subject).toBe("S");
  });

  it("goes to the fallback at once for permanent errors", async () => {
    const id = store.add({ job: "send", recipient: "null", text: "x", options_json: "{}" });
    await worker.runOnce();
    const r = await store.get(id);
    expect([r.status, r.attempts, r.error_code]).toEqual(["fallback", 1, "not_found"]);
  });

  it("uses a per-job fallback action", async () => {
    store.add({ job: "send", recipient: "null", text: "x", options_json: '{"fallback_action":"other"}' });
    await worker.runOnce();
    expect(actions[0].name).toBe("other");
  });

  it("runs on_result_action with the result and the context", async () => {
    const id = store.add({ job: "send", recipient: "fueroom1", text: "x", options_json: '{"threadTitle":"T"}', on_result_action: "storeThread", context_json: '{"caseid":7}' });
    await worker.runOnce();
    const a = actions.find((x) => x.name === "storeThread");
    expect(a.row.queue_id).toBe(id);
    expect(a.row.status).toBe("sent");
    expect(a.row.thread_id).toBeGreaterThan(0);
    expect(a.row.context).toEqual({ caseid: 7 });
  });

  it("closes a thread created by another queued job (outbox:<id>)", async () => {
    const send = store.add({ job: "send", recipient: "fueroom1", text: "Start", options_json: '{"threadTitle":"Vorgang"}' });
    const close = store.add({ job: "close_thread", recipient: "fueroom1", text: "fertig", options_json: JSON.stringify({ thread_ref: `outbox:${send}` }) });
    await worker.runOnce();
    await store.update(close, { next_attempt_at: past() });
    await worker.runOnce();
    const s = await store.get(send);
    const c = await store.get(close);
    expect(c.status).toBe("sent");
    expect(c.thread_id).toBe(s.thread_id);
    expect(talk.isClosedTitle((await talk.getThread(rt.client, "fueroom1", s.thread_id)).title)).toBe(true);
  });

  it("waits for a dependency without counting attempts", async () => {
    const send = store.add({ job: "send", recipient: "fueroom1", text: "Start", options_json: '{"threadTitle":"V"}', next_attempt_at: new Date(Date.now() + 60000) });
    const close = store.add({ job: "close_thread", recipient: "fueroom1", options_json: JSON.stringify({ thread_ref: `outbox:${send}` }) });
    await worker.runOnce();
    const c = await store.get(close);
    expect([c.status, c.attempts]).toEqual(["queued", 0]);
  });

  it("recovers a job stuck in 'sending' without sending twice", async () => {
    const id = store.add({ job: "send", recipient: "fueroom1", text: "genau einmal", options_json: "{}" });
    const job = await store.get(id);
    await talk.sendMessage(rt.client, "fueroom1", job.text, { referenceId: job.reference_id }); // delivered, then crash
    await store.update(id, { status: "sending", attempts: 1, claimed_at: new Date(Date.now() - 10 * 60 * 1000) });
    await worker.runOnce();
    expect((await store.get(id)).status).toBe("sent");
    expect(sentTo("fueroom1").length).toBe(1);
  });

  it("a job can only be claimed once (two workers)", async () => {
    const id = store.add({ job: "send", recipient: "fueroom1", text: "x", options_json: "{}" });
    const w2 = new OutboxWorker({ store, getCtx: () => rt, runAction: async () => {} });
    w2.running = true;
    await Promise.all([worker.runOnce(), w2.runOnce()]);
    expect((await store.get(id)).status).toBe("sent");
    expect(sentTo("fueroom1").length).toBe(1);
  });

  it("circuit breaker: an outage stops the round after the first failure", async () => {
    fake.fail("POST", /\/chat\//, { status: 503, times: 100 });
    for (let i = 0; i < 5; i++) store.add({ job: "send", recipient: "fueroom1", text: "x" + i, options_json: "{}" });
    await worker.runOnce();
    const statuses = [...store.rows.values()].map((r) => r.attempts);
    expect(statuses.filter((a) => a === 1).length).toBe(1);
  });

  it("finished states are final", () => {
    expect(FINAL).toEqual(["sent", "partial", "fallback", "failed"]);
  });
});
