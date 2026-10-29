# Pi Coding Agent (experimental)

Riftjack runs Pi as a local RPC subprocess, with a separate persistent session
for each conversation. This adapter targets the **Pi 1.4+ interface in the 1.x
series**, distributed as `@earendil-works/pi-coding-agent`. It requires
`--session-id`, `get_state`, extension UI dialogs and `agent_settled`. The older
`@mariozechner/pi-coding-agent` 0.x package is not supported by this adapter.

## Setup

Install Pi independently, then log in using the same OS user and HOME as the
connector:

```sh
npm install -g @earendil-works/pi-coding-agent@1.4.0
pi --version
pi
```

Inside Pi, use `/login` and choose a provider. For a Kimi Code subscription,
select **Kimi Code**, complete browser authorization, then choose its model
with `/model`. A subscription to the Kimi chat product does not by itself
establish coding access. Riftjack uses Pi's stored credentials; it does not
import tokens from another agent or forward connector secrets to Pi.

In the instance `.env`:

```dotenv
PI_PATH=pi
PI_MODEL=
PI_APPROVAL_POLICY=on-request
```

`PI_PATH` selects the executable, and `PI_MODEL` optionally selects a
provider/model identifier. Blank model uses Pi's configured default.
Run `npm --prefix riftjack run bootstrap:pi` for a new installation, or tell
Bot Manager:

```text
create a Pi bot called Builder in projects/demo
```

The normal workspace confirmation applies. The manager checks the Pi executable
and version before creating an account. `set model bot Builder to MODEL` and
`reset model bot Builder` apply to the next task. Pi has no Riftjack service-tier
or reasoning setting in this adapter.

## Conversation behavior

- Text and images are sent through RPC; other attachments are supplied as local
  paths, with available transcription metadata.
- Sessions are stored below `DATA_DIR/pi-sessions/`, separated by conversation
  key. A missing saved session is reported rather than silently replaced.
- `!reset` starts a new conversation; it does not delete saved files.
- `!cancel` expires pending confirmations and signals Pi to stop its tools.
  On POSIX, Riftjack also terminates Pi's private process group and escalates
  to SIGKILL for remaining group members. Pi cleans up its detached bash
  groups on SIGTERM. This does not undo completed edits or external actions,
  and cannot guarantee cleanup of commands that independently detach again.
- Messages received during a task queue as follow-ups. Live RPC steering is
  deliberately not used until consumption can be tracked across recovery.
- `!status` shows the configured model and last session report. Pi account quota
  reporting through `!usage` is not implemented.
- Completion waits for `agent_settled`, not the intermediate `agent_end` event.
  Only the last assistant message is returned; tool preambles are excluded so
  exact replies such as `NO_REPLY` remain intact.
  Unexpected process exits are errors; uncertain actions are not auto-replayed
  by the adapter. Connector recovery can redeliver an interrupted task, so inspect
  existing results before repeating external actions.

## Tools and approvals

The connector explicitly loads `pi-extension.mjs`, disables discovered extensions,
MCP configuration, skills, prompt templates and themes, and waits for its readiness
handshake before sending the task. The handshake uses an RPC `setStatus`
record with a per-launch nonce, followed by verification of the session ID;
ordinary extension stdout and CLI stderr are not treated as readiness. Project context files remain available.
The extension selects read/search tools plus, for writable bots, bash/write/edit.
Every bash, write and edit call asks for confirmation in Matrix, including its
arguments. `!deny`, cancellation, unavailable interaction, or an oversized request
blocks the call. No remembered blanket approvals are granted. With
`PI_APPROVAL_POLICY=never`, those tools are disabled. Read-only configuration also
disables them.

This gate is **not an operating-system sandbox**: Pi and approved shell commands
run with the connector OS user's privileges. It does not constrain the effects
of an approved command or protect against modifications to the installed adapter.
Use a dedicated OS user/container when filesystem or network isolation is needed.

Riftjack's background tasks, GitHub subscriptions, linked
room messages, attachment delivery and reviewed publication are exposed through
turn-local tool connections. Existing permission checks and owner confirmations
remain in their handlers. Tools from user/project MCP configuration are not automatically imported.
Knowledge and room notes are not part of upstream main and are not included here.
Web-fetch and draw.io tools are not connected by this adapter yet.

## Verification scope

The adapter has regression tests for readiness, session validation, final text,
model failures, approval denial and POSIX descendant cancellation. An optional
HTTP test uses an installed Pi with an isolated configuration and a localhost
model fixture. It exercises actual RPC startup, approved and denied bash tools,
conversation resume, final reply handling and cancellation without external
provider credentials:

```sh
RIFTJACK_TEST_PI=/absolute/path/to/pi node --import tsx --test test/http/pi-live.test.ts
```

This test passed with Pi 1.4.0. An authenticated external model and an end-to-end
Matrix conversation have not yet been verified. Protocol references:

- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)
- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

Implementation was compared with upstream source commit
`6c384aa30f619d7b28963f2bab24d8dacbe73cb6` (package version 1.4.0).
