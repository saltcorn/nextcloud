/*
 * Smoke test of index.js inside a Saltcorn process (not installed as plugin).
 *   NODE_PATH=<saltcorn cli node_modules> node test/saltcorn-smoke.js
 * Reads the configuration of the installed nextcloud plugin from the database.
 */
const db = require("@saltcorn/data/db");
const { getState, init_multi_tenant } = require("@saltcorn/data/db/state");
const Plugin = require("@saltcorn/data/models/plugin");

(async () => {
  await init_multi_tenant(async () => {}, false, []);
  const installed = await Plugin.findOne({ name: "nextcloud" });
  const plugin = require("../../index.js");
  const cfg = { ...installed.configuration, fallback_action: "__does_not_exist__", listen_rooms: "" };
  // register exactly like Saltcorn's plugin loader does – catches export shape errors
  // (a load error makes Saltcorn reinstall the plugin from npm, overwriting local files)
  getState().registerPlugin("nextcloud-smoketest", plugin, cfg);
  for (const k of ["functions", "actions", "eventTypes", "table_providers", "exchange"])
    if (plugin.configuration_workflow && typeof plugin[k] !== "function")
      throw new Error(`export ${k} must be a function when configuration_workflow is present`);
  console.log("registerPlugin ok; agent skills in state:", (getState().exchange.agent_skills || []).map((s) => s.skill_name).join(", "));
  await plugin.onLoad(cfg);
  const F = plugin.functions(cfg);
  const A = plugin.actions(cfg);
  const peer = process.env.NC_PEER || "patrick.pasch";

  const h = await F.nextcloud_talk_health.run();
  console.log("health:", JSON.stringify(h));

  const hits = await F.nextcloud_talk_find.run("pasch", { limit: 3 });
  console.log("find:", hits.map((x) => `${x.kind}:${x.label}`).join(", "));

  const legacy = await F.nextcloud_get_rooms.run();
  console.log("legacy nextcloud_get_rooms:", legacy.length, "rooms, has token:", !!legacy[0]?.token);

  // legacy signature used by existing triggers: nextcloud_talk_send(addressat, message)
  const r1 = await F.nextcloud_talk_send.run(peer, "[Test Nextcloud-Modul] Aufruf mit alter Signatur aus Saltcorn");
  console.log("legacy send:", r1.status, r1.messageId);

  const r2 = await A.nextcloud_talk_send.run({
    row: { name: "Testvorgang 4711", peer },
    user: { id: 1, role_id: 1 },
    configuration: {
      room: "{{ peer }}",
      text: "[Test Nextcloud-Modul] Aktion mit Platzhalter: {{ name }}",
      thread_title: "Vorgang {{ name }}",
    },
  });
  console.log("action send:", JSON.stringify(r2));

  const r3 = await F.nextcloud_talk_send.run("null", "[Test Nextcloud-Modul] geht nicht");
  console.log("unknown recipient + missing fallback trigger:", r3.status, "| fallback:", JSON.stringify(r3.fallback));

  const tp = plugin.table_providers(cfg)["Nextcloud directory"];
  for (const entity_type of ["Users", "Groups", "Conversations"]) {
    const t = tp.get_table({ entity_type });
    const rows = await t.getRows({}, { limit: 3, orderBy: "label" });
    const n = await t.countRows({});
    console.log(`table ${entity_type}: ${n} rows, fields ${Object.keys(rows[0] || {}).join(",")}`);
  }
  const filtered = await tp.get_table({ entity_type: "Users" }).getRows({ label: { ilike: "pasch" } });
  console.log("table filter ilike:", filtered.map((r) => r.id));

  const Skill = plugin.exchange(cfg).agent_skills[0];
  const skill = new Skill({ allow_send: false });
  const tools = skill.provideTools();
  console.log("skill tools:", tools.map((t) => t.function.name).join(", "));
  const refused = await tools.find((t) => t.function.name === "talk_send").process({ recipient: peer, text: "x" });
  console.log("skill send without permission:", JSON.stringify(refused));
  const read = await tools.find((t) => t.function.name === "talk_read").process({ conversation: peer, limit: 3 });
  console.log("skill read:", read.status, read.messages?.length);

  const adapter = plugin.exchange(cfg).chat_adapters[0].get();
  console.log("adapter caps:", JSON.stringify(await adapter.capabilities()));
  process.exit(0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
