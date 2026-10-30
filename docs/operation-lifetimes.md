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

## Other tool paths

The following source audit identifies follow-up work. It does not change the
listed tools' behavior.

| Path | What survives the turn | Remaining limitation or next step |
| --- | --- | --- |
| [`request_confirmation`](../src/confirmation-mcp.ts) | No pending question or decision survives. The tool explicitly expires it at turn completion. | A model that finishes while waiting cannot receive a later decision. A connector-owned question with a saved decision notification would address this; a later answer must not revive an expired executable approval. |
| [`run_detached`](../src/detached-runs.ts), approval stage | The pending confirmation is turn-bound. The run is only saved after approval. | This has the same gap before admission. A durable request could notify the agent that a launch is prepared. The agent must still execute the returned command through the normal sandbox; the connector must not silently launch it. |
| `run_detached`, after preparation or launch | Saved run records, independent supervision and durable completion notifications survive the model turn. | A prepared but unlaunched run expires. A lost supervisor requires process inspection, not automatic relaunch. |
| [`send_attachments`](../src/attachment-delivery.ts) and [`room_messages`](../src/room-messages.ts) | An external message may already have been sent, but attempt receipts are kept in a turn-local map. | A disconnect can lose the receipt while retaining the effect. Persistent scoped delivery receipts could distinguish sent, not sent and uncertain across turns. Automatically retrying uncertain sends can create duplicates. |
| [`background_tasks`](../src/background-tasks.ts) | Saved watches and timers, notification attempts and restart recovery survive admission. | Losing the registration response does not cancel the saved watch. Inspect the list before registering a duplicate. |
| [`executor-queue`](../src/executor-queue.ts) | Saved execution states and completion notifications survive submission. | Uncertain execution must be inspected; it is not a license to replay the command. |
| [`github_subscriptions`](../src/github-subscriptions.ts) | Saved subscriptions and their notification path survive registration. | A lost registration receipt can be resolved by listing subscriptions. |
| Backend shell and sandbox approvals | Approval belongs to the current backend request. | This boundary is intentional. A new turn must not execute an old approved command merely because the previous request disappeared. |
| Read-only tools | Their connection and pending response are turn-bound. | Cancellation may waste work, but does not create an approved external mutation. They do not all need durable jobs. |

The most direct follow-up is durable general questions, followed by the approval
stage of detached runs. Message-delivery receipts are a separate problem: preserve
evidence of an external effect before considering retries.
