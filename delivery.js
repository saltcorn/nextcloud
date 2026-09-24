/*
 * Reliable delivery: resolve → send with retries (idempotent via referenceId)
 * → on final failure call the configured fallback. Never throws; always
 * returns a result object.
 */
const crypto = require("crypto");
const talk = require("./talk");
const { TalkError } = require("./client");

// stable reference id for part n of a split message
const partReference = (ref, i) =>
  i === 0 ? ref : crypto.createHash("sha256").update(`${ref}:${i}`).digest("hex");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Tiny markdown subset for fallback e-mails: links, bold, italics, line breaks
const textToHtml = (text) =>
  escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>\n");

const splitText = (text, max) => {
  const s = String(text);
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
};

// outcome of the request unknown → the message may have arrived
const outcomeUnknown = (e) => ["timeout", "network", "server", "invalid_response"].includes(e?.code);

const errInfo = (e) =>
  e instanceof TalkError
    ? e.toJSON()
    : { code: "internal", message: e?.message || String(e), retryable: false };

class Delivery {
  constructor({ client, directory, log, fallback, options = {} }) {
    this.c = client;
    this.dir = directory;
    this.log = log || (() => {});
    this.fallback = fallback; // async (payload) => any
    this.opts = {
      retries: 3,
      retryDelayMs: 2000,
      groupMode: "direct", // "direct": 1:1 to every member
      joinOpenRooms: false,
      ...options,
    };
  }

  // Resolve a recipient into concrete target rooms
  async targets(recipient) {
    const resolved = await this.dir.resolve(recipient);
    const { kind, entry } = resolved;
    if (kind === "room") {
      if (entry.isParticipant === false) {
        if (this.opts.joinOpenRooms && entry.listable) {
          const room = await talk.joinListedRoom(this.c, entry.token);
          this.dir.invalidate("rooms");
          return { resolved, rooms: [{ room, label: entry.label }] };
        }
        throw new TalkError(
          "not_member",
          `The Nextcloud account is not a member of conversation "${entry.label}". Invite it in Talk${
            entry.listable ? " or enable joining open conversations" : ""
          }.`,
        );
      }
      return { resolved, rooms: [{ room: entry, label: entry.label }] };
    }
    if (kind === "user") {
      return { resolved, rooms: [{ lazyUser: entry, label: entry.label }] };
    }
    // group
    const members = (await this.dir.groupMembers(entry.id)).filter(
      (u) => u.toLowerCase() !== String(this.c.user).toLowerCase(),
    );
    if (!members.length)
      throw new TalkError("not_found", `Group "${entry.label}" has no members`);
    return {
      resolved,
      rooms: members.map((u) => ({ lazyUser: { id: u, label: u }, label: u })),
    };
  }

  async _sendWithRetry(token, text, opts) {
    const referenceId = opts.referenceId || talk.newReferenceId();
    const { checkFirst, ...sendOpts } = opts;
    // a previous attempt may have delivered it (e.g. crash before the result was stored)
    if (checkFirst && opts.referenceId) {
      const found = await talk.findByReferenceId(this.c, token, referenceId).catch(() => null);
      if (found) return { msg: found, attempts: 0, recovered: true };
    }
    opts = sendOpts;
    let lastErr;
    const attempts = Math.max(1, +this.opts.retries || 1);
    for (let i = 1; i <= attempts; i++) {
      try {
        const msg = await talk.sendMessage(this.c, token, text, { ...opts, referenceId });
        return { msg, attempts: i };
      } catch (e) {
        lastErr = e;
        if (outcomeUnknown(e)) {
          // did it arrive anyway?
          try {
            const found = await talk.findByReferenceId(this.c, token, referenceId);
            if (found) return { msg: found, attempts: i, recovered: true };
          } catch (e2) {}
        }
        if (!e.retryable || i === attempts) break;
        await sleep(this.opts.retryDelayMs * Math.pow(3, i - 1));
      }
    }
    throw lastErr;
  }

  async _sendToTarget(t, text, opts) {
    let room = t.room;
    if (!room) room = await talk.openDirect(this.c, t.lazyUser.id);
    const max = await this.c.maxMessageLength().catch(() => 32000);
    const parts = splitText(text, max - 100);
    const baseRef = opts.referenceId || talk.newReferenceId();
    let first;
    let attempts = 0;
    for (const [i, part] of parts.entries()) {
      const partOpts =
        i === 0
          ? { ...opts, referenceId: baseRef }
          : {
              ...opts,
              threadTitle: undefined,
              threadId: first?.threadId || opts.threadId,
              referenceId: partReference(baseRef, i),
            };
      const { msg, attempts: a } = await this._sendWithRetry(room.token, part, partOpts);
      attempts += a;
      if (!first) first = msg;
    }
    return { room, message: first, parts: parts.length, attempts };
  }

  async _runFallback(payload) {
    if (!this.fallback) return { called: false };
    try {
      const r = await this.fallback(payload);
      return { called: true, ok: true, result: r };
    } catch (e) {
      this.log(`fallback failed: ${e?.message || e}`);
      return { called: true, ok: false, error: e?.message || String(e) };
    }
  }

  /*
   * One delivery attempt without fallback. Returns { out, meta }; meta is
   * needed by fallbackFor(). Never throws.
   * opts: { threadTitle, threadId, replyTo, silent, referenceId, subject, source, context }
   */
  async attempt(recipient, text, opts = {}) {
    const { subject, source, context, fallback, ...msgOpts } = opts;
    const base = { recipient, text: String(text ?? ""), subject: subject || "", source: source || "" };
    let resolved = null;
    const results = [];
    let targetErr = null;
    try {
      const t = await this.targets(recipient);
      resolved = t.resolved;
      for (const target of t.rooms) {
        try {
          const r = await this._sendToTarget(target, base.text, msgOpts);
          results.push({
            ok: true,
            label: target.label,
            token: r.room.token,
            messageId: r.message.id,
            threadId: r.message.threadId || null,
            attempts: r.attempts,
            parts: r.parts,
          });
        } catch (e) {
          results.push({ ok: false, label: target.label, user: target.lazyUser?.id, error: errInfo(e) });
        }
      }
    } catch (e) {
      targetErr = e;
    }

    const failed = results.filter((r) => !r.ok);
    const okCount = results.length - failed.length;
    const status = targetErr
      ? "error"
      : failed.length === 0
        ? "ok"
        : okCount > 0
          ? "partial"
          : "error";

    const out = {
      status,
      recipient,
      kind: resolved?.kind || null,
      label: resolved?.entry?.label || null,
      token: results.find((r) => r.ok)?.token || null,
      messageId: results.find((r) => r.ok)?.messageId || null,
      threadId: results.find((r) => r.ok)?.threadId || null,
      results,
      error: targetErr ? errInfo(targetErr) : failed[0]?.error || null,
      fallback: { called: false },
    };
    return { out, meta: { base, resolved, failed, targetErr, context } };
  }

  // Temporary problems worth another attempt later (queue decides)
  static isRetryable(out) {
    if (out.status === "ok" || out.status === "partial") return false;
    return !!out.error?.retryable || ["auth", "auth_blocked"].includes(out.error?.code);
  }

  // Run the fallback for a failed attempt. Mutates and returns out.
  async fallbackFor(out, meta, fallbackFn = this.fallback) {
    const { base, resolved, failed, targetErr, context } = meta;
    const recipient = base.recipient;
    let emails = [];
    if (targetErr) {
      if (resolved) emails = await this.dir.emailsFor(resolved);
      else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(recipient).trim()))
        emails = [String(recipient).trim()];
    } else if (resolved?.kind === "group") {
      for (const f of failed) {
        const u = await this.dir.user(f.user).catch(() => null);
        if (u?.email) emails.push(u.email);
      }
    } else if (resolved) emails = await this.dir.emailsFor(resolved);
    const payload = {
      ...base,
      html: textToHtml(base.text),
      recipient_kind: resolved?.kind || "",
      recipient_id: resolved?.entry?.id || "",
      recipient_label: resolved?.entry?.label || "",
      emails: emails.join(", "),
      email_list: emails,
      error_code: out.error?.code || "",
      error: out.error?.message || "",
      status: out.status,
      failed_users: failed.map((f) => f.user).filter(Boolean),
      context: context || null,
    };
    const saved = this.fallback;
    this.fallback = fallbackFn;
    try {
      out.fallback = { ...(await this._runFallback(payload)), emails };
    } finally {
      this.fallback = saved;
    }
    if (out.fallback.called && out.fallback.ok) out.status = out.status === "partial" ? "partial" : "fallback";
    return out;
  }

  /*
   * Synchronous delivery: attempt(s) with in-process retries, then fallback.
   * send(recipient, text, { threadTitle, threadId, replyTo, silent, subject,
   *                         source, context, fallback: true|false })
   */
  async send(recipient, text, opts = {}) {
    const { out, meta } = await this.attempt(recipient, text, opts);
    if (out.status !== "ok" && opts.fallback !== false) await this.fallbackFor(out, meta);
    this.log(`send to "${recipient}": ${out.status}${out.error ? " – " + out.error.message : ""}`);
    return out;
  }
}

module.exports = { Delivery, textToHtml, splitText, escapeHtml };
