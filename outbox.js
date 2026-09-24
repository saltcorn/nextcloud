/*
 * Outbox worker: persistent job queue for all writing Talk operations.
 *
 * Callers only insert a row (milliseconds, no network) and never wait.
 * One worker process (advisory lock holder) drains the queue:
 *   queued → sending → sent | partial | fallback | failed
 * Temporary errors are retried with backoff; after the last attempt, or on a
 * permanent error, the fallback runs. Rows stuck in "sending" (crash) are
 * re-queued; the stable referenceId prevents duplicate messages.
 *
 * Storage is injected (see outbox-store.js), which keeps this file testable.
 *   store.due(limit) / store.update(id, patch) / store.get(id)
 *   store.requeueStale(olderThanMs) / store.cleanup(olderThanDays)
 */
const talk = require("./talk");
const { Delivery } = require("./delivery");

const BACKOFF_S = [10, 60, 300, 900, 1800];
const FINAL = ["sent", "partial", "fallback", "failed"];

const parseJSON = (s, def) => {
  if (s === null || s === undefined || s === "") return def;
  if (typeof s === "object") return s;
  try {
    return JSON.parse(s);
  } catch (e) {
    return def;
  }
};

class OutboxWorker {
  constructor({ store, getCtx, runAction, log, intervalMs = 2000, maxAttempts = 4, keepDays = 30 }) {
    this.store = store;
    this.getCtx = getCtx; // () => { client, directory, delivery, cfg }
    this.runAction = runAction; // async (triggerName, row) => result, used for fallback + on_result
    this.log = log || (() => {});
    this.intervalMs = intervalMs;
    this.maxAttempts = Math.max(1, +maxAttempts || 4);
    this.keepDays = keepDays;
    this.running = false;
    this.timer = null;
    this.lastCleanup = 0;
    this.status = { state: "stopped", lastRun: null, lastError: null, processed: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.status.state = "running";
    this._schedule(500);
  }

  stop() {
    this.running = false;
    this.status.state = "stopped";
    if (this.timer) clearTimeout(this.timer);
  }

  _schedule(ms) {
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), ms);
    this.timer.unref?.();
  }

  async _tick() {
    if (!this.running) return;
    try {
      await this.runOnce();
      this.status.lastError = null;
    } catch (e) {
      this.status.lastError = { message: e?.message || String(e), at: new Date().toISOString() };
      this.log(`outbox error: ${e?.message || e}`);
    }
    this._schedule(this.intervalMs);
  }

  async runOnce() {
    this.status.lastRun = new Date().toISOString();
    await this.store.requeueStale(5 * 60 * 1000);
    const jobs = await this.store.due(20);
    for (const job of jobs) {
      if (!this.running) return;
      const r = await this.process(job);
      this.status.processed++;
      // circuit breaker: a temporary failure means Nextcloud is in trouble – stop this round
      if (r === "retry") break;
    }
    if (Date.now() - this.lastCleanup > 3600 * 1000) {
      this.lastCleanup = Date.now();
      if (this.keepDays > 0) await this.store.cleanup(this.keepDays);
    }
  }

  async _finish(job, patch, result) {
    const row = { ...patch, done_at: new Date() };
    await this.store.update(job.id, row);
    if (job.on_result_action) {
      try {
        await this.runAction(job.on_result_action, {
          queue_id: job.id,
          job: job.job,
          recipient: job.recipient,
          context: parseJSON(job.context_json, null),
          ...row,
          result: result || null,
        });
      } catch (e) {
        this.log(`on_result_action ${job.on_result_action} failed for job ${job.id}: ${e?.message || e}`);
      }
    }
  }

  async _retryOrFail(job, attempts, error, onFinal) {
    if (attempts < this.maxAttempts) {
      const delay = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)];
      await this.store.update(job.id, {
        status: "queued",
        attempts,
        next_attempt_at: new Date(Date.now() + delay * 1000),
        error: error?.message || "",
        error_code: error?.code || "",
      });
      this.log(`job ${job.id} (${job.job}) attempt ${attempts} failed (${error?.code}), retry in ${delay}s`);
      return "retry";
    }
    await onFinal();
    return "final";
  }

  async process(job) {
    const attempts = (+job.attempts || 0) + 1;
    if (!(await this.store.claim(job.id, attempts))) return "skipped"; // taken by someone else
    try {
      if (job.job === "send") return await this._send(job, attempts);
      if (["close_thread", "reopen_thread", "react"].includes(job.job)) return await this._threadOp(job, attempts);
      await this._finish(job, { status: "failed", error: `unknown job type ${job.job}`, error_code: "bad_request" });
    } catch (e) {
      // unexpected: never lose the job, retry later
      return await this._retryOrFail(job, attempts, { code: "internal", message: e?.message || String(e) }, () =>
        this._finish(job, { status: "failed", error: e?.message || String(e), error_code: "internal" }),
      );
    }
  }

  async _send(job, attempts) {
    // retries are done by the queue, so one in-process attempt only
    const { queueDelivery: delivery } = this.getCtx();
    const opts = parseJSON(job.options_json, {});
    const context = parseJSON(job.context_json, null);
    const { out, meta } = await delivery.attempt(job.recipient, job.text, {
      ...opts,
      referenceId: job.reference_id,
      // tried before (retry or crash recovery): look for the message before sending again
      checkFirst: attempts > 1,
      source: job.source,
      context,
    });
    const done = {
      token: out.token,
      message_id: out.messageId,
      thread_id: out.threadId,
      error: out.error?.message || "",
      error_code: out.error?.code || "",
      result_json: JSON.stringify({ kind: out.kind, label: out.label, results: out.results }),
    };
    if (out.status === "ok") return await this._finish(job, { ...done, status: "sent" }, out);

    const runFallback = async () => {
      const fbName = opts.fallback_action || this.getCtx().cfg.fallback_action;
      const fbFn = fbName ? (payload) => this.runAction(fbName, payload) : null;
      if (fbFn && opts.fallback !== false) await delivery.fallbackFor(out, meta, fbFn);
      const status =
        out.status === "partial" ? "partial" : out.fallback?.called && out.fallback?.ok ? "fallback" : "failed";
      await this._finish(
        job,
        {
          ...done,
          status,
          fallback_info: out.fallback?.called
            ? `${out.fallback.ok ? "ok" : "failed: " + out.fallback.error} → ${(out.fallback.emails || []).join(", ") || "no e-mail"}`
            : "no fallback configured",
        },
        out,
      );
    };
    if (Delivery.isRetryable(out)) return await this._retryOrFail(job, attempts, out.error, runFallback);
    return await runFallback();
  }

  async _threadOp(job, attempts) {
    const { client, directory, cfg } = this.getCtx();
    const opts = parseJSON(job.options_json, {});
    let threadId = +opts.thread_id || null;
    let token = null;
    // thread from another outbox job: "outbox:<id>"
    const dep = String(opts.thread_ref || "").match(/^outbox:(\d+)$/);
    if (dep) {
      const other = await this.store.get(+dep[1]);
      if (!other) return await this._finish(job, { status: "failed", error: `outbox job ${dep[1]} not found`, error_code: "not_found" });
      if (!FINAL.includes(other.status)) {
        // wait for the job that creates the thread; does not count as attempt
        await this.store.update(job.id, { status: "queued", attempts: attempts - 1, next_attempt_at: new Date(Date.now() + 5000) });
        return;
      }
      if (!other.thread_id && !other.message_id)
        return await this._finish(job, { status: "failed", error: `outbox job ${other.id} has no thread (${other.status})`, error_code: "dependency" });
      threadId = other.thread_id || other.message_id;
      token = other.token;
    }
    try {
      if (!token) {
        const { kind, entry } = await directory.resolve(job.recipient);
        token = kind === "room" ? entry.token : kind === "user" ? (await talk.openDirect(client, entry.id)).token : null;
        if (!token) throw Object.assign(new Error(`"${job.recipient}" is a group, not a conversation`), { code: "bad_request" });
      }
      let res;
      const prefix = cfg.closed_prefix || talk.DEFAULT_CLOSED_PREFIX;
      if (job.job === "close_thread") res = await talk.closeThread(client, token, threadId, { message: job.text || undefined, prefix });
      else if (job.job === "reopen_thread") res = await talk.reopenThread(client, token, threadId, { message: job.text || undefined, prefix });
      else res = await talk.react(client, token, +opts.message_id || threadId, opts.emoji || job.text);
      return await this._finish(job, { status: "sent", token, thread_id: threadId, error: "", error_code: "" }, res);
    } catch (e) {
      const err = { code: e.code || "internal", message: e.message, retryable: !!e.retryable };
      const fail = () => this._finish(job, { status: "failed", token, thread_id: threadId, error: err.message, error_code: err.code });
      if (err.retryable || ["auth", "auth_blocked"].includes(err.code)) return await this._retryOrFail(job, attempts, err, fail);
      return await fail();
    }
  }
}

module.exports = { OutboxWorker, BACKOFF_S, FINAL, parseJSON };
