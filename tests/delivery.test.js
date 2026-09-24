const { NextcloudClient } = require("../client");
const { Directory } = require("../directory");
const { Delivery, splitText, textToHtml } = require("../delivery");
const talk = require("../talk");
const { standardFake } = require("./fake-nextcloud");

let fake, client, dir, fallbacks, del;
beforeEach(async () => {
  fake = await standardFake();
  client = new NextcloudClient({ host: fake.host, user: "bot", password: "x", timeout: 2000 });
  dir = new Directory(client);
  fallbacks = [];
  del = new Delivery({
    client,
    directory: dir,
    fallback: async (p) => fallbacks.push(p),
    options: { retries: 3, retryDelayMs: 10 },
  });
});
afterEach(async () => await fake.stop());

const sentTo = (token) => fake.messages[token].filter((m) => m.actorId === "bot");

describe("delivery", () => {
  it("sends to a room token", async () => {
    const r = await del.send("fueroom1", "hallo");
    expect(r.status).toBe("ok");
    expect(sentTo("fueroom1").length).toBe(1);
    expect(fallbacks.length).toBe(0);
  });

  it("creates the 1:1 conversation for a user on first contact", async () => {
    const r = await del.send("patrick.pasch", "direkt");
    expect(r.status).toBe("ok");
    expect(fake.rooms["dmpatrickpasch"].type).toBe(1);
    const again = await del.send("user:patrick.pasch", "zweimal");
    expect(again.token).toBe(r.token);
  });

  it("sends to every member of a group directly", async () => {
    const r = await del.send("group:DataSec", "an die Gruppe");
    expect(r.status).toBe("ok");
    expect(r.results.length).toBe(1); // DataSec = anna only
    expect(sentTo("dmannamueller").length).toBe(1);
  });

  it("creates and continues threads", async () => {
    const start = await del.send("fueroom1", "Start", { threadTitle: "Vorgang 1" });
    expect(start.threadId).toBe(start.messageId);
    const reply = await del.send("fueroom1", "Antwort", { threadId: start.threadId });
    expect(reply.threadId).toBe(start.threadId);
    const plain = await del.send("fueroom1", "ohne Thread");
    expect(plain.threadId).toBeNull();
  });

  it("splits long messages at paragraph boundaries into the same thread", async () => {
    const long = Array.from({ length: 5 }, (_, i) => `Absatz ${i} ` + "x".repeat(60)).join("\n\n");
    const r = await del.send("fueroom1", long, { threadTitle: "lang" });
    expect(r.status).toBe("ok");
    const msgs = sentTo("fueroom1");
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => m.threadId === r.threadId)).toBe(true);
    expect(new Set(msgs.map((m) => m.referenceId)).size).toBe(msgs.length);
    expect(splitText("a".repeat(250), 100).length).toBe(3);
  });

  it("retries temporary errors and succeeds", async () => {
    fake.fail("POST", /\/chat\/fueroom1$/, { status: 503, times: 2 });
    const r = await del.send("fueroom1", "nach zwei Fehlern");
    expect(r.status).toBe("ok");
    expect(r.results[0].attempts).toBe(3);
    expect(sentTo("fueroom1").length).toBe(1);
  });

  it("does not send twice when the answer got lost", async () => {
    fake.fail("POST", /\/chat\/fueroom1$/, { lostResponse: true, times: 1 });
    const r = await del.send("fueroom1", "Antwort verloren");
    expect(r.status).toBe("ok");
    expect(sentTo("fueroom1").length).toBe(1);
  });

  it("checkFirst finds an earlier delivery by referenceId", async () => {
    const ref = talk.newReferenceId();
    await talk.sendMessage(client, "fueroom1", "schon da", { referenceId: ref });
    const { out } = await del.attempt("fueroom1", "schon da", { referenceId: ref, checkFirst: true });
    expect(out.status).toBe("ok");
    expect(sentTo("fueroom1").length).toBe(1);
  });

  it("falls back for unknown recipients, with e-mail if the recipient is one", async () => {
    const r = await del.send("null", "weg");
    expect(r.status).toBe("fallback");
    expect(fallbacks[0].email_list).toEqual([]);
    expect(fallbacks[0].error_code).toBe("not_found");
    await del.send("someone@example.com", "per Mail");
    expect(fallbacks[1].email_list).toEqual(["someone@example.com"]);
  });

  it("falls back for conversations the account is not member of", async () => {
    const r = await del.send("openroom", "offen, aber kein Mitglied");
    expect(r.status).toBe("fallback");
    expect(r.error.code).toBe("not_member");
  });

  it("joins open conversations when allowed", async () => {
    const d = new Delivery({ client, directory: dir, options: { retries: 1, joinOpenRooms: true } });
    const r = await d.send("openroom", "beigetreten");
    expect(r.status).toBe("ok");
    expect(fake.rooms.openroom.members).toContain("bot");
  });

  it("falls back after the last attempt with the recipient's e-mail and html", async () => {
    fake.fail("POST", /\/chat\//, { status: 503, times: 10 });
    const r = await del.send("patrick.pasch", "**wichtig** [Link](https://example.com)", { subject: "S" });
    expect(r.status).toBe("fallback");
    const p = fallbacks[0];
    expect(p.email_list).toEqual(["pp@example.com"]);
    expect(p.subject).toBe("S");
    expect(p.html).toContain("<strong>wichtig</strong>");
    expect(p.html).toContain('<a href="https://example.com">Link</a>');
  });

  it("reports partial group delivery and falls back only for the failed members", async () => {
    await del.send("anna.mueller", "1:1 anlegen");
    fake.fail("POST", /\/chat\/dmannamueller$/, { status: 403, times: 1 });
    const r = await del.send("group:FuE", "an FuE");
    expect(r.status).toBe("partial");
    expect(fallbacks[0].email_list).toEqual(["anna@example.com"]);
  });

  it("stops talking to the server after a failed login", async () => {
    const bad = new NextcloudClient({ host: fake.host, user: "bot", password: "x" });
    fake.fail("GET", /\/room$/, { status: 401, times: 1 });
    await expect(talk.listRooms(bad)).rejects.toMatchObject({ code: "auth" });
    await expect(talk.listRooms(bad)).rejects.toMatchObject({ code: "auth_blocked" });
  });

  it("escapes html in fallback mails", () => {
    expect(textToHtml("<script>")).toBe("&lt;script&gt;");
  });
});
