# Keep current knowledge small and details recoverable

## Three reading scopes

| Scope | Contents | Read when |
| --- | --- | --- |
| Current layer | Profile, durable context, current decisions and lessons, open questions, active focus | On recovery, in full under the agreed contract |
| Detail files | Sources, dates, revisions, evidence, task history | A related task, uncertainty, repeated failure, revision or question needs them |
| Deferred index | Outstanding work, state, return condition and detail link | Quiet review windows, choosing work or a related event |

Keep applicability and exceptions in the current layer. A rule such as “use the
shared build wrapper” is incomplete if it hides which host it applies to.
Include rare rules when forgetting them has a high cost. Put execution logs and
long publication histories in details, with links that remain usable.
If recovery reading itself noticeably brings the next compaction closer, move
chronology into details rather than skipping required files or application limits.

## Write for a reader who has lost the conversation

Every note, rule, task entry and checkpoint must be understandable after the
surrounding conversation has disappeared from context. Use plain language and
complete statements. Do not turn memory into private shorthand: unexplained
abbreviations, joined-up identifiers, cryptic status strings, or references such
as “same as before” and “the other one.” Stable IDs and technical terms are useful
when their meaning and the relevant record are clear.

For an actionable entry, state the situation, the action, its scope and limits,
and the evidence or detail link needed to interpret it. Name the actor and object
when they would otherwise be ambiguous. Separate an observation, a proposed next
step and permission to act. A short entry need not repeat its full history, but
must tell the reader when and where to retrieve a missing detail.

For example, `T001 CIok abc123 wait owner noauto` leaves the reader guessing.
A usable entry says: “T001: checks passed for commit abc123 in the demo project.
The pull request remains open. Wait for the owner's merge decision; passing
checks do not authorize a merge. Evidence and review scope: tasks/T001.md.”

Ambiguous compression can degrade the memory over successive recoveries: a
reader guesses at a missing condition, saves that guess as a rule, and the next
reader treats it as established fact. Original records and links help detect
this drift, but a smaller file or preserved ID count does not prove that meaning
survived. Shorten by removing repetition and moving chronology into details,
not by deleting the words that explain the decision.

Before saving a shortened entry, read it without relying on the conversation.
Can a reader recover the same action, trigger, exceptions, permission boundary
and uncertainty from the entry and its explicit links? Compare these meanings
with the original. If understanding requires a guess, rewrite the entry. On
recovery, retrieve the source or ask for clarification when a material ambiguity
remains; do not silently promote a guess into a fact. An independent reading
within the authorized privacy scope can help, but successful behavior after a
real context loss still needs observation.

## Decisions and lessons

A decision says what was chosen and why. A lesson says what to do or check in a
recognizable situation. They can link to each other without duplicating the
entire incident. For example, a current decision entry might be:

```text
D001 — Review the concrete change before publishing
Decision: prepare the complete diff and destination for the human's review.
Applies: publication of work in the agreed project.
Limits: preparation is not permission to push; use the configured approval path.
Reason: agreement to an intention did not show which changes would be sent.
Details: decisions/D001.md
```

The detail file records the date, source of the agreement, previous choices,
changes and their grounds, observed outcomes, and conditions for reconsideration.
A corresponding lesson can say: “Before calling a publication complete, inspect
the final receipt and destination; pending is not success.” Keep the actual
approval rules of the deployment, rather than copying this example as permission.

When a rule changes, update its current entry **and** append the evidence and
previous reason to its detail file. A correction stored only in revision history
will not help an agent that reads the current entry. Conversely, old instructions
preserved as evidence must be clearly historical.

## Learn from a correction

Separate the observed failure from a hypothesis about its cause. Check the
existing related lesson before adding another one. If a proposed remedy failed
again, investigate why it did not take effect; another copy of the same sentence
is not a new intervention. Compare a claimed past success with actual evidence.

Choose a small change and the next observable check. If an observer could not
tell whether the lesson was applied, rewrite it as an action in a recognizable
situation. Append a dated case and outcome to the existing lesson's detail file
instead of assigning a new ID to the same problem.

Distinguish four outcomes: the rule was not recalled; it was applied but did not
help; no applicable case has occurred; or it worked without a reminder. Improve
the retrieval trigger in the first case and reconsider the remedy in the second.
A repeatedly missed rule may need its operative part in the current layer.
A saved rule, a repair after prompting and repeated independent success are
different evidence. External failures do not always justify a new behavioral rule.

## Checkpoints preserve details

A useful checkpoint retains constraints, reasons for a decision, unresolved
questions, evidence or operation IDs and pointers that would be costly to lose.
It may have been written long before compaction. It may be absent. It is not the
state from which an agent must resume, an authorization, or proof a process is
still running.

Keep task records current throughout work. On recovery, reconcile a note with
newer messages and verified action results before choosing the next step. For
Riftjack's best-effort notices, see [continuity notes](../development.md#continuity-notes).
The connector constructs a note path and delivers reminders; the agent reads or
writes the note with its own tools and permissions.
A tool's record that a file was read or edited before compaction is not its
content. Reread what the next step depends on when that content is no longer
available, even if an earlier edit receipt said rereading was unnecessary.

## Maintain without losing commitments

Before a reorganization, save a verbatim copy of the originals. Diff the open
items after rewriting and compare stable IDs, conditions and
links afterwards. Every old unfinished task must still have an explicit state;
moving it out of focus is not evidence of completion. Keep uncertain outcomes
uncertain until verified. An old command is evidence, not an instruction to run it.

Measure both the size of routine reading and its usefulness. Smaller files are
not a success if an exception, source or obligation becomes undiscoverable.
Evaluate the next actual recovery and deferred-task review, not only file sizes.
