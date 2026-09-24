/*
 * Minimal, dependency-free OCS client for Nextcloud (Talk + provisioning).
 *
 * Every call either resolves with { status, headers, data } or rejects with a
 * TalkError carrying a stable `code` and a `retryable` flag. Nothing is
 * swallowed.
 */

class TalkError extends Error {
  constructor(code, message, { status, retryable, details } = {}) {
    super(message);
    this.name = "TalkError";
    this.code = code;
    this.status = status;
    this.retryable = !!retryable;
    this.details = details;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

const codeForStatus = (status) => {
  switch (status) {
    case 400:
      return ["bad_request", false];
    case 401:
      return ["auth", false];
    case 403:
      return ["forbidden", false];
    case 404:
      return ["not_found", false];
    case 412:
      return ["precondition", false];
    case 413:
      return ["too_large", false];
    case 429:
      return ["rate_limited", true];
    default:
      if (status >= 500) return ["server", true];
      return ["http_" + status, false];
  }
};

// After a failed login we stop talking to the server for a while, otherwise
// Nextcloud's brute force protection throttles the whole IP.
const AUTH_BLOCK_MS = 10 * 60 * 1000;

const normalizeBaseUrl = (host, port) => {
  let h = String(host || "").trim().replace(/\/+$/, "");
  if (!h) throw new TalkError("config", "No Nextcloud host configured");
  let proto = "https";
  const m = h.match(/^(https?):\/\/(.*)$/i);
  if (m) {
    proto = m[1].toLowerCase();
    h = m[2];
  } else if (+port === 80) proto = "http";
  const [hostPart, ...pathParts] = h.split("/");
  const hasPort = /:\d+$/.test(hostPart);
  const defaultPort = proto === "https" ? 443 : 80;
  const portPart =
    !hasPort && port && +port !== defaultPort ? `:${+port}` : "";
  const path = pathParts.length ? "/" + pathParts.join("/") : "";
  return `${proto}://${hostPart}${portPart}${path}`;
};

class NextcloudClient {
  constructor({ host, port, user, password, timeout = 20000, log } = {}) {
    this.baseUrl = normalizeBaseUrl(host, port);
    this.user = user;
    this.timeout = timeout;
    this.log = log || (() => {});
    this.authHeader =
      "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
    this.authBlockedUntil = 0;
    this._caps = null;
    this._capsAt = 0;
  }

  async request(method, path, { query, body, timeout, raw } = {}) {
    if (Date.now() < this.authBlockedUntil)
      throw new TalkError(
        "auth_blocked",
        "Login to Nextcloud failed recently; requests paused to avoid brute force lockout. Check credentials and save the plugin configuration again.",
      );
    const url = new URL(this.baseUrl + path);
    url.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, typeof v === "boolean" ? +v : v);
    }
    const headers = {
      Authorization: this.authHeader,
      "OCS-APIRequest": "true",
      Accept: "application/json",
      "User-Agent": "saltcorn-nextcloud",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const ms = timeout || this.timeout;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new TalkError(
        isTimeout ? "timeout" : "network",
        isTimeout
          ? `Nextcloud did not answer within ${ms} ms (${method} ${path})`
          : `Nextcloud not reachable: ${e?.cause?.code || e?.message}`,
        { retryable: true },
      );
    }

    const text = await res.text();
    let json;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (e) {
        if (res.ok)
          throw new TalkError(
            "invalid_response",
            `Nextcloud returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
            { status: res.status, retryable: true },
          );
      }
    }
    const hdrs = Object.fromEntries(res.headers.entries());

    if (res.status === 304) return { status: 304, headers: hdrs, data: null };
    if (!res.ok) {
      if (res.status === 401)
        this.authBlockedUntil = Date.now() + AUTH_BLOCK_MS;
      const [code, retryable] = codeForStatus(res.status);
      const ocsMsg = json?.ocs?.meta?.message;
      const dataErr = json?.ocs?.data?.error || json?.ocs?.data?.message;
      throw new TalkError(
        code,
        `${method} ${path} → ${res.status}${ocsMsg ? ": " + ocsMsg : ""}${
          dataErr ? " (" + dataErr + ")" : ""
        }`,
        { status: res.status, retryable, details: json?.ocs?.data },
      );
    }
    if (raw) return { status: res.status, headers: hdrs, data: json };
    return { status: res.status, headers: hdrs, data: json?.ocs?.data };
  }

  get(path, opts) {
    return this.request("GET", path, opts);
  }
  post(path, body, opts) {
    return this.request("POST", path, { ...opts, body });
  }
  put(path, body, opts) {
    return this.request("PUT", path, { ...opts, body });
  }
  del(path, opts) {
    return this.request("DELETE", path, opts);
  }

  async capabilities(force) {
    if (!force && this._caps && Date.now() - this._capsAt < 3600 * 1000)
      return this._caps;
    const { data } = await this.get("/ocs/v2.php/cloud/capabilities");
    const spreed = data?.capabilities?.spreed;
    if (!spreed)
      throw new TalkError(
        "no_talk",
        "Nextcloud Talk (spreed) is not installed or not enabled for this user",
      );
    this._caps = {
      nextcloud: data.version?.string,
      talk: spreed.version,
      features: new Set(spreed.features || []),
      config: spreed.config || {},
    };
    this._capsAt = Date.now();
    return this._caps;
  }

  async hasFeature(f) {
    return (await this.capabilities()).features.has(f);
  }

  async maxMessageLength() {
    return (await this.capabilities()).config?.chat?.["max-length"] || 32000;
  }
}

module.exports = { NextcloudClient, TalkError, normalizeBaseUrl };
