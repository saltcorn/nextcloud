const plugin = require("..");

// Saltcorn calls every export as plugin[key](cfg) when a configuration_workflow
// exists; an object there breaks loading (and makes Saltcorn reinstall from npm).
const CFG_KEYS = ["functions", "actions", "eventTypes", "table_providers", "exchange"];

describe("plugin exports", () => {
  it("has the plugin api shape", () => {
    expect(plugin.sc_plugin_api_version).toBe(1);
    expect(plugin.plugin_name).toBe("nextcloud");
    expect(typeof plugin.configuration_workflow).toBe("function");
    expect(typeof plugin.onLoad).toBe("function");
    for (const k of CFG_KEYS) expect(typeof plugin[k]).toBe("function");
  });

  it("keeps the legacy names", () => {
    const f = plugin.functions({});
    for (const n of ["nextcloud_talk_send", "nextcloud_get_rooms", "nextcloud_reconnect"]) expect(typeof f[n].run).toBe("function");
    expect(plugin.actions({}).nextcloud_talk_send).toBeDefined();
    expect(plugin.eventTypes({}).NextCloudTalkReceive.hasChannel).toBe(true);
  });

  it("describes all functions", () => {
    for (const [name, f] of Object.entries(plugin.functions({}))) {
      expect(typeof f.run).toBe("function");
      expect(f.isAsync).toBe(true);
      expect(f.description).toBeTruthy();
      expect(Array.isArray(f.arguments)).toBe(true);
    }
  });

  it("provides table provider, agent skill and chat adapter", () => {
    expect(plugin.table_providers({})["Nextcloud directory"].get_table).toBeDefined();
    const ex = plugin.exchange({});
    expect(ex.agent_skills[0].skill_name).toBe("Nextcloud Talk");
    expect(ex.chat_adapters[0].id).toBe("nextcloud-talk");
    const tools = new ex.agent_skills[0]({ allow_send: false }).provideTools();
    expect(tools.map((t) => t.function.name)).toEqual(["talk_find", "talk_read", "talk_send", "talk_close_thread"]);
  });

  it("refuses sending from an agent without permission", async () => {
    const Skill = plugin.exchange({}).agent_skills[0];
    const send = new Skill({ allow_send: false }).provideTools().find((t) => t.function.name === "talk_send");
    expect((await send.process({ recipient: "x", text: "y" })).status).toBe("refused");
    const restricted = new Skill({ allow_send: true, allowed_recipients: "a, b" });
    const send2 = restricted.provideTools().find((t) => t.function.name === "talk_send");
    expect((await send2.process({ recipient: "user:c", text: "y" })).status).toBe("refused");
  });
});
