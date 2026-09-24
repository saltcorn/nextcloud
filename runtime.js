/*
 * Per-tenant runtime of the plugin (client, directory, delivery, worker, …).
 * Shared by index.js and the other modules; also used by the live tests.
 */
const db = require("@saltcorn/data/db");

const runtimes = {};
const tenant = () => db.getTenantSchema?.() || "public";

const getCtx = () => {
  const rt = runtimes[tenant()];
  if (!rt) throw new Error("Nextcloud plugin is not configured");
  return rt;
};

module.exports = { runtimes, tenant, getCtx };
