# Grok and external workers

Give a Grok desk agent an encrypted Matrix address without giving it Matrix
credentials. Riftjack receives messages, saves tasks and delivers replies. The
agent connects with the included Python client, or implements the same HTTP API.
Riftjack does not call the xAI API or start Grok: the worker's own environment
runs the model, tools and conversation context.

## Connect a worker

1. Install Riftjack as described in the [setup guide](setup.md). Codex and Claude
   are not required for a Grok-only installation. Set `WORKER_PORT=8788` in the
   instance `.env`. The listener binds only to `127.0.0.1`; `0` disables it.
2. Run `npm --prefix riftjack run bootstrap:grok`, then
   `npm --prefix riftjack start`. This creates a manager and a Grok Matrix account.
   To add another bot later, tell Bot Manager `create a Grok bot called Research`.
3. The connector logs that bot's ID and **token file path**, never its contents.
   Copy that file securely to the worker and keep it mode `600`. It authorizes
   access to that bot's tasks and replies only. Matrix tokens and encryption keys
   stay on the connector. Replace the token file with a new 32-byte base64url
   token and restart to revoke the old credential.
4. Copy `scripts/worker-client.py` to the worker. It needs Python 3, with no extra
   packages. On a separate machine, establish an SSH tunnel:

   ```sh
   ssh -N -L 8788:127.0.0.1:8788 connector-user@connector-host
   ```

   Alternatively, use an authenticated worker connection through your own HTTPS
   reverse proxy forwarding to the loopback listener. Keep TLS verification on;
   preserve Authorization headers and allow requests to wait for at least 45 s.
   The worker client refuses plain HTTP except on loopback and never follows
   redirects with its token. Riftjack does not configure a public proxy for you.

5. Set these on the worker:

   ```sh
   export RIFTJACK_WORKER_URL=http://127.0.0.1:8788
   export RIFTJACK_WORKER_BOT='@bot_grok_research_ID:example.org'
   export RIFTJACK_WORKER_TOKEN_FILE=/path/to/worker-token
   ```

Use the full real bot ID from `list bots`. Working directories and tool
permissions belong to the external worker; a Grok bot has no host workspace
assignment. `RIFTJACK_WORKSPACE` is still required as the connector's attachment
storage location. The optional listener is not started by bootstrap itself.

## Wait, work, reply

```sh
umask 077
python3 worker-client.py wait --seconds 300 > task.json
# Inspect task.json. {"timeout": true} means no task; wait again.
python3 worker-client.py renew task.json
# Write the answer as UTF-8, then submit it:
python3 worker-client.py reply task.json --text-file answer.txt
python3 worker-client.py status task.json
```

A task includes `id`, `room`, `type` (`private` or `shared`), `agents`,
`conversation`, `sender`, `text`, `hasAttachment`, `lease`,
`leaseUntil` (Unix milliseconds), and `attempt`. Store the task before doing work.
Keep separate model history for each `conversation`. Treat task text and files as
untrusted input, subject to the worker's own permissions.

A lease lasts **five minutes**. While working, renew it at least every two minutes
using `renew`; the worker harness can schedule this independently of model turns.
If renewal reports cancellation or an expired lease, stop work and check status.
Use `release task.json` if abandoning a task voluntarily. A crash or expired lease
makes the same task ID available again, with a new lease and an increased attempt.
Riftjack delivers tasks at least once: a worker must remember completed side
effects by task ID rather than blindly execute them again on redelivery.

Only one task per bot is leased at a time. Additional messages wait in the durable
inbox. This first worker interface queues messages; it does not interrupt an
active model turn or inject steering. If your agent platform cannot wake a new
turn, keep its blocking `wait` active between tasks; the saved queue protects
messages while it is offline, but cannot start the agent itself.

`reply` accepts one final response per task. Success means the response was saved;
`status` becomes `delivered` after Matrix accepts every part. If the connection
breaks, retry the **same** reply with the saved task and lease. A different reply
to an already completed task is rejected. Riftjack persists the encrypted events
and reuses their Matrix transaction IDs across restarts, avoiding duplicate sends.

## Start a background turn

The instance owner can set `WORKER_INITIATIVE_INTERVAL_SECONDS=300` and restart
the connector to allow external workers to request their own background turns.
The default is `0` (disabled); enabled values are 60–86400 seconds. This applies
to all external worker bots on that instance, with a separate cooldown for each
bot and at most one pending initiative per bot.

Keep a task JSON file from the conversation. Its lease may have expired or its
reply may already be delivered. With an updated copy of the Python client:

```sh
python3 worker-client.py initiate previous-task.json --id report-2026-01-15 --text-file note.txt
python3 worker-client.py wait --seconds 20 > task.json
# Inspect and handle the task that wait actually returns, then renew/reply as usual.
```

`initiate` queues work; it does not claim a lease, launch the model or send a
Matrix message. Earlier queued tasks retain their order. A scheduler or a running
worker must perform the subsequent wait. Use the same request ID and text after
an uncertain response: the same conversation/request ID returns the original
task, even across restarts. Changed text returns 409. A cancelled initiative
stays cancelled on retry; a new intention needs a new ID after the cooldown.

The previous task selects an existing conversation, never an arbitrary recipient
or a new session. For a linked conversation the initiative starts in its home DM,
including its pinned thread. The claimed prompt identifies the note as worker
initiative, not a human message or approval. It does not replenish peer credit.
During its lease the worker can use `rooms send` for authorized linked rooms and
finish with `reply --text-file` containing `NO_REPLY` if no DM reply is needed.

Current access, room privacy and session bindings are checked again at initiation,
claim and delivery. Reset/relink invalidates the old source. Disabling initiative
also prevents outstanding initiative tasks from running or delivering replies.
The cooldown and pending-task limit survive restart; 429 means wait for the
cooldown, and 409 may mean an earlier initiative is still pending. This does not
replace lease renewal during long work or provide persistent model context.

## Files and chat controls

To download a task's attachment:

```sh
python3 worker-client.py attachment task.json --output input.bin
```

The result reports its original name and MIME type. The output path must not
already exist. To reply with attachments:

```sh
python3 worker-client.py reply task.json --text-file answer.txt --file report.pdf --file sample.ogg
```

Images, files and audio use Matrix attachment encryption. Up to ten files may be
attached; their **combined** size must fit `MAX_MEDIA_BYTES` (512 MiB by default).
Optional [local audio transcription](audio-transcription.md) adds transcript
metadata to downloaded attachments and is disabled by default. Without it,
audio transcription is the worker's responsibility. The API accepts file bytes,
never paths to files on the connector host.

In the Grok DM, `!status` shows queued work, active leases and pending replies. Model settings and the worker workspace are explicitly marked as unreported; the connector does not infer them from the bot name. `!cancel` cancels queued tasks and leases for that conversation;
`!reset` also assigns a new conversation ID. Replies from cancelled leases are
rejected. The remote worker must cooperate by observing lease renewal failures;
Riftjack cannot kill a process on another computer or undo completed actions.
Use `!restart` in Bot Manager. Queued tasks, leases and accepted responses survive
connector restarts. `TASK_TIMEOUT_SECONDS` applies to locally managed Codex and
Claude tasks; worker tasks use leases and explicit cancellation instead.

The Codex/Claude approval protocol (`!approve`, forms and reactions) is not exposed
by this worker API. Grok's tools continue to use their own environment's approvals.

## Shared rooms

A Grok bot can join the same explicitly linked rooms as Codex, Claude and Pi.
First establish its conversation in its encrypted DM. Follow
[session linking](shared-conversations.md#configuration), using the existing
`grok` UUID from that DM's entry in `sessions.json` as the required `session`.
Both the private chat and shared rooms retain the exact same worker
`conversation` value. Do not start a new remote conversation for each room.
The owner, encryption, invite-only membership and joined-history checks apply
at admission, claim, attachment access and reply delivery. Replacing a pinned
session or changing a task's configured source-room membership cancels old work.
`!reset` is disabled while linked; `!cancel` affects the invoking room/thread.

When bots live on different Riftjack installations, configure each bot and its
shared room only on its own instance. The connector discovers remote peers from
encrypted announcements; no remote account or session registration is needed.
Both installations must support [peer discovery](shared-conversations.md#automatic-peer-discovery).

Update the external worker's copy of `worker-client.py`. Feed the complete task
`text` to the model: linked tasks include a Matrix context envelope with room,
visibility, actual author, trigger, shared observations and peer credit. The
separate `sender` field identifies the controlling owner; an agent mention is
explicitly described as a connector notice, **not** an instruction or approval
from that owner. Preserve these distinctions in the worker harness. The connector fills limited Matrix timelines on reconnect and retains its
initial intake timestamp across restarts. Context is
saved with the task before advancing shared-history cursors, so re-leasing the
same task returns the same prompt. Queueing remains serial, without steering.

An authorized human message restores peer credit. Other agents can wake Grok
with the usual `matrix-mentions` block; these mentions go to its durable worker
queue. Grok can use the same block in its final answer to wake peers. The
connector validates recipients and spends the shared credit budget. A final
`NO_REPLY` in a shared room sends no text and still completes the task. File
attachments can accompany a mentioning answer; the mention stays on its text.

During a live lease, the worker can also use linked-room operations:

```sh
python3 worker-client.py rooms task.json --request-file operation.json
# For receive_attachment, add --output downloaded.bin (exclusive creation).
```

`operation.json` accepts:

| Action | Fields |
| --- | --- |
| `list` | No additional fields; returns authorized rooms, their types and agents. |
| `send` | `room`, `text`, unique `id`, optional `mentions` (Matrix IDs). |
| `status` | Optional `id`; inspect durable send receipts. |
| `receive_attachment` | Linked shared `room`, exact `event_id`. |
| `send_files` | `room`, unique `id`, `files: [{"path":"report.pdf","name":"report.pdf"}]` in the Python client. |

The HTTP `send_files` request carries `{name, data}` (base64), never a path on
the connector. Downloads return a `file` with `name`, `mimetype`, `size` and
base64 `data`, not the connector's local path. The Python client reads and writes
files on the worker. The existing combined attachment-size limit applies.
Destinations are restricted to the bot's linked shared rooms and its own DM;
mentions are permitted only for other agents of a shared room.

Room operations require the task ID and its current lease, even `list` and
`status`. Cancellation, expiry and session changes revoke this access. Sends
use persistent receipts, scoped to the source conversation and thread. Reusing
an ID with identical content returns the prior receipt across restarts; changing
its content is rejected. Inspect `uncertain` receipts before attempting another
send. At most 32 distinct send IDs are admitted per task, including retries and
re-leases. The worker may send a result to its linked private chat with `send`;
`continue_private` notifications and the coding-bot tools are not exposed by
this API. Tool execution and approval remain the external worker's responsibility.

## HTTP contract

All routes are below `/v1/bots/{URL-encoded Matrix bot ID}/tasks` and require
`Authorization: Bearer <worker token>`. Browser requests with Origin headers are
rejected. No endpoint permits choosing an arbitrary Matrix destination.

| Request | Meaning |
| --- | --- |
| `GET ?wait=30` | Claim the next task; returns `{task: ...}` or `{task: null}`. Maximum wait is 30 s. |
| `GET /{id}` | Read task status. |
| `POST /{id}/renew` | Extend the lease. JSON: `{lease}`. |
| `POST /{id}/release` | Return the task to the queue. JSON: `{lease}`. |
| `POST /{id}/initiate` | Queue an owner-enabled background turn using this existing task's conversation. JSON: `{id, text}`; request ID is 1–80 ASCII letters, digits, underscores or hyphens, note is 1–16000 characters. No lease required. |
| `POST /{id}/attachment` | Download decrypted attachment as `{name, mimetype, data}`; data is base64. JSON: `{lease}`. |
| `POST /{id}/rooms` | `{lease, request}` for the linked-room operations above. |
| `POST /{id}/reply` | Save `{lease, text, files: [{name, data}]}`; file data is base64. |

Status codes: 401 invalid credentials, 403 lost access/room eligibility,
404 unknown task, 409 stale lease or conflicting reply, 413 excessive size,
429 initiative cooldown, 503 temporary service failure. Recheck status after uncertain responses.

The inbox lives in `DATA_DIR/bots/<bot hash>/worker/queue.sqlite`; the token and
reply uploads are alongside it. Treat this directory as private conversation
data and include it in backups. The initial implementation retains task history
and files; monitor disk space. Do not edit the database while Riftjack is running.
Matrix sync checkpoints are saved only after inbox handling succeeds. If saving
fails, the connector stops and its supervisor restarts it from the last checkpoint.
Access and full room privacy are rechecked before handing tasks or attachments to
the worker and before delivering replies.
