# Release notes

These notes describe user-visible changes. Startup notices link to this file at
the running Git revision, so a later release cannot change an older notice.
The revision comparison in an update notice shows the exact committed changes
between the previous successful startup and the current one, including rollbacks.

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
