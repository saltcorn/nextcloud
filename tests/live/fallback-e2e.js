/*
 * End-to-end fallback test: simulated Talk outage → configured fallback trigger.
 *   NODE_PATH=<saltcorn cli node_modules> node test/fallback-e2e.js <recipient>
 * Uses the fallback action from the installed plugin configuration. Sends REAL mail
 * if that trigger does so.
 */
const { getState, init_multi_tenant } = require("@saltcorn/data/db/state");
const Plugin = require("@saltcorn/data/models/plugin");
const { TalkError } = require("../../client");
const talk = require("../../talk");

(async () => {
  await init_multi_tenant(async () => {}, false, []);
  const cfg = { ...(await Plugin.findOne({ name: "nextcloud" })).configuration, listen_rooms: "" };
  // base plugin provides run_js_code, send_email, … like in the server
  getState().registerPlugin("base", require("@saltcorn/base-plugin"));
  await getState().refresh(true); // tables, triggers, … as in the server
  const plugin = require("../../index.js");
  getState().registerPlugin("nextcloud-e2e", plugin, cfg);
  await plugin.onLoad(cfg);
  talk.sendMessage = async () => {
    throw new TalkError("server", "simulated outage (test)", { status: 503, retryable: true });
  };
  const recipient = process.argv[2];
  const r = await plugin.functions(cfg).nextcloud_talk_send.run(
    recipient,
    `[Test Nextcloud-Modul] **Fallback-Test**: Diese Nachricht sollte per Talk kommen, Talk war (simuliert) nicht erreichbar.\n\nZweiter Absatz mit [Link](https://grandmaster.intra.camdata.de).`,
    { subject: "[Test Nextcloud-Modul] Fallback-Test" },
  );
  console.log("RESULT", JSON.stringify({ status: r.status, error: r.error?.code, fallback: r.fallback }));
  await new Promise((res) => setTimeout(res, 8000)); // let the mail trigger finish
  process.exit(0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
