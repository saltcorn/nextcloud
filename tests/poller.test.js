const { NextcloudClient } = require("../client");
const { Poller } = require("../poller");
const talk = require("../talk");
const { standardFake } = require("./fake-nextcloud");

let fake, client;
beforeEach(async () => {
  fake = await standardFake();
  client = new NextcloudClient({ host: fake.host, user: "bot", password: "x" });
});
afterEach(async () => await fake.stop());

const mkPoller = (seen, opts = {}) => {
  const p = new Poller({ client, onMessage: async (m, room) => seen.push(`${room.displayName}:${m.text}`), ...opts });
  p.running = true;
  return p;
};

describe("listener", () => {
  it("raises foreign messages once and sets the read marker", async () => {
    const seen = [];
    const p = mkPoller(seen);
    await p.pollOnce();
    fake.incoming("fueroom1", "patrick.pasch", "hallo bot");
    await p.pollOnce();
    await p.pollOnce();
    expect(seen).toEqual(["FuE:hallo bot"]);
    expect(fake.readMarker.fueroom1).toBe(fake.messages.fueroom1.at(-1).id);
  });

  it("skips own, system and deleted messages", async () => {
    const seen = [];
    const p = mkPoller(seen);
    await p.pollOnce();
    await talk.sendMessage(client, "fueroom1", "eigene Nachricht");
    fake.incoming("fueroom1", "patrick.pasch", "", { messageType: "system", systemMessage: "user_added" });
    fake.incoming("fueroom1", "patrick.pasch", "echt");
    await p.pollOnce();
    expect(seen).toEqual(["FuE:echt"]);
  });

  it("uses modifiedSince so quiet rooms cost nothing", async () => {
    const p = mkPoller([]);
    await p.pollOnce();
    await p.pollOnce();
    const last = fake.requests.filter((r) => r.startsWith("GET /apps/spreed/api/v1/chat/")).length;
    await p.pollOnce();
    expect(fake.requests.filter((r) => r.startsWith("GET /apps/spreed/api/v1/chat/")).length).toBe(last);
  });

  it("continues after a restart from the read marker, nothing lost", async () => {
    const seen = [];
    await mkPoller(seen).pollOnce();
    fake.incoming("fueroom1", "patrick.pasch", "während Neustart");
    const restarted = mkPoller(seen); // new process: empty memory
    await restarted.pollOnce();
    expect(seen).toEqual(["FuE:während Neustart"]);
  });

  it("a failing handler does not block the room", async () => {
    let calls = 0;
    const p = new Poller({
      client,
      onMessage: async (m) => {
        calls++;
        if (m.text === "gift") throw new Error("handler kaputt");
      },
    });
    p.running = true;
    await p.pollOnce();
    fake.incoming("fueroom1", "patrick.pasch", "gift");
    fake.incoming("fueroom1", "patrick.pasch", "danach");
    await p.pollOnce();
    await p.pollOnce();
    expect(calls).toBe(2);
  });

  it("only watches selected rooms", async () => {
    const seen = [];
    const p = mkPoller(seen, { shouldWatch: (r) => r.token === "grproom1" });
    await p.pollOnce();
    fake.incoming("fueroom1", "patrick.pasch", "nicht beobachtet");
    fake.incoming("grproom1", "anna.mueller", "beobachtet");
    await p.pollOnce();
    expect(seen).toEqual(["Kunde MüllerHolz:beobachtet"]);
  });
});
