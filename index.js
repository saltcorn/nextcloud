const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Trigger = require("@saltcorn/data/models/trigger");
const cluster = require("cluster");
const NextcloudTalk = require("@saltcorn/nctalkclient");
const { interpolate } = require("@saltcorn/data/utils");
let talk;
let listofrooms;
const configuration_workflow = () =>
  new Workflow({
    onDone: async (cfg) => {
      if (talk) talk.removeAllListeners();
      await onLoad(cfg);
      return cfg;
    },
    steps: [
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
              {
                name: "listen_rooms",
                label: "Listen to rooms",
                sublabel:
                  "Separate by commas if more than one, <code>*</code> for all. Will create event NextCloudTalkReceive with room name as channel",
                type: "String",
              },
              {
                name: "filter_keyword",
                label: "Filter keyword",
                sublabel: "Only generate events if message had this keyword,",
                type: "String",
              },
            ],
          }),
      },
    ],
  });
const onLoad = async (cfg) => {
  if (!cfg) return;
  if (talk) return;
  let {
    host,
    turn_port,
    system_username,
    system_password,
    listen_rooms,
    filter_keyword,
  } = cfg;
  if (!host) return;

  talk = new NextcloudTalk({
    server: host.replace("https://", "").replace("http://", ""),
    user: system_username,
    pass: system_password,
    port: turn_port,
    //debug: true,
  });

  let runOnError;
  talk.start(500);
  talk.on("Error", (e) => {
    console.error("Error Event ", e);
    if (runOnError) {
      runOnError(e);
      runOnError = null;
    }
  });

  // Debug
  talk.on("Debug", (e) => {
    console.log("Debug Event ", e);
  });

  const processMsg = (room) => (msg) => {
    const msgs = Array.isArray(msg) ? msg : [msg];
    msgs.forEach((m) => {
      if (!filter_keyword || (m.message || "").includes(filter_keyword))
        Trigger.emitEvent("NextCloudTalkReceive", room, null, m);
    });
  };

  if (!cluster.isMaster || !listen_rooms) {
    await new Promise((resolve, reject) => {
      runOnError = reject;
      talk.on("Ready", (listofrooms1) => {
        listofrooms = listofrooms1;
        runOnError = null;
        resolve();
      });
    });
  } else {
    talk.on("Ready", (listofrooms1) => {
      listofrooms = listofrooms1;

      if (listen_rooms.trim() === "*")
        listofrooms.forEach((r) => {
          talk.RoomListenMode(r.token, true);
          talk.on("Message_" + r.token, processMsg(r.name));
        });
      else
        listen_rooms.split(",").forEach((rnm) => {
          const room = rnm.trim();
          const the_room = listofrooms.find(
            (r) => r.name === room || r.displayName === room
          );
          if (!the_room) return;
          talk.RoomListenMode(the_room.token, true);
          talk.on("Message_" + the_room.token, processMsg(the_room.name));
        });
    });
  }
};

module.exports = {
  sc_plugin_api_version: 1,
  configuration_workflow,
  onLoad,
  actions: () => ({
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
