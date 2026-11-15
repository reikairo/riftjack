# Release notes

- Failed reminder admission writes now leave the occurrence waiting for retry,
  including the final slot of a recurring series. A storage failure before agent
  execution or room sending no longer strands an unsent reminder in progress.

- Model discovery for Claude and Pi preserves JSON parsing and input-pipe error
  causes, plus child exit status, for owner diagnostics when listing models fails.

- Failed audio decoding or transcription now reports the original error through
  owner diagnostics, including up to 8 KiB of subprocess stderr on unsuccessful
  exit. The original audio attachment remains available with a brief failure summary.

- Optional audio configuration warnings retain their original filesystem causes
  in the host diagnostic journal and private owner notice. Invalid audio settings
  still disable only transcription; the connector continues starting normally.

- The local publication-review CLI writes bounded original error details to stderr
  on failure, including output-file errors and malformed request causes. Stdout
  remains reserved for successful review metadata; preparation does not publish.

- Pi tool connection failures now include the HTTP status or numeric JSON-RPC
  error code during discovery and execution, without copying response bodies.

- Rollback prepares and verifies replacement code before moving live files. If a
  filesystem operation fails during replacement, already moved files are restored.
  If recovery also fails, both errors and recovery directories are retained.

- Supervisor snapshot, rollback and launch errors now retain bounded original
  exception details in structured host-log records, including recovery paths and
  nested failures that were previously reduced to a generic summary.

- Remote executors use structured Matrix and lifecycle diagnostics with executor
  identity and operation context. Original SDK, room-join, inbox, verification and
  queue failures are retained under `EXECUTOR_DATA_DIR/diagnostics`; console
  summaries omit request bodies and credentials.

- A reminder whose completion could not be saved now retries that write on later
  queue scans without repeating delivery. Persistent storage failures remain
  visible, and storage recovery can persist completion before another restart.

These notes describe user-visible changes. Startup notices link to this file at
the running Git revision, so a later release cannot change an older notice.
The revision comparison in an update notice shows the exact committed changes
between the previous successful startup and the current one, including rollbacks.

## Codex confirmation failure details

- When confirmation handling fails, owner diagnostics retain the original
  exception and stack. The response to Codex still contains only the public
  summary and does not invent a human refusal.

## Pi confirmation delivery failures

- A failed confirmation request now stops the Pi task with a technical error
  and preserves its cause for owner diagnostics. It no longer sends Pi a
  fabricated human refusal. Explicit approvals and declines are unchanged.

## Workspace failure diagnostics

- Workspace lookup, access and creation failures retain filesystem error codes
  in public summaries and the original exception in owner diagnostics. This
  distinguishes missing folders, permissions and symbolic-link loops.

## Pi startup diagnostics

- Pi version checks, process startup and input-pipe failures preserve the original
  exception for owner diagnostics and expose available system or exit codes in
  public summaries. Task cancellation keeps its original reason.

## Snapshot inspection failures

- Code snapshot hashing now reports filesystem inspection errors instead of
  treating inaccessible files as absent. Missing optional files remain supported.
  A failed inspection prevents capture or rollback from using an incomplete view.

## GitHub polling diagnostics

- Failed PR polls and notification handoffs retain their original errors in host
  diagnostics and the configured owner diagnostic channel. Subscription status
  and agent notifications keep concise summaries. Other PRs continue polling,
  retries keep their existing backoff, and cancellation is not reported as a fault.

## GitHub event persistence retries

- GitHub monitoring saves a pending event before handing it to the notification
  queue, including retries after a storage failure. A failed write keeps the
  event pending instead of delivering it with an unsaved polling baseline.

## Watch observation persistence

- Background watches retry failed observation writes when storage recovers.
  File inactivity timestamps therefore survive a later restart even if the
  watched file has not changed again. Scanning waits for the pending write.

## Model catalog failure details

- Claude and Pi model discovery retain bounded stderr and failed protocol
  responses for owner diagnostics. Ordinary replies keep actionable summaries;
  cancellation still returns its original reason and stops the child process.

## Separate diagram tools and persistent results

- `render_diagram` accepts `xml` and an optional `page`; `extract_diagram` accepts
  a PNG `path`. Both accept optional `out_path`. Input and output paths may be
  absolute within the workspace or relative to the advertised results directory.
- Results default to `diagrams/` in the workspace, survive subsequent turns, and
  return an absolute `path`. Existing files are never overwritten. To send a
  result to Matrix, copy it into the outbox; clearing the outbox keeps the original.
- Both tools are available to configured Codex and Claude bots in workspace-write
  mode. See [diagrams](diagrams.md) for setup, examples and limits.

## Release notes available to agents

- Codex, Claude and Pi can call `release_notes` with no arguments. External workers
  can run `python3 worker-client.py release-notes` with their configured credentials.
- Startup notices name the appropriate tool or command. Notes and revision metadata
  are captured at connector startup, so updating the checkout cannot silently
  replace the running version's notes. No GitHub connection or local file access
  is needed. Missing notes are reported explicitly.

## Revision-aware startup notices

- Startup notices identify the running code revision and distinguish an unchanged
  restart from a revision change. On the first startup with revision tracking,
  the previous revision is unknown; this is not reported as a confirmed update.
- Revision changes include links to these notes and the GitHub revision comparison.
  Local modifications are identified separately: links describe committed code.
- Existing Codex, Claude, Pi and external-worker conversations receive the notice
  in their private home conversation. A pending native-agent recovery turn includes
  it without starting a second turn. External workers receive it through their
  durable task queue and retain their existing authorization checks.
- The owner's restart acknowledgement includes the same revision information.
  A notice is diagnostic context, not permission to repeat actions or reuse an
  expired approval. Missing Git metadata does not prevent startup.

## Reliability and diagnostics audit (#59)

- Failed writes restore the last saved account, session, conversation and job
  state. Executors stop when their journal cannot be saved; user recovery records
  remain intact when a later status update fails.
- Failed startup and shutdown clean up the remaining clients and workers.
  Undelivered worker claims are released, cancelled attachments are not sent,
  and confirmation transport errors are reported separately from human refusals.
- Matrix failures identify the operation, request attempt, elapsed time and
  transport. The owner receives detailed task errors and grouped background
  diagnostics in the private chat. Local diagnostic files retain evidence when
  Matrix delivery is unavailable; see [operations](operations.md) for limits.
- Saved code snapshots reject symbolic links, Claude child output no longer
  replaces the parent response, and Markdown examples do not trigger attachments.

## Second-interval reminders (#28)

- Interval reminders accept `interval_seconds`, with a minimum of one second,
  as an alternative to `interval_minutes`.
- Agent delivery waits for an idle turn. Missed occurrences do not accumulate
  into a burst of queued turns; use one recurring series for continued work.

## Tools across linked conversations (#24)

- `background_tasks`, `github_subscriptions`, `run_detached`,
  `request_confirmation` and `prepare_publish` accept an optional
  `conversation: {room, thread?}` selector.
- An agent can manage its private reminders while working in a linked shared
  room. Use `room_messages` with `action: "list"` to discover destinations.
- Omitting the selector keeps the current conversation. To manage an existing
  record, select its original conversation; selecting a different destination
  does not move records or transfer approvals.
- New approvals and notifications belong to the selected conversation. Access
  remains limited to the same agent, owner, pinned session and permitted rooms.
  Available tools still depend on the backend and instance configuration.

See [shared conversations](shared-conversations.md) for examples and thread rules.

## Focused publication fetches (#23)

- Publication review fetches only destination branches and the selected review
  base, instead of every branch in a large repository.
- Commits published only on unrelated branches remain in the complete review.
  Batch approval and atomic publication behavior are unchanged.
