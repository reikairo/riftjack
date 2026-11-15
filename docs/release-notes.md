# Release notes

- Optional audio configuration warnings retain their original filesystem causes
  in the host diagnostic journal and private owner notice. Invalid audio settings
  still disable only transcription; the connector continues starting normally.

These notes describe user-visible changes. Startup notices link to this file at
the running Git revision, so a later release cannot change an older notice.
The revision comparison in an update notice shows the exact committed changes
between the previous successful startup and the current one, including rollbacks.

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
