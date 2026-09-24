/*
 * Read-only virtual tables: Nextcloud users, groups and Talk conversations.
 */
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");

const ENTITIES = {
  Users: [
    { name: "id", label: "User ID", type: "String", primary_key: true },
    { name: "label", label: "Display name", type: "String" },
    { name: "email", label: "E-mail", type: "String" },
    { name: "groups", label: "Groups", type: "String" },
    { name: "enabled", label: "Enabled", type: "Bool" },
  ],
  Groups: [
    { name: "id", label: "Group ID", type: "String", primary_key: true },
    { name: "label", label: "Display name", type: "String" },
    { name: "userCount", label: "Members", type: "Integer" },
  ],
  Conversations: [
    { name: "token", label: "Token", type: "String", primary_key: true },
    { name: "label", label: "Name", type: "String" },
    { name: "name", label: "Internal name", type: "String" },
    { name: "type", label: "Type", type: "String" },
    { name: "isParticipant", label: "Member", type: "Bool" },
    { name: "unreadMessages", label: "Unread", type: "Integer" },
    { name: "description", label: "Description", type: "String" },
  ],
};

const matches = (row, where) => {
  for (const [k, v] of Object.entries(where || {})) {
    const val = row[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v.ilike !== undefined) {
        if (!String(val ?? "").toLowerCase().includes(String(v.ilike).toLowerCase())) return false;
      } else if (v.in) {
        if (!v.in.includes(val)) return false;
      }
      continue;
    }
    if (String(val ?? "") !== String(v ?? "")) return false;
  }
  return true;
};

module.exports = (getCtx) => ({
  "Nextcloud directory": {
    configuration_workflow: () =>
      new Workflow({
        steps: [
          {
            name: "Entity",
            form: () =>
              new Form({
                fields: [
                  {
                    name: "entity_type",
                    label: "Entity type",
                    type: "String",
                    required: true,
                    attributes: { options: Object.keys(ENTITIES) },
                  },
                ],
              }),
          },
        ],
      }),
    fields: (cfgTable) => ENTITIES[cfgTable?.entity_type] || ENTITIES.Users,
    get_table: (cfgTable) => {
      const load = async () => {
        const { directory } = getCtx();
        switch (cfgTable?.entity_type) {
          case "Groups":
            return await directory.groups();
          case "Conversations":
            return await directory.rooms();
          default:
            return (await directory.users()).map((u) => ({ ...u, groups: (u.groups || []).join(", ") }));
        }
      };
      const query = async (where, opts = {}) => {
        const fields = (ENTITIES[cfgTable?.entity_type] || ENTITIES.Users).map((f) => f.name);
        let rows = (await load())
          .filter((r) => matches(r, where))
          .map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
        if (opts.orderBy && fields.includes(opts.orderBy)) {
          const dir = opts.orderDesc ? -1 : 1;
          rows.sort((a, b) => dir * String(a[opts.orderBy] ?? "").localeCompare(String(b[opts.orderBy] ?? "")));
        }
        if (opts.offset) rows = rows.slice(opts.offset);
        if (opts.limit) rows = rows.slice(0, opts.limit);
        return rows;
      };
      return {
        getRows: query,
        countRows: async (where) => (await query(where)).length,
      };
    },
  },
});
