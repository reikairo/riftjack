# Operation lifetimes

Closing a model turn closes its MCP connections. That should cancel work which
only has meaning inside that turn, but it must not silently discard an admitted
publication or the result of an independently running task.

## Publication

`prepare_publish` admits an operation into `PublicationJobs` and returns its ID.
The connector prepares and delivers the review, accepts a scoped human decision,
and executes the existing reviewed push. Ending the submitting turn or closing
its MCP connection does not withdraw that operation. Its own deadline, explicit
cancellation, session reset, revoked access or connector shutdown can stop it.

The operation saves its outcome before handing it to `BackgroundTasks.notify`.
The notification ID is derived from the operation ID, so retrying delivery does
not repeat the push. The background queue resumes the original conversation when
it can run. A receipt means admission, not successful publication.

After connector restart, unfinished publications become interrupted. Confirmation
IDs are not restored and Git commands are not replayed. A push interrupted during
execution may have reached the remote; inspect it before preparing another review.
Explicit cancellation suppresses a new result turn, while `!status` retains the
recorded outcome. Terminal records whose notifications have been queued may be
pruned as new operations are admitted; this is not an unlimited audit archive.

Implementation: [publication-jobs.ts](../src/publication-jobs.ts),
[bridge.ts](../src/bridge.ts), [main.ts](../src/main.ts).
Tests cover delayed approval after MCP closure with a real local Git remote,
background resumption, scope isolation, restart, cancellation and delivery retry.
This does not constitute a live Matrix restart test.

## Proposal and run approvals

`request_confirmation` and the `start`/`close` actions of `run_detached` use the
same connector-owned [approval job](../src/approval-jobs.ts) lifecycle. They return
an operation receipt immediately and deliver a saved result in a background turn.
The stores are independent of model turns. `!cancel`, reset, revoked access and
the operation deadline cancel them; unanswered confirmations expire on connector
restart. A completed decision remains queryable without asking the human again.

Use `request_confirmation` with `action=status` and the request ID, or
`run_detached` with `action=approval_status` and the operation ID, to retrieve full
results. Both accept an omitted ID to list the twenty most recent records in the
same room, sender, thread, conversation and session. Long notification previews
are marked truncated and refer to these queries. Saved approval histories are
bounded, like publication histories; they are not unlimited audit archives.

A prepared detached launch is still **not running**. The agent must invoke its
saved `launch_argv` through the ordinary command tool and sandbox approval before
`launch_by`. Dependencies and cwd remain live; selected script snapshots are
captured before review. No connector background job executes the launch. If the
result is delivered after the five-minute launch window, inspect status instead
of running an expired command.

## Delivery receipts

[`DeliveryReceipts`](../src/delivery-receipts.ts) stores scoped IDs and content
fingerprints before invoking message/file transports. Success is saved after the
transport acknowledgement. A crash or lost response can leave `uncertain`; it
never causes replay. An identical repeated ID returns the saved receipt, while
changed text, destination or file content is rejected. File fingerprints cover
relative paths, display names and byte hashes, not a transient outbox root.

`send_attachments` accepts `id` with `files`. It and `room_messages` expose
`action=status` with an optional ID. Queries recheck authorization and privacy;
receipts are also isolated by tool, bot, source room, sender, thread, key and
session. Final-manifest attachments use the same ledger and stable event-derived
IDs. Normal sends do not start additional model turns. At 800 active receipts,
completed receipts are archived to `delivery-receipts.json.archive/`, reducing
the working index toward 600. Full receipts and fingerprints remain available by
ID and still prevent duplicate sends after restart. Pending and uncertain outcomes
stay indexed; 1,000 such retained outcomes block new sends until investigated.
Archive writes precede index removal, so interruption cannot create a deduplication
gap. Recent-history queries show the working index; use an exact ID for archives.

Detached runs use the same write-before-removal order: at 80 indexed runs,
reported terminal runs and explicitly closed lost runs move to `archived-run.json`
in their existing run directories, reducing the index toward 60. Logs, commands
and status files remain in place. `status` with the original ID reads an archive
with the same conversation checks. `list` shows the working index. Active,
unreported and unclosed lost runs are never archived; the 100-record limit still
protects the active index. Archiving does not authorize another launch.


## Boundaries retained intentionally

| Path | Recovery behavior |
| --- | --- |
| `run_detached`, after preparation or launch | Saved run records, independent supervision and durable completion notifications survive. A prepared launch expires; a lost supervisor requires process inspection, not relaunch. |
| [`background_tasks`](../src/background-tasks.ts) | Watches, timers, notification attempts and restart recovery survive admission. Inspect the list after a lost registration response. |
| [`executor-queue`](../src/executor-queue.ts) | Saved states and completion notifications survive submission. Uncertain execution is not replayed. |
| [`github_subscriptions`](../src/github-subscriptions.ts) | Saved subscriptions and notifications survive registration. Inspect the list before duplicating registration. |
| Backend shell and sandbox approvals | Approval belongs to the current backend request. A new turn must not execute an old approved command merely because the previous request disappeared. |
| Read-only tools | Cancellation may waste work but does not create an approved external mutation. They remain turn-bound. |

Regression tests exercise delayed decisions after HTTP closure, full proposal
retrieval, restart expiry, prepared launches without execution, lost send results,
scope isolation, changed file content and receipt retrieval through a new MCP
connection. This is not a claim of exactly-once effects or a live Matrix restart
test.
