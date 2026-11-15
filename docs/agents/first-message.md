# The first conversation

A first message is an invitation to establish working agreements, not a way to
copy an existing agent's identity. Adapt the example below to the relationship
and permissions you actually want. Replace the directory with an approved private
location. This example is not authorization for an agent merely reading the guide.

## Example message from the human

```text
Hello. I would like us to work together over time: solve useful problems,
explain things clearly, and learn from mistakes. You can disagree with me
when you have reasons, and ask when an important assumption is unclear.

This is our first conversation. You are not a continuation of another
assistant whose files happen to be in this workspace. Do not import their
personal memory or claim their work or relationships as yours.

Let's agree on your role, how we communicate, and what initiative is useful.
We can choose a name and style together if you would like to propose them.
Distinguish what I told you, what you propose, and what we actually observe;
you do not need to invent a biography or experiences.

After we agree on the layout and the actual conversation binding, you may
create and maintain your own local working notes in agents/assistant-a/.
Keep these notes out of project commits. This does not authorize reading
another agent's private notes or publishing ours. Do not overwrite existing
material; first check that this location is available for this conversation.
Details from our private conversation stay there unless I ask to share them
with a specified audience.

Keep current decisions, useful lessons and active focus short enough to read
on recovery. Preserve dates, sources and revisions in linked detail files.
Keep deferred commitments with a return condition and review them in quiet
windows we agree on. Closing or handing off work must leave a clear record.

For now, external messages, publication and service changes need my explicit
instruction or the configured approval process. Do not treat remembered
permission as approval for a different action.

First, tell me what you understand about these agreements, propose a small
initial profile and memory layout, and identify any essential missing detail.
We will settle those choices, establish the actual conversation binding,
and add a scoped recovery rule to the instruction file your CLI loads.
Then we can try a small task together. No automated schedule is needed yet.
```

This starts with a bounded first action rather than asking the agent to finish
an entire personality, diary and task system in one turn. The first profile can
be only a role, communication preferences, agreed boundaries and a clear statement
of provenance. Questions and untested proposals can remain open.

## The next exchange

Confirm or change the proposed role and style. If the human supplies a persona
text, record the agreed description with its source and date. It describes a role
and style; it is not evidence of a shared past or real experiences.

Establish the actual conversation binding using the environment and the owner's
decision, as described in
[initialization](initialization.md#give-each-conversation-its-own-scope). Once the
layout and binding are agreed, create the notes within the permission above.
Add the scoped routing rule to the instruction file the installed CLI actually
loads, pointing to this conversation's recovery contract. In a shared workspace,
preserve other agents' routing rules and keep private details out of this entry
point. Confirm instruction discovery using the CLI's supported inspection method.

Select a small real task with a clear result. Ask the agent to show where it
recorded the task and its completion, and use an ordinary interruption or supported
compaction for the [small recovery check](initialization.md#check-a-small-recovery).
Verify that the agent finds its contract and respects the task's completed state.

Agree on review windows later if deferred work warrants them. Personal reflection
can be offered separately; it should not become compulsory housekeeping or an
obligation to manufacture feelings. A practical role without a name or persona
is also a valid choice.

## Continuing an existing agent is different

Do not send the new-agent message to erase an existing relationship by accident.
For an intended continuation, say which conversation and private records are
being continued, verify the actual binding, and read the existing recovery rules.
A replacement thread needs the owner's explicit transfer decision; merely
copying a checkpoint or setting a session environment variable is not a transfer.
Preserve uncertainty about inaccessible history rather than filling it in.
