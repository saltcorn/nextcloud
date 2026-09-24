const { NextcloudClient } = require("../client");
const { Directory, scoreString, fold } = require("../directory");
const { standardFake } = require("./fake-nextcloud");

let fake, client, dir;
beforeAll(async () => {
  fake = await standardFake();
  client = new NextcloudClient({ host: fake.host, user: "bot", password: "x" });
  dir = new Directory(client);
});
afterAll(async () => await fake.stop());

describe("text matching", () => {
  it("folds umlauts and case", () => {
    expect(fold("Anna Müller")).toBe("anna mueller");
    expect(fold("Straße")).toBe("strasse");
  });
  it("scores exact, prefix, substring and fuzzy", () => {
    expect(scoreString("patrick pasch", "Patrick Pasch", false)).toBe(1);
    expect(scoreString("pat", "Patrick Pasch", false)).toBeGreaterThan(0.8);
    expect(scoreString("Patrik Pash", "Patrick Pasch", false)).toBe(0);
    expect(scoreString("Patrik Pash", "Patrick Pasch", true)).toBeGreaterThan(0.5);
    expect(scoreString("mueller holz", "Kunde MüllerHolz", false)).toBeGreaterThan(0.6);
  });
});

describe("directory", () => {
  it("lists users, groups (paged despite LDAP limit) and rooms", async () => {
    expect((await dir.users()).length).toBe(5);
    expect((await dir.groups()).map((g) => g.id).sort()).toEqual(["DataSec", "FuE"]);
    const rooms = await dir.rooms();
    expect(rooms.find((r) => r.token === "fueroom1").isParticipant).toBe(true);
    expect(rooms.find((r) => r.token === "openroom").isParticipant).toBe(false); // listed, not joined
    expect(rooms.find((r) => r.token === "privroom")).toBeUndefined(); // private, invisible
  });

  it("searches exact and fuzzy, skips disabled users", async () => {
    const exact = await dir.search("pasch", { fuzzy: false });
    expect(exact.some((h) => h.kind === "user" && h.id === "patrick.pasch")).toBe(true);
    const fuzzy = await dir.search("Patrik Pash", { fuzzy: true });
    expect(fuzzy[0].id).toBe("patrick.pasch");
    expect((await dir.search("Old User")).length).toBe(0);
    const umlaut = await dir.search("mueller", { types: ["user"] });
    expect(umlaut[0].id).toBe("anna.mueller");
  });

  it("resolves strictly with a fixed order and prefixes", async () => {
    expect((await dir.resolve("fueroom1")).kind).toBe("room");
    expect((await dir.resolve("FuE")).kind).toBe("room"); // room before group
    expect((await dir.resolve("group:FuE")).kind).toBe("group");
    expect((await dir.resolve("patrick.pasch")).entry.id).toBe("patrick.pasch");
    expect((await dir.resolve("pp@example.com")).entry.id).toBe("patrick.pasch");
    expect((await dir.resolve("Anna Müller")).entry.id).toBe("anna.mueller");
  });

  it("never guesses: unknown recipients fail with suggestions", async () => {
    await expect(dir.resolve("null")).rejects.toMatchObject({ code: "not_found" });
    await expect(dir.resolve("DataSec / FuE")).rejects.toMatchObject({ code: "not_found" });
    const e = await dir.resolve("Patrik").catch((x) => x);
    expect(e.code).toBe("not_found");
    expect(e.details.suggestions.some((s) => s.id === "patrick.pasch")).toBe(true);
  });

  it("collects e-mails for fallback (user, group, room incl. group participants)", async () => {
    expect(await dir.emailsFor(await dir.resolve("patrick.pasch"))).toEqual(["pp@example.com"]);
    expect((await dir.emailsFor(await dir.resolve("group:FuE"))).sort()).toEqual(["anna@example.com", "pp@example.com"]);
    expect(await dir.emailsFor(await dir.resolve("grproom1"))).toEqual(["anna@example.com"]);
  });

  it("rate limits forced reloads for unknown recipients", async () => {
    const before = fake.requests.filter((r) => r.endsWith("/users/details")).length;
    for (let i = 0; i < 5; i++) await dir.resolve("nobody-" + i).catch(() => {});
    const after = fake.requests.filter((r) => r.endsWith("/users/details")).length;
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
