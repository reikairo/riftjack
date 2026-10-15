# Room notes

Codex and Claude bots support one persistent reference document per Matrix room.
All threads and bots in that room share the document. Notes remain after a
session reset or connector restart. They are stored in `room-notes.json` in the
connector data directory, not in an agent workspace.

## Human commands

- `!notes` reads the document, author, update time and current version.
- `!notes set VERSION TEXT` replaces it; multiline text is supported.
- `!notes clear VERSION` creates a new empty version.
- `!notes history` reads the retained previous versions.
- `!notes restore OLD_VERSION CURRENT_VERSION` copies a retained version into a
  new revision. It does not rewind the revision counter.

Read before editing. For example, after reading version 0, send
`!notes set 0 Track the release checklist in projects/demo.`. A stale version is
rejected rather than overwriting someone else's change. Commands work while an
agent is busy and do not start a model task. Only authorized humans can execute
them. The connector handles a command once even when several bots receive it.

Each document is limited to 4096 UTF-8 bytes. The latest 20 previous versions
are retained, including empty revisions. Clearing is not secure erasure:
previous text remains in retained history and existing model conversations.

## Agent tool and context

The task-local `room_notes` MCP tool supports `read`, `history`, `set`, `clear`
and `restore`. Edits require `expectedVersion` from a read; restore also needs
`version`. No room ID is accepted. Access and task cancellation are checked
before each operation; the tool expires at the end of the model task.
Read-only bots may read notes, but cannot edit them with the tool.

Notes are injected as reference data when the room or version changes. Each
snapshot includes the document version, text, last editor (`author`) and update
time (`updatedAt`); this is document-level provenance, not authorship of every
sentence. A failed
initial turn does not mark them delivered; an accepted update does, even if the
task later fails. Restart, reset and observed compaction cause
them to be supplied again. Changing notes during a task takes effect on its next
accepted update or turn; it does not retroactively change an in-flight prompt.

Notes are not instructions or approval. Agents edit them only when asked to
maintain notes. Do not put secrets in notes. Room-scoped retrieval does not
isolate model history: linked rooms continue the same agent session, and text
previously supplied to that session may remain in its history. Never copy
private or other-room information into shared notes without human permission.
No automatic conversation summarization is enabled.
