const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Trigger = require("@saltcorn/data/models/trigger");
const cluster = require("cluster");
const NextcloudTalk = require("nctalkclient");
const { interpolate } = require("@saltcorn/data/utils");

let talk;
let listofrooms;
const configuration_workflow = () =>
  new Workflow({
    /* onDone: async (cfg) => {
      await onLoad(cfg);
      return cfg;
    },
*/ steps: [
      {
        name: "Nextcloud configuration",
        form: () =>
          new Form({
            fields: [
              {
                name: "host",
                label: "Host",
                sublabel:
                  "Nextcloud instance Host name or IP address, without protocol.",
                type: "String",
                required: true,
              },
              {
                name: "port",
                label: "Port",
                sublabel: "Port for Nextcloud Talk",
                type: "Integer",
                required: true,
                default: 443,
              },
              {
                name: "system_username",
                label: "System username",
                sublabel:
                  "An account name on the Nextcloud used for generic access.",
                type: "String",
                required: true,
              },
              {
                name: "system_password",
                label: "System user password",
                sublabel: "Password for the system username.",
                type: "String",
                required: true,
              },
            ],
          }),
      },
    ],
  });
const onLoad = async (cfg) => {
  if (!cfg) return;
  let { url, turn_port, system_username, system_password } = cfg;
  talk = new NextcloudTalk({
    server: url,
    user: system_username,
    pass: system_password,
    port: turn_port,
    debug: true,
  });
  talk.start(500);
  talk.on("Error", (e) => {
    console.error("Error Event ", e);
  });

  // Debug
  talk.on("Debug", (e) => {
    console.log("Debug Event ", e);
  });
  await new Promise((resolve, reject) => {
    talk.on("Ready", (listofrooms1) => {
      listofrooms = listofrooms1;
      resolve();
    });
  });

  if (!cluster.isMaster) return;

  /*const { broker_url, subscribe_channels, is_json } = cfg;
    if (client) await client.end();
    const broker_url1 = broker_url.includes("://")
      ? broker_url
      : `mqtt://${broker_url}`;
    client = mqtt.connect(broker_url1, { reconnectPeriod: 1000 });
    client.on("connect", function () {
      for (channel of subscribe_channels.split(","))
        client.subscribe(channel.trim());
    });
    client.on("message", function (topic, message) {
      //console.log("MQTT", topic, message);
      const payload = is_json
        ? JSON.parse(message.toString())
        : message.toString();
      Trigger.emitEvent("MqttReceive", topic, null, payload);
    });*/
};

module.exports = {
  sc_plugin_api_version: 1,
  configuration_workflow,
  onLoad,
  actions: ({ url, turn_port, system_username, system_password } = {}) => ({
    nextcloud_talk_send: {
      configFields: [
        {
          name: "room",
          label: "Room",
          type: "String",
          sublabel: "Room name or display name",
        },
        {
          name: "text",
          label: "Message text",
          type: "String",
          sublabel:
            "Use interpolations (<code>{{ }}</code>) to access row variables",
        },
      ],
      run: async ({ row, user, configuration: { room, text } }) => {
        const the_room = listofrooms.find(
          (r) => r.name === room || r.displayName === room
        );
        if (!the_room) {
          //console.error(`Room ${room} not found`);

          throw new Error(`Room ${room} not found`);
        } else {
          let text1 = row ? interpolate(text, row, user) : text;

          talk.SendMessage(the_room.token, text1);
        }
      },
    },
  }),
  eventTypes: () => ({
    NextCloudTalkReceive: {
      hasChannel: true,
    },
  }),
};
