# @saltcorn/nextcloud

Nextcloud Talk for Saltcorn: reliable sending with fallback, direct messages,
threads, directory search, chat monitoring, an agent skill and a chat adapter.

Nothing has to be installed on the Nextcloud server. The plugin uses the normal
REST API with one Nextcloud account (an app password is recommended). No
dependencies besides Node ≥ 18.

## Configuration

1. **Connection**: host, port, username, password. The next step shows a live
   connection test.
2. **Delivery**
   - *Fallback action*: a trigger that is run when a message cannot be
     delivered via Talk (see below).
   - *Attempts*: attempts for temporary errors (timeouts, 5xx, 429) before the
     fallback runs, spaced 10 s, 1 min, 5 min, 15 min, … Retries are
     idempotent: a Talk `referenceId` prevents duplicates.
   - *Keep outbox entries*: finished queue entries are deleted after N days.
   - *Join open conversations*: allow sending into listable conversations the
     account is not yet a member of.
   - *Closed thread prefix*: default `✅ `.
3. **Receiving**: conversations to watch (`*` for all), keyword filter, poll
   interval.

## Outbox: nothing ever blocks the caller

Every writing operation (send, close/reopen thread, react) is written to the
table **NextcloudTalkOutbox** and returns immediately (a few milliseconds, no
network). The plugin creates this table on demand. The insert happens inside the
caller's transaction: if the save is rolled back, the message is dropped too.

One worker process per tenant (the same PostgreSQL advisory lock as the listener)
drains the queue every 2 s:

`queued → sending → sent | partial | fallback | failed`

- Temporary errors are retried with backoff; the fallback runs after the last
  attempt. Permanent errors (unknown recipient, no access) go to the fallback
  immediately.
- Jobs stuck in `sending` after a crash are picked up again. The stable
  `referenceId` is checked first, so a message is never sent twice.
- Circuit breaker: after a temporary failure the rest of the round waits, so an
  outage does not make every job run into its timeout.
- Threads created by a queued message are referenced as `outbox:<queueId>`
  (`talk_thread_ref` in the action result). A close job waits for the job that
  creates the thread.
- *On result action* (per send action or option `on_result_action`): a trigger
  run after the job finished with `queue_id, status, token, message_id,
  thread_id, error, error_code, context`, e.g. to store the thread id on your
  row.
- Rows are written with `db.insert/update` for speed (Saltcorn's `insertRow`
  costs about 300 ms). So Saltcorn table triggers on NextcloudTalkOutbox do
  not fire; use *On result action*.

If the table does not exist yet (the first seconds after installation), a send is
delivered detached in memory and the result is `pending`.

`nextcloud_talk_send_now` is the synchronous variant (waits for Nextcloud,
in-process retries and fallback). Use it only in background code and agents,
never behind a button.

## Recipients

Wherever a recipient is expected you can use a conversation token, conversation
name, user id, user e-mail, user display name, group id or group name
(case-insensitive). Prefix with `user:`, `group:` or `room:` to be explicit.
Resolution is strict: ambiguous or unknown recipients are reported, never
guessed. Unknown recipients get "did you mean" suggestions from the fuzzy
search.

- **User**: the 1:1 conversation is used, or created if it does not exist.
- **Group**: every member gets a direct message.
- **Conversation**: the account must be a member.

## Fallback

Whenever delivery fails (Talk unreachable, conversation not accessible, unknown
recipient, …) the fallback action is run with this row:

| field | content |
|---|---|
| `recipient`, `recipient_kind`, `recipient_id`, `recipient_label` | requested and resolved recipient |
| `text`, `html`, `subject` | message as markdown and as simple HTML |
| `emails`, `email_list` | e-mail addresses of the user, of all group members or of all conversation participants (comma separated / array) |
| `error`, `error_code`, `status` | reason |
| `source`, `context` | caller and the triggering row (actions) |

Example: an *insert_any_row* trigger that writes `{to: emails, subject, body: html}`
into your mail queue table, or a `send_email` step. The plugin itself never sends
e-mail.

## Actions

Both actions only queue and return immediately.

- `nextcloud_talk_send`: recipient, text (interpolations `{{ }}`), optional
  thread title (starts a thread), thread id, silent, subject, fallback override,
  on result action. Returns `talk_status` (`queued`), `talk_queue_id` and
  `talk_thread_ref` (`outbox:<id>`) into the workflow context.
- `nextcloud_talk_close_thread`: conversation, thread (id or `outbox:<id>`),
  closing message.

## Functions

`nextcloud_talk_send` never blocks and never throws. It returns
`{status: "queued", queueId, referenceId, error: null}`.

| function | purpose |
|---|---|
| `nextcloud_talk_send(recipient, text, {threadTitle, threadId, replyTo, silent, subject, fallback_action, on_result_action, context})` | queue a message |
| `nextcloud_talk_send_now(recipient, text, options)` | send synchronously (blocks; background code only) |
| `nextcloud_talk_outbox_status(queueId)` | state of a queued job |
| `nextcloud_talk_find(query, {types, fuzzy, limit})` | search users, groups, conversations |
| `nextcloud_talk_resolve(recipient)` | strict resolution |
| `nextcloud_talk_directory(types)` | full directory |
| `nextcloud_talk_open_direct(userId)` | get/create 1:1 conversation |
| `nextcloud_talk_messages(conversation, {after, before, limit, threadId})` | read messages |
| `nextcloud_talk_threads(conversation)` | recent threads |
| `nextcloud_talk_close_thread(conversation, thread, message)` / `nextcloud_talk_reopen_thread` | queue thread state change (`thread`: id or `outbox:<id>`) |
| `nextcloud_talk_react(conversation, messageId, emoji)` | queue a reaction |
| `nextcloud_talk_participants(conversation)` | participants |
| `nextcloud_talk_health()` | connection, worker, listener and outbox status |
| `nextcloud_get_rooms()`, `nextcloud_reconnect()` | legacy names |

## Threads

Threads are created by sending with a thread title and answered with the thread
id. Talk has no "closed" state for threads. Closing posts an optional final
message, prefixes the title (default `✅ `) and mutes the thread for the
account. The title is the only state, so nothing is stored in Saltcorn.

## Events

- `NextcloudTalkMessage` (channel: conversation name) with a normalized message:
  `id, token, threadId, authorId, authorName, text, date, replyTo, room_token,
  room_name, room_label, room_type, …`
- `NextCloudTalkReceive`: legacy event with the raw Talk message.

The listener polls the conversation list with `modifiedSince` (one request per
interval while nothing happens) and only fetches changed conversations. The
account's Talk read marker is the watermark. It is advanced only after the event
was raised, so restarts do not lose messages (at-least-once: use the message
`id` to de-duplicate). Exactly one process per tenant polls; this is guarded by a
PostgreSQL advisory lock, and another process takes over when it stops. Listening
runs only in `saltcorn serve`. Do not log in to the plugin's account interactively
while it is listening, because that moves the read marker.

## Table provider

*Nextcloud directory*: read-only tables for Users, Groups and Conversations,
usable in normal list and filter views.

## Agents and chat adapters

- `exchange.agent_skills`: skill *Nextcloud Talk* for `@saltcorn/agents` with the
  tools `talk_find`, `talk_read`, `talk_send` (only if allowed, optional recipient
  whitelist) and `talk_close_thread` (only if allowed).
- `exchange.chat_adapters`: `{id: "nextcloud-talk", get()}` returns an adapter
  implementing a tool-independent chat contract (conversations, messages,
  threads, reactions, contacts, subscribe). See `adapter.js`.

## Permissions

Searching users and groups needs admin rights or group subadmin rights for the
account. Without them, search covers conversations only. Sending, threads and
listening only need a normal account.

## Tests

`npm test` (`jest tests --runInBand`) runs the unit tests in `tests/*.test.js`.
They need neither a Nextcloud nor credentials: `tests/fake-nextcloud.js` emulates
the Talk and provisioning API, including faults (errors, timeouts, lost
responses). With the Saltcorn harness: `saltcorn dev:plugin-test -d <plugin dir>`.

`tests/live/` contains development scripts against a real Nextcloud and a real
Saltcorn database (they send real messages and, for the fallback tests, real
e-mail). They are not run by `npm test`; see the header of each file.
