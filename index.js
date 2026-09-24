const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Trigger = require("@saltcorn/data/models/trigger");
const db = require("@saltcorn/data/db");
const { interpolate } = require("@saltcorn/data/utils");
const { getState } = require("@saltcorn/data/db/state");

const { NextcloudClient } = require("./client");
const { Directory } = require("./directory");
const { Delivery } = require("./delivery");
const { Poller } = require("./poller");
const { OutboxWorker } = require("./outbox");
const outboxStore = require("./outbox-store");
const talk = require("./talk");

const log = (level, msg) => {
  try {
    getState().log(level, `Nextcloud: ${msg}`);
  } catch (e) {}
};

// ---------- per-tenant runtime ----------

const { runtimes, tenant, getCtx } = require("./runtime");

const buildRuntime = (cfg) => {
  const client = new NextcloudClient({
    host: cfg.host,
    port: cfg.port,
    user: cfg.system_username,
    password: cfg.system_password,
    timeout: (+cfg.timeout_s || 20) * 1000,
    log: (m) => log(5, m),
  });
  const directory = new Directory(client, { log: (m) => log(4, m) });
  const options = { groupMode: "direct", joinOpenRooms: !!cfg.join_open_rooms };
  // synchronous path (send_now, agents): in-process retries + fallback
  const delivery = new Delivery({
    client,
    directory,
    log: (m) => log(4, m),
    fallback: cfg.fallback_action ? (payload) => runAction(cfg.fallback_action, payload) : null,
    options: { ...options, retries: 3 },
  });
  // queue path: one attempt per run, the queue retries with backoff
  const queueDelivery = new Delivery({
    client,
    directory,
    log: (m) => log(4, m),
    options: { ...options, retries: 1 },
  });
  return { cfg, client, directory, delivery, queueDelivery, poller: null, worker: null, lock: null };
};

// Run a trigger by name with a row (fallback, on_result). Throws if it cannot run.
const runAction = async (triggerName, row, user) => {
  // state cache first; database if the trigger was created after the last refresh
  const trigger =
    (await Trigger.findOne({ name: triggerName })) ||
    (await Trigger.findDB({ name: triggerName }))[0];
  if (!trigger) throw new Error(`Action "${triggerName}" not found`);
  // Saltcorn only logs an unknown action and returns undefined – that must not count as success
  const runnable =
    ["Workflow", "Multi-step action"].includes(trigger.action) ||
    getState().actions[trigger.action] ||
    (await Trigger.findOne({ name: trigger.action }));
  if (!runnable)
    throw new Error(`Action "${triggerName}": action type "${trigger.action}" is not available`);
  log(4, `running action ${triggerName} for ${row.recipient}`);
  return await trigger.runWithoutRow({ row, user });
};

// Synchronous delivery (waits for Nextcloud). Not for code behind a save button.
const deliverNow = async (recipient, text, opts = {}) => {
  const rt = getCtx();
  const { fallback_action, user, on_result_action, ...rest } = opts;
  if (fallback_action && fallback_action !== rt.cfg.fallback_action) {
    const d = new Delivery({
      client: rt.client,
      directory: rt.directory,
      log: (m) => log(4, m),
      fallback: (p) => runAction(fallback_action, p, user),
      options: rt.delivery.opts,
    });
    return await d.send(recipient, text, rest);
  }
  return await rt.delivery.send(recipient, text, rest);
};

const safeJSON = (v) => {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch (e) {
    return null;
  }
};

/*
 * Queue a job. Never blocks on Nextcloud and never throws: one insert into the
 * outbox table (inside the caller's transaction). If the table is not there
 * yet (first seconds after installation), delivery runs detached in memory.
 */
const queueJob = async (job, detachedFallback) => {
  const reference_id = talk.newReferenceId();
  try {
    const id = await outboxStore.enqueue({ reference_id, ...job });
    if (id) return { status: "queued", queueId: id, referenceId: reference_id };
  } catch (e) {
    log(2, `could not queue ${job.job} for "${job.recipient}": ${e.message}`);
  }
  if (detachedFallback) {
    setImmediate(() =>
      Promise.resolve()
        .then(detachedFallback)
        .then((r) => log(3, `detached ${job.job} to "${job.recipient}": ${r?.status}`))
        .catch((e) => log(1, `detached ${job.job} to "${job.recipient}" crashed: ${e?.message || e}`)),
    );
    return { status: "pending", queueId: null, referenceId: reference_id };
  }
  return { status: "error", queueId: null, error: { code: "no_queue", message: "Outbox not available" } };
};

const queueSend = async (recipient, text, opts = {}) => {
  const { subject, source, context, on_result_action, user, ...msgOpts } = opts;
  const r = await queueJob(
    {
      job: "send",
      recipient: String(recipient ?? ""),
      text: String(text ?? ""),
      options_json: safeJSON({ ...msgOpts, subject }),
      context_json: safeJSON(context),
      source: source || "",
      on_result_action: on_result_action || "",
    },
    () => deliverNow(recipient, text, opts),
  );
  return { recipient, messageId: null, threadId: null, token: null, error: null, ...r };
};

const queueThreadOp = async (jobType, conversation, threadRef, extra = {}) => {
  const ref = String(threadRef ?? "").trim();
  const isOutbox = /^outbox:\d+$/.test(ref);
  return await queueJob({
    job: jobType,
    recipient: String(conversation ?? ""),
    text: extra.message || extra.emoji || "",
    options_json: safeJSON({
      thread_id: isOutbox ? undefined : +ref || undefined,
      thread_ref: isOutbox ? ref : undefined,
      message_id: extra.message_id,
      emoji: extra.emoji,
    }),
    source: extra.source || "",
    on_result_action: extra.on_result_action || "",
  });
};

// ---------- background worker: outbox + listener, one process per tenant ----------

const isServerProcess = () => process.argv.includes("serve");

const watchFilter = (cfg) => {
  const spec = (cfg.listen_rooms || "").trim();
  if (!spec) return null;
  if (spec === "*") return () => true;
  const names = spec.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return (room) =>
    [room.token, room.name, room.displayName].some((v) => v && names.includes(String(v).toLowerCase()));
};

const LOCK_KEY = (ten) => `saltcorn-nextcloud-listener:${ten}`;

const acquireLock = async (rt, ten) => {
  if (db.isSQLite) return true;
  if (rt.lock) return true;
  let client;
  try {
    client = await db.getClient();
    const { rows } = await client.query("select pg_try_advisory_lock(hashtext($1)) as ok", [LOCK_KEY(ten)]);
    if (rows[0]?.ok) {
      rt.lock = client;
      return true;
    }
    client.release();
  } catch (e) {
    log(2, `worker lock failed: ${e.message}`);
    try {
      client?.release();
    } catch (e2) {}
  }
  return false;
};

const releaseLock = async (rt, ten) => {
  if (!rt?.lock) return;
  try {
    await rt.lock.query("select pg_advisory_unlock(hashtext($1))", [LOCK_KEY(ten)]);
  } catch (e) {}
  try {
    rt.lock.release();
  } catch (e) {}
  rt.lock = null;
};

const startWorker = (rt, ten) => {
  if (!isServerProcess()) return;
  const filter = watchFilter(rt.cfg);
  const keyword = (rt.cfg.filter_keyword || "").trim().toLowerCase();
  const tryStart = async () => {
    if (runtimes[ten] !== rt) return; // configuration changed meanwhile
    if (!(await acquireLock(rt, ten))) {
      rt.lockTimer = setTimeout(tryStart, 30 * 1000);
      rt.lockTimer.unref?.();
      return;
    }
    try {
      await outboxStore.ensureTable((m) => log(3, m));
      rt.worker = new OutboxWorker({
        store: outboxStore.makeStore(),
        getCtx: () => rt,
        runAction: (name, row) => runAction(name, row),
        log: (m) => log(3, m),
        maxAttempts: +rt.cfg.retries || 4,
        keepDays: rt.cfg.keep_days === 0 || rt.cfg.keep_days === "0" ? 0 : +rt.cfg.keep_days || 30,
      });
      rt.worker.start();
      log(3, `outbox worker started in process ${process.pid}`);
    } catch (e) {
      log(1, `outbox worker could not start: ${e.message}`);
    }
    if (!filter) return;
    log(3, `listener started in process ${process.pid}`);
    rt.poller = new Poller({
      client: rt.client,
      intervalMs: (+rt.cfg.poll_interval_s || 5) * 1000,
      includeSystem: !!rt.cfg.include_system,
      shouldWatch: filter,
      log: (m) => log(3, m),
      onMessage: async (m, room) => {
        if (keyword && !String(m.text || "").toLowerCase().includes(keyword)) return;
        const payload = {
          ...m,
          raw: undefined,
          room_token: room.token,
          room_name: room.name,
          room_label: room.displayName,
          room_type: room.type,
        };
        const withTenant = (f) => (db.runWithTenant ? db.runWithTenant(ten, f) : f());
        await withTenant(async () => {
          Trigger.emitEvent("NextcloudTalkMessage", room.name, null, payload);
          // legacy event of plugin versions ≤ 0.2.6, raw Talk message as payload
          Trigger.emitEvent("NextCloudTalkReceive", room.name, null, m.raw);
        });
        rt.adapter?._dispatch(m, room);
      },
    });
    rt.poller.start();
  };
  // do not compete with startup
  rt.lockTimer = setTimeout(tryStart, 3000);
  rt.lockTimer.unref?.();
};

const stopRuntime = async (ten) => {
  const rt = runtimes[ten];
  if (!rt) return;
  if (rt.lockTimer) clearTimeout(rt.lockTimer);
  rt.poller?.stop();
  rt.worker?.stop();
  await releaseLock(rt, ten);
};

// ---------- plugin lifecycle ----------

const onLoad = async (cfg) => {
  const ten = tenant();
  await stopRuntime(ten);
  if (!cfg?.host || !cfg?.system_username) {
    delete runtimes[ten];
    return;
  }
  try {
    const rt = buildRuntime(cfg);
    rt.adapter = require("./adapter")(getCtx);
    runtimes[ten] = rt;
    startWorker(rt, ten);
  } catch (e) {
    // never break Saltcorn startup because of Nextcloud
    log(1, `configuration error: ${e.message}`);
  }
};

const health = async () => {
  const rt = getCtx();
  const here = isServerProcess() ? "worker runs in another process" : "not a server process";
  const out = {
    status: "ok",
    server: rt.client.baseUrl,
    user: rt.cfg.system_username,
    worker: rt.worker ? { process: process.pid, ...rt.worker.status } : { state: here },
    listener: rt.poller ? { process: process.pid, ...rt.poller.status } : { state: rt.worker ? "disabled" : here },
  };
  try {
    out.outbox = await outboxStore.makeStore().counts();
  } catch (e) {
    out.outbox = `unavailable (${e.message})`;
  }
  try {
    const caps = await rt.client.capabilities(true);
    out.nextcloud = caps.nextcloud;
    out.talk = caps.talk;
    out.threads = caps.features.has("threads");
    const users = await rt.directory.users(true).then((u) => u.length).catch((e) => `unavailable (${e.code})`);
    out.users = users;
  } catch (e) {
    out.status = "error";
    out.error = { code: e.code, message: e.message };
  }
  return out;
};

// ---------- configuration ----------

const connectionTestBlurb = async (context) => {
  try {
    const c = new NextcloudClient({
      host: context.host,
      port: context.port,
      user: context.system_username,
      password: context.system_password,
    });
    const caps = await c.capabilities(true);
    let dirInfo = "";
    try {
      const d = new Directory(c);
      dirInfo = `, ${(await d.users()).length} users visible`;
    } catch (e) {
      dirInfo = e.code === "forbidden" ? ", user list not visible (account needs admin or group subadmin rights for search)" : "";
    }
    return `<div class="alert alert-success">Connected to Nextcloud ${caps.nextcloud}, Talk ${caps.talk}${
      caps.features.has("threads") ? " with threads" : ""
    }${dirInfo}.</div>`;
  } catch (e) {
    return `<div class="alert alert-danger">Connection test failed: ${String(e.message)
      .replace(/</g, "&lt;")
      .slice(0, 300)}</div>`;
  }
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Nextcloud connection",
        form: () =>
          new Form({
            fields: [
              {
                name: "host",
                label: "Host",
                sublabel: "Nextcloud host name, optionally with https:// and path",
                type: "String",
                required: true,
              },
              {
                name: "port",
                label: "Port",
                type: "Integer",
                default: 443,
              },
              {
                name: "system_username",
                label: "Username",
                sublabel: "Nextcloud account used to send and receive",
                type: "String",
                required: true,
              },
              {
                name: "system_password",
                label: "Password",
                sublabel: "An app password is recommended (Nextcloud: Settings → Security)",
                input_type: "password",
                type: "String",
                required: true,
              },
              {
                name: "timeout_s",
                label: "Request timeout (s)",
                type: "Integer",
                default: 20,
              },
            ],
          }),
      },
      {
        name: "Delivery",
        form: async (context) => {
          const triggers = await Trigger.find({});
          return new Form({
            blurb: await connectionTestBlurb(context),
            fields: [
              {
                name: "fallback_action",
                label: "Fallback action",
                sublabel:
                  "Trigger run when a message cannot be delivered via Talk. Its row contains recipient, text, html, subject, emails, email_list, error, error_code, source, context",
                type: "String",
                attributes: { options: ["", ...triggers.map((t) => t.name)] },
              },
              {
                name: "retries",
                label: "Attempts",
                sublabel: "Attempts for temporary errors (after 10 s, 1 min, 5 min, …) before the fallback runs",
                type: "Integer",
                default: 4,
              },
              {
                name: "keep_days",
                label: "Keep outbox entries (days)",
                sublabel: "Finished entries of the table NextcloudTalkOutbox are deleted after this many days; 0: keep",
                type: "Integer",
                default: 30,
              },
              {
                name: "join_open_rooms",
                label: "Join open conversations",
                sublabel: "Automatically join listable conversations the account is not a member of when sending there",
                type: "Bool",
              },
              {
                name: "closed_prefix",
                label: "Closed thread prefix",
                sublabel: "Prefix added to the title of closed threads",
                type: "String",
                default: talk.DEFAULT_CLOSED_PREFIX,
              },
            ],
          });
        },
      },
      {
        name: "Receiving",
        form: () =>
          new Form({
            blurb:
              "Messages in watched conversations raise the event <code>NextcloudTalkMessage</code> (channel: conversation name). Only conversations the account is a member of can be watched.",
            fields: [
              {
                name: "listen_rooms",
                label: "Watch conversations",
                sublabel: "Names, display names or tokens, comma separated; <code>*</code> for all; empty: off",
                type: "String",
              },
              {
                name: "filter_keyword",
                label: "Filter keyword",
                sublabel: "Only raise events for messages containing this text",
                type: "String",
              },
              {
                name: "poll_interval_s",
                label: "Poll interval (s)",
                type: "Integer",
                default: 5,
              },
              {
                name: "include_system",
                label: "Include system messages",
                type: "Bool",
              },
            ],
          }),
      },
    ],
  });

// ---------- helpers for actions ----------

const interp = (s, row, user) => (s && row ? interpolate(s, row, user) : s);

const actionResult = (r) => {
  const out = {
    talk_status: r.status,
    talk_message_id: r.messageId,
    talk_thread_id: r.threadId,
    talk_token: r.token,
    talk_queue_id: r.queueId || null,
    talk_thread_ref: r.queueId ? `outbox:${r.queueId}` : null,
  };
  if (r.status === "error") out.error = `Nextcloud Talk: ${r.error?.message || "delivery failed"}`;
  return out;
};

const tokenFor = async (conversation) => {
  const rt = getCtx();
  const { kind, entry } = await rt.directory.resolve(conversation);
  if (kind === "room") return entry.token;
  if (kind === "user") return (await talk.openDirect(rt.client, entry.id)).token;
  throw new Error(`"${conversation}" is a group, not a conversation`);
};

// ---------- exports ----------

const tableProviders = require("./table-provider")(getCtx);
const AgentSkill = require("./agent-skill")(getCtx);

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "nextcloud",
  configuration_workflow,
  onLoad,
  // with a configuration_workflow Saltcorn calls every export as function of the configuration
  table_providers: () => tableProviders,
  exchange: () => ({
    agent_skills: [AgentSkill],
    chat_adapters: [
      {
        id: "nextcloud-talk",
        label: "Nextcloud Talk",
        get: () => getCtx().adapter,
      },
    ],
  }),
  eventTypes: () => ({
    NextcloudTalkMessage: { hasChannel: true },
    NextCloudTalkReceive: { hasChannel: true },
  }),
  functions: () => ({
    nextcloud_talk_send: {
      run: async (recipient, text, opts) => await queueSend(recipient, text, opts || {}),
      isAsync: true,
      description:
        "Queue a Talk message to a user, group or conversation. Returns immediately, never blocks, never throws: {status: queued, queueId}. Options: {threadTitle, threadId, replyTo, silent, subject, fallback_action, on_result_action, context}",
      arguments: [
        { name: "recipient", type: "String" },
        { name: "text", type: "String" },
        { name: "options", type: "JSON" },
      ],
    },
    nextcloud_talk_send_now: {
      run: async (recipient, text, opts) => await deliverNow(recipient, text, opts || {}),
      isAsync: true,
      description:
        "Send synchronously and wait for Nextcloud (retries, fallback). Blocks – only for background code and agents, never behind a button. Returns {status: ok|partial|fallback|error, messageId, threadId, token, error}",
      arguments: [
        { name: "recipient", type: "String" },
        { name: "text", type: "String" },
        { name: "options", type: "JSON" },
      ],
    },
    nextcloud_talk_outbox_status: {
      run: async (queueId) => await outboxStore.makeStore().get(+queueId),
      isAsync: true,
      description: "State of a queued job (row of table NextcloudTalkOutbox)",
      arguments: [{ name: "queue_id", type: "Integer" }],
    },
    nextcloud_talk_find: {
      run: async (query, opts) => await getCtx().directory.search(query, opts || {}),
      isAsync: true,
      description: "Search users, groups and conversations. Options: {types, fuzzy, limit}",
      arguments: [
        { name: "query", type: "String" },
        { name: "options", type: "JSON" },
      ],
    },
    nextcloud_talk_resolve: {
      run: async (recipient) => await getCtx().directory.resolve(recipient),
      isAsync: true,
      description: "Resolve a recipient exactly (no guessing). Returns {kind, entry}",
      arguments: [{ name: "recipient", type: "String" }],
    },
    nextcloud_talk_directory: {
      run: async (types) =>
        await getCtx().directory.all({ types: types ? [].concat(types) : undefined }),
      isAsync: true,
      description: "All users, groups and conversations. Optional types: user, group, room",
      arguments: [{ name: "types", type: "JSON" }],
    },
    nextcloud_talk_open_direct: {
      run: async (userId) => await talk.openDirect(getCtx().client, userId),
      isAsync: true,
      description: "Get or create the 1:1 conversation with a user",
      arguments: [{ name: "user_id", type: "String" }],
    },
    nextcloud_talk_messages: {
      run: async (conversation, opts) => (await talk.getMessages(getCtx().client, await tokenFor(conversation), opts || {})).messages,
      isAsync: true,
      description: "Messages of a conversation. Options: {after, before, limit, threadId, includeSystem}",
      arguments: [
        { name: "conversation", type: "String" },
        { name: "options", type: "JSON" },
      ],
    },
    nextcloud_talk_threads: {
      run: async (conversation) => await talk.listThreads(getCtx().client, await tokenFor(conversation)),
      isAsync: true,
      description: "Recent threads of a conversation",
      arguments: [{ name: "conversation", type: "String" }],
    },
    nextcloud_talk_close_thread: {
      run: async (conversation, threadId, message) =>
        await queueThreadOp("close_thread", conversation, threadId, { message, source: "function" }),
      isAsync: true,
      description:
        "Queue closing a thread (final message, title prefix, notifications off). thread_id may be a number or outbox:<queueId> of the job that created the thread",
      arguments: [
        { name: "conversation", type: "String" },
        { name: "thread_id", type: "String" },
        { name: "message", type: "String" },
      ],
    },
    nextcloud_talk_reopen_thread: {
      run: async (conversation, threadId, message) =>
        await queueThreadOp("reopen_thread", conversation, threadId, { message, source: "function" }),
      isAsync: true,
      description: "Queue reopening a closed thread",
      arguments: [
        { name: "conversation", type: "String" },
        { name: "thread_id", type: "String" },
        { name: "message", type: "String" },
      ],
    },
    nextcloud_talk_react: {
      run: async (conversation, messageId, emoji) =>
        await queueThreadOp("react", conversation, "", { message_id: +messageId, emoji, source: "function" }),
      isAsync: true,
      description: "Queue a reaction to a message",
      arguments: [
        { name: "conversation", type: "String" },
        { name: "message_id", type: "Integer" },
        { name: "emoji", type: "String" },
      ],
    },
    nextcloud_talk_participants: {
      run: async (conversation) => await talk.getParticipants(getCtx().client, await tokenFor(conversation)),
      isAsync: true,
      description: "Participants of a conversation",
      arguments: [{ name: "conversation", type: "String" }],
    },
    nextcloud_talk_health: {
      run: health,
      isAsync: true,
      description: "Connection, worker, listener and outbox status",
      arguments: [],
    },
    // legacy names of plugin versions ≤ 0.2.6
    nextcloud_get_rooms: {
      run: async () => (await getCtx().directory.rooms(true)).filter((r) => r.isParticipant).map((r) => r.raw),
      isAsync: true,
      description: "Conversations of the account (raw Talk objects)",
      arguments: [],
    },
    nextcloud_reconnect: {
      run: async () => {
        const rt = getCtx();
        rt.client.authBlockedUntil = 0;
        rt.directory.invalidate();
        return await health();
      },
      isAsync: true,
      description: "Reset caches and a paused login, then report status",
      arguments: [],
    },
  }),
  actions: () => ({
    nextcloud_talk_send: {
      description: "Send a Nextcloud Talk message with fallback",
      configFields: async () => {
        const triggers = await Trigger.find({});
        return [
          {
            name: "room",
            label: "Recipient",
            type: "String",
            required: true,
            sublabel:
              "User id, group id, conversation name or token; prefix <code>user:</code>, <code>group:</code>, <code>room:</code> to be explicit. Interpolations <code>{{ }}</code> allowed",
          },
          {
            name: "text",
            label: "Message text",
            type: "String",
            fieldview: "textarea",
            required: true,
            sublabel: "Markdown; interpolations <code>{{ }}</code> access row variables",
          },
          { name: "thread_title", label: "Start thread with title", type: "String", sublabel: "Optional, interpolations allowed" },
          { name: "thread_id", label: "Post into thread id", type: "String", sublabel: "Optional, e.g. <code>{{ talk_thread_id }}</code>" },
          { name: "silent", label: "Silent (no notification)", type: "Bool" },
          { name: "subject", label: "Subject for fallback", type: "String", sublabel: "Passed to the fallback action, interpolations allowed" },
          {
            name: "fallback_action",
            label: "Fallback action",
            type: "String",
            sublabel: "Overrides the fallback action from the plugin configuration",
            attributes: { options: ["", ...triggers.map((t) => t.name)] },
          },
          {
            name: "on_result_action",
            label: "On result action",
            type: "String",
            sublabel:
              "Optional trigger run after delivery with queue_id, status, token, message_id, thread_id, error and context (the triggering row), e.g. to store the thread id",
            attributes: { options: ["", ...triggers.map((t) => t.name)] },
          },
        ];
      },
      // queued: returns immediately, never blocks the caller
      run: async ({ row, user, configuration }) => {
        const { room, text, thread_title, thread_id, silent, subject, fallback_action, on_result_action } = configuration;
        const r = await queueSend(interp(room, row, user), interp(text, row, user), {
          threadTitle: interp(thread_title, row, user) || undefined,
          threadId: +interp(thread_id, row, user) || undefined,
          silent: !!silent,
          subject: interp(subject, row, user),
          source: "action",
          context: row || null,
          fallback_action: fallback_action || undefined,
          on_result_action: on_result_action || undefined,
        });
        return actionResult(r);
      },
    },
    nextcloud_talk_close_thread: {
      description: "Close a Nextcloud Talk thread",
      configFields: [
        { name: "room", label: "Conversation", type: "String", required: true, sublabel: "Name, token or user id; interpolations allowed" },
        {
          name: "thread_id",
          label: "Thread",
          type: "String",
          required: true,
          sublabel: "Thread id, or <code>outbox:&lt;queue id&gt;</code> of the send job that created the thread (e.g. <code>{{ talk_thread_ref }}</code>)",
        },
        { name: "message", label: "Closing message", type: "String", sublabel: "Optional" },
      ],
      // queued: returns immediately, never blocks the caller
      run: async ({ row, user, configuration: { room, thread_id, message } }) => {
        const r = await queueThreadOp("close_thread", interp(room, row, user), interp(thread_id, row, user), {
          message: interp(message, row, user),
          source: "action",
        });
        return { talk_status: r.status, talk_queue_id: r.queueId, ...(r.status === "error" ? { error: `Nextcloud Talk: ${r.error?.message}` } : {}) };
      },
    },
  }),
};
