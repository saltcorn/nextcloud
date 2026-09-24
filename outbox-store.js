/*
 * Outbox storage in a regular Saltcorn table (created on demand, like
 * @saltcorn/agents does for its memory table). Admin-only by default; admins
 * can build views on it or hang their own triggers on it.
 */
const Table = require("@saltcorn/data/models/table");
const Field = require("@saltcorn/data/models/field");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { FINAL } = require("./outbox");

const TABLE = "NextcloudTalkOutbox";

const FIELDS = [
  ["job", "Job", "String"], // send | close_thread | reopen_thread | react
  ["status", "Status", "String"], // queued | sending | sent | partial | fallback | failed
  ["recipient", "Recipient", "String"],
  ["text", "Text", "String"],
  ["options_json", "Options (JSON)", "String"],
  ["context_json", "Context (JSON)", "String"],
  ["source", "Source", "String"],
  ["reference_id", "Reference ID", "String"],
  ["on_result_action", "On result action", "String"],
  ["attempts", "Attempts", "Integer"],
  ["created_at", "Created at", "Date"],
  ["next_attempt_at", "Next attempt at", "Date"],
  ["claimed_at", "Claimed at", "Date"],
  ["done_at", "Done at", "Date"],
  ["token", "Conversation token", "String"],
  ["message_id", "Message ID", "Integer"],
  ["thread_id", "Thread ID", "Integer"],
  ["error_code", "Error code", "String"],
  ["error", "Error", "String"],
  ["fallback_info", "Fallback", "String"],
  ["result_json", "Result (JSON)", "String"],
];

// Find the table without creating it (safe in any process, any transaction)
const findTable = async () => {
  const cached = Table.findOne({ name: TABLE });
  if (cached) return cached;
  const found = await Table.find({ name: TABLE });
  return found[0] || null;
};

// Create table and missing fields. Only called by the single worker process.
const ensureTable = async (log) => {
  let table = await findTable();
  if (!table) {
    table = await Table.create(TABLE, {
      description: "Queue of the Nextcloud plugin: every Talk write operation, its state and result",
    });
    log?.(`created table ${TABLE}`);
  }
  const existing = new Set((table.getFields ? table.getFields() : table.fields || []).map((f) => f.name));
  let added = false;
  for (const [name, label, type] of FIELDS) {
    if (existing.has(name)) continue;
    await Field.create({ table, name, label, type, required: false });
    added = true;
  }
  if (added || !Table.findOne({ name: TABLE })) await getState().refresh_tables();
  return (await findTable()) || table;
};

/*
 * Rows are read and written through the database layer (db.insert/update/
 * select) instead of table.insertRow: in Saltcorn 1.6 insertRow costs about
 * 300 ms CPU per call, db.insert about 3 ms. Consequence: Saltcorn table
 * triggers on this table do not fire – use on_result_action instead.
 * db.* runs inside the caller's transaction when there is one.
 */
const makeStore = () => ({
  async due(limit) {
    return await db.select(
      TABLE,
      { status: "queued", next_attempt_at: { lt: new Date() } },
      { orderBy: "id", limit },
    );
  },
  async get(id) {
    return (await db.select(TABLE, { id }))[0] || null;
  },
  async update(id, patch) {
    await db.update(TABLE, patch, id);
  },
  // atomic: only one worker can move a job from queued to sending
  async claim(id, attempts) {
    const { rows } = await db.query(
      `update ${db.getTenantSchemaPrefix()}"${TABLE}" set status = 'sending', claimed_at = now(), attempts = $2
       where id = $1 and status = 'queued' returning id`,
      [id, attempts],
    );
    return rows.length === 1;
  },
  async requeueStale(olderThanMs) {
    const stale = await db.select(TABLE, {
      status: "sending",
      claimed_at: { lt: new Date(Date.now() - olderThanMs) },
    });
    for (const row of stale) await db.update(TABLE, { status: "queued", next_attempt_at: new Date() }, row.id);
  },
  async cleanup(olderThanDays) {
    await db.deleteWhere(TABLE, {
      status: { in: FINAL },
      done_at: { lt: new Date(Date.now() - olderThanDays * 86400 * 1000) },
    });
  },
  async counts() {
    const { rows } = await db.query(
      `select status, count(*)::int as n from ${db.getTenantSchemaPrefix()}"${TABLE}" group by status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  },
});

// Insert a job. Fast, no network. Runs inside the caller's transaction, so a
// rolled back save also drops the message (transactional outbox).
let tableKnown = false;
const enqueue = async (job) => {
  if (!tableKnown) {
    if (!(await findTable())) return null;
    tableKnown = true;
  }
  const now = new Date();
  return await db.insert(TABLE, {
    status: "queued",
    attempts: 0,
    created_at: now,
    next_attempt_at: now,
    ...job,
  });
};

module.exports = { TABLE, ensureTable, findTable, makeStore, enqueue };
