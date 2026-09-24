const { NextcloudClient, normalizeBaseUrl } = require("../client");
const talk = require("../talk");
const { standardFake } = require("./fake-nextcloud");

let fake, client;
beforeAll(async () => {
  fake = await standardFake();
  client = new NextcloudClient({ host: fake.host, user: "bot", password: "x" });
});
afterAll(async () => await fake.stop());

describe("client", () => {
  it("builds base urls like the legacy configuration", () => {
    expect(normalizeBaseUrl("cloud.example.com", 443)).toBe("https://cloud.example.com");
    expect(normalizeBaseUrl("https://cloud.example.com/nc/", 443)).toBe("https://cloud.example.com/nc");
    expect(normalizeBaseUrl("cloud.example.com", 8443)).toBe("https://cloud.example.com:8443");
    expect(normalizeBaseUrl("cloud.example.com", 80)).toBe("http://cloud.example.com");
  });
  it("reads capabilities", async () => {
    const caps = await client.capabilities();
    expect(caps.talk).toBe("24.0.4");
    expect(caps.features.has("threads")).toBe(true);
  });
});

describe("messages", () => {
  it("only reports a thread id for real thread messages", () => {
    expect(talk.normalizeMessage({ id: 5, threadId: 5, message: "x" }).threadId).toBeNull();
    const root = talk.normalizeMessage({ id: 6, threadId: 6, isThread: true, threadTitle: "T", message: "x" });
    expect([root.threadId, root.isThreadRoot]).toEqual([6, true]);
    const reply = talk.normalizeMessage({ id: 7, threadId: 6, isThread: true, message: "x" });
    expect([reply.threadId, reply.isThreadRoot]).toEqual([6, false]);
  });
  it("renders mentions readable", () => {
    const m = { message: "Hallo {mention-user1}", messageParameters: { "mention-user1": { type: "user", id: "pp", name: "Patrick" } } };
    expect(talk.renderMessageText(m)).toBe("Hallo @Patrick");
  });
  it("reads history and newer messages", async () => {
    fake.incoming("fueroom1", "patrick.pasch", "eins");
    const two = fake.incoming("fueroom1", "patrick.pasch", "zwei");
    const { messages } = await talk.getMessages(client, "fueroom1", { limit: 10 });
    expect(messages.map((m) => m.text).slice(-2)).toEqual(["eins", "zwei"]);
    const newer = await talk.getMessages(client, "fueroom1", { after: two.id });
    expect(newer.messages).toEqual([]);
  });
});

describe("threads", () => {
  it("creates, closes (idempotent) and reopens a thread", async () => {
    const { threadId } = await talk.createThread(client, "fueroom1", "Vorgang 4711", "Start");
    expect((await talk.listThreads(client, "fueroom1")).some((t) => t.id === threadId)).toBe(true);
    const closed = await talk.closeThread(client, "fueroom1", threadId, { message: "erledigt" });
    expect(closed.title).toBe("✅ Vorgang 4711");
    expect(fake.threadNotify[`fueroom1:${threadId}`]).toBe(3);
    const again = await talk.closeThread(client, "fueroom1", threadId);
    expect(again.alreadyClosed).toBe(true);
    const open = await talk.reopenThread(client, "fueroom1", threadId);
    expect(open.title).toBe("Vorgang 4711");
  });
  it("supports a custom closed prefix", async () => {
    const { threadId } = await talk.createThread(client, "fueroom1", "Prefix", "x");
    const t = await talk.closeThread(client, "fueroom1", threadId, { prefix: "[ERLEDIGT] " });
    expect(t.title).toBe("[ERLEDIGT] Prefix");
    expect(talk.isClosedTitle(t.title, "[ERLEDIGT] ")).toBe(true);
  });
});
