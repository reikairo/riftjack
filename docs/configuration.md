# Configuration reference

This covers every host option in [`.env.example`](../.env.example). Values are
case-sensitive unless stated otherwise. “Blank” means unset or empty; use an
empty value, not whitespace, for numeric options and paths. Relative paths are
relative to the connector's working directory unless noted. Secrets belong in
the instance configuration, outside the source repository.

Restart an idle connector after changing host options. Per-bot model overrides
instead apply on the next task, without restarting. Their precedence is: bot
override, shared host value, then CLI configuration/default. Resetting an override
restores inheritance; it does not reset conversation history.

## Models, reasoning effort and service tiers

In the manager DM:

```text
show options bot Builder
show settings bot Builder
set model bot Builder to MODEL
set reasoning bot Builder to EFFORT
set tier bot Builder to TIER
reset model bot Builder
reset reasoning bot Builder
reset tier bot Builder
```

Use a bot name or full Matrix ID. The owner or that bot's creator can use these
commands. Codex discovery queries the installed CLI/account for available model
IDs, supported efforts **for each model**, default effort and, when reported,
service tiers. It does not start a model turn or change settings. A model missing
from discovery may still be accepted by a newer CLI; Riftjack validates identifier
syntax and leaves model availability to the CLI. There is no timeless list of
model IDs or universal effort list.

Claude discovery reads the CLI initialization catalog, including model aliases,
resolved IDs and model-specific effort/Fast mode support where reported. Missing
capability metadata is shown as unknown, not replaced with an invented list.
Pi discovery reads `get_available_models`, `get_state` and
`get_available_thinking_levels`. Pi reports exact levels for the selected model;
select another model and query options again to see its levels. Discovery never
sends `set_model`, saves a conversation or sends a model prompt. Grok configuration
belongs to its external worker. See [manager commands](manager.md#model-settings).

| Option | Accepted values | Default / blank |
| --- | --- | --- |
| `CODEX_MODEL` | Model ID from `show options bot NAME` or another ID supported by the installed Codex CLI/account | Inherit CLI model |
| `CODEX_REASONING_EFFORT` | Effort identifier supported by the selected model, as reported by `show options bot NAME` | Inherit CLI effort |
| `CODEX_SERVICE_TIER` | CLI-supported tier identifier; commonly `default` (standard), `priority` (priority processing); use discovery when the CLI reports tiers | Inherit CLI tier |
| `CLAUDE_MODEL` | Claude Code aliases such as `sonnet`, `opus`, `haiku`, or an account-supported full model ID | Inherit CLI model |
| `CLAUDE_REASONING_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max`; selected model/CLI must support it | Inherit CLI effort |
| `CLAUDE_SERVICE_TIER` | `default` (Fast mode off), `fast` (request Fast mode) | Inherit CLI setting |
| `PI_MODEL` | Provider/model identifier from Pi discovery | Inherit CLI model |
| `PI_REASONING_EFFORT` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; use discovery for the selected model’s supported subset | Inherit CLI thinking level |
| `CODEX_PATH` | Executable name on PATH or path to Codex CLI | `codex` |
| `CLAUDE_PATH` | Executable name on PATH or path to Claude Code | `claude` |
| `PI_PATH` | Executable name on PATH or path to Pi CLI | `pi` |

Per-bot model, reasoning and tier identifiers are 1–128 characters: start with an
ASCII letter or digit, followed by letters, digits, `.`, `_`, `:`, `/` or `-`.
Model IDs additionally allow `[` and `]` for aliases such as `sonnet[1m]`.
Claude effort/tier and Pi effort overrides additionally use the exact lists above. Pi supports
`model` and `reasoning`, with no service tier. Saving a setting does not guarantee the account can use it; the
CLI validates availability at task start. Fast/priority service can have separate
billing or plan requirements. See [Claude Fast mode](claude.md).

## Permissions and network

These are host settings, not per-bot model commands.

| Option | Accepted values | Default / blank |
| --- | --- | --- |
| `CODEX_SANDBOX` | `workspace-write`, `read-only`; shared access intent, applied by each backend's own permission mechanism | `workspace-write` |
| `CODEX_APPROVAL_POLICY` | `on-request` (permit escalation requests), `never` (deny escalations) | `on-request` |
| `CODEX_APPROVALS_REVIEWER` | `user` (Matrix review), `auto_review` (Codex automatic review / “Approve for me”) | `user` |
| `CLAUDE_APPROVAL_POLICY` | `on-request` (Matrix permissions in writable mode), `never` (deny requests beyond existing sandbox/edit permissions) | `on-request` |
| `PI_APPROVAL_POLICY` | `on-request` (Matrix confirmation for shell/file writes), `never` (disable those tools) | `on-request` |
| `CODEX_NETWORK_ALLOW` | Up to 32 exact public DNS hostnames, separated by whitespace; no URLs, IPs, wildcards or ports; normalized to lowercase | Sandbox command network disabled |

`CODEX_NETWORK_ALLOW` requires `workspace-write` and a CLI with network-proxy
support. This allows domains for all sandboxed commands, not just read-only
operations. [Network setup](setup.md#optional-codex-command-network-access)
explains limits. Pi does not provide an OS sandbox.

`auto_review` uses Codex's own reviewer and requires CLI/policy support.
`never` still denies escalations. Connector-owned publication, detached-run and
explicit confirmation tools retain their human approval. Questions and login
prompts remain interactive. [Automatic approval setup](setup.md#configuration-values-and-automatic-approval)
explains how to select it. Claude Code's `auto` permission mode is not currently
exposed by Riftjack; `CLAUDE_APPROVAL_POLICY=never` is not an auto-review setting.

## Matrix, storage and limits

| Option | Accepted values | Default / blank |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | HTTPS URL without credentials, query or fragment | Required |
| `MATRIX_OWNER_ID` | Full Matrix ID, e.g. `@alice:example.com` | Required |
| `SYNAPSE_ADMIN_URL` | HTTPS URL, or loopback HTTP URL; no credentials, query or fragment | `MATRIX_HOMESERVER` |
| `SYNAPSE_ADMIN_TOKEN` | Synapse administrator access token | No token; account creation needs this or shared-secret registration |
| `SYNAPSE_REGISTRATION_SHARED_SECRET` | Synapse registration shared secret | No shared-secret registration |
| `RIFTJACK_WORKSPACE` | Existing local directory, absolute or relative path | Required |
| `DATA_DIR` | Local directory path for instance state | `./data` |
| `TASK_TIMEOUT_SECONDS` | 1–86400 seconds, representable as whole milliseconds; includes confirmation waits | `86400` |
| `TURN_COMPLETION_REACTIONS` | `true`, `false` | `true` |
| `MAX_MEDIA_BYTES` | Integer 1–536870912 bytes | `536870912` (512 MiB) |
| `MEDIA_UPLOAD_TIMEOUT_SECONDS` | 1–86400 seconds, representable as whole milliseconds | `1800` |
| `WORKER_PORT` | Integer `0` (disabled), or listening port 1–65535, e.g. `8788`; loopback only | `0` |

Do not share administrator credentials with agents. See [setup](setup.md),
[attachments](chat.md) and [external workers](grok.md) for the corresponding behavior.

## Optional SSH tunnel

| Option | Accepted values | Default / blank |
| --- | --- | --- |
| `SYNAPSE_SSH_TARGET` | SSH host alias or `user@hostname`; no flags, spaces or shell commands | Automatic tunnel disabled |
| `SYNAPSE_SSH_PORT` | Integer 1–65535 | `22` |
| `SYNAPSE_SSH_REMOTE_PORT` | Integer 1–65535 | `8008` |
| `SYNAPSE_SSH_IDENTITY` | Private-key file path accepted by SSH | SSH's usual key/agent selection |

When enabled, the admin URL must be `http://127.0.0.1:PORT` with no path. The
local port comes from that URL. Remote host login is noninteractive and requires
a verified host key. Tunnel sub-options are unused when target is blank.

## Optional tools

| Option | Accepted values | Default / blank |
| --- | --- | --- |
| `AUDIO_TRANSCRIBE_MODEL` | Absolute readable GGUF model file path outside all agent workspaces | Transcription disabled |
| `AUDIO_TRANSCRIBE_PATH` | Absolute executable `transcribe-cli` file path outside all agent workspaces | Required when transcription enabled |
| `AUDIO_FFMPEG_PATH` | Absolute executable `ffmpeg` file path outside all agent workspaces | Required when transcription enabled |
| `AUDIO_MAX_SECONDS` | Integer 1–1800 seconds | `300` |
| `AUDIO_TIMEOUT_SECONDS` | Integer 1–600 seconds | `120` |
| `FETCH_ALLOW` | HTTPS URL prefixes ending in `/`, separated by whitespace or commas; `https://*.example.com/` allows subdomains; no credentials, query or fragment | Fetch disabled |
| `FETCH_AUTH` | Whitespace-separated `prefix\|token-file` entries; prefix must be inside an allowed prefix and cannot use a wildcard; file contains a nonempty bearer token without whitespace | No attached bearer tokens |
| `FETCH_PYTHON` | Python 3 executable path, outside the workspace, with `dir_fd` support; use an absolute path | Find `python3` on PATH |
| `FETCH_MAX_BYTES` | Integer 65536–268435456 bytes | `20971520` (20 MiB) |
| `GITHUB_SUBSCRIPTIONS_CONFIG` | Owner-managed policy JSON path, outside all agent workspaces | GitHub subscription tools disabled |
| `DRAWIO_PATH` | Absolute draw.io Desktop 32.5.5+ executable path outside all agent workspaces; macOS/Linux | Diagram tool disabled |

Audio sub-options are unused when the model is blank. Invalid audio configuration
disables transcription with a warning; original attachments remain usable. Fetch
sub-options are unused when `FETCH_ALLOW` is blank. Its helper rejects non-public
addresses; token files must be kept outside agent-readable locations. See
[fetch tool](security.md), [GitHub policy format](github-subscriptions.md),
[diagrams](diagrams.md) and [audio transcription](audio-transcription.md).
