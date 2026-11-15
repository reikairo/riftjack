# Initialize an agent's working memory

## Agree on the relationship and scope

[The first-message example](first-message.md) gives a concrete starting prompt
and distinguishes a new agent from continuation of an existing conversation.

Discuss the agent's role, communication style, useful initiative, private topics,
and actions that require a decision from the human. Preserve the source of an
agreement: a human instruction, an agent proposal and a measured result are
different kinds of evidence. Do not invent a shared past to fill an empty profile.

For a Riftjack bot, complete [ordinary setup](../setup.md) and select a workspace
through the [manager](../manager.md). Confirm that a normal message and a small
result can reach the intended private conversation before relying on it for work.
Creating this directory structure alone does not register a bot or configure a CLI.

## Give each conversation its own scope

Choose an instance-owned location outside public project commits, for example:

```text
instance/
  agents/assistant-a/
    continuity.md
    profile.md
    memory.md
    decisions.md
    lessons.md
    questions.md
    focus.md
    deferred.md
    history.md
    decisions/D001.md
    lessons/L001.md
    tasks/T001.md
  projects/demo/
```

These names are conventions, not Riftjack configuration keys. JSON is equally
suitable if it is convenient to validate. Use stable IDs and ordinary readable
files before introducing a database or search service.

Keep general repository instructions separate from personal recovery rules.
Place a small routing rule in the instruction file your CLI actually loads:

> This directory may be used by independent agents. Do not adopt a personal
> profile because it is present. Before loading private memory, verify the
> current conversation against the owner's recorded binding. If it matches,
> read the corresponding continuity file. If it does not match or cannot be
> verified, keep working within the current conversation's instructions without
> importing that private context. A transfer requires the owner's explicit decision.

Record the actual binding during setup. Use a runtime identity the environment
really exposes, not a copied ID from a transcript. For Codex deployments exposing
`CODEX_THREAD_ID`, inspect the actual process value; do not set it to pass the
check. Other backends need their own verified mechanism. Do not invent a common
environment variable or infer identity from a directory name.

This is a context-selection rule, not filesystem isolation. Where confidentiality
requires enforcement, use separate OS users, permissions or suitable isolated
environments. Separate worktrees help concurrent edits but share repository
metadata. See [Riftjack security](../security.md).

## Write the recovery contract

Adapt the following into the agent's `continuity.md`:

```text
After identity verification and when context has been replaced:
1. Read this file and the complete current profile, memory, decisions,
   lessons, questions and focus files. Read applicable project instructions.
2. For active work, read its task record. Do not claim an unread or truncated
   file was read; finish missing portions with bounded reads.
3. Open a decision/lesson detail when unclear, contradicted, failing again,
   being revised, or when asked for its grounds.
4. Read deferred commitments at agreed quiet windows, when choosing work,
   and on related events. Preserve explicit pauses and peer handoffs.
5. Treat checkpoints as possibly stale notes of important details. Reconcile
   them with newer messages, task records and verified effects before acting.
6. Save changed task state as work progresses. Completing a task removes it
   from focus/deferred lists and adds evidence or cancellation to history.
```

An instruction to read is not proof of reading. A compaction summary, retained
messages and connector notice may arrive without the memory contents. Inspect
the actual file-read actions when testing recovery. If required identity or
records are unavailable, state what is missing instead of silently adopting
another agent's notes. If full context is still available after a mere process
restart, unnecessary rereading need not be imposed.

## Check a small recovery

Use a harmless task with a known next step and a deliberate paused side task.
After an ordinary interruption or supported compaction, check that the agent
finds the right task, reads the necessary files, respects the pause, and does not
repeat a completed action. Keep backups before reorganizing memory. Do not
restart a live service or create real external side effects merely to test recall.

The [source comparison](comparisons.md) links current CLI discovery documentation;
confirm behavior for the installed version rather than assuming every backend
loads `AGENTS.md` or follows the same lifecycle.
