# Other approaches and what to borrow

Primary documentation checked on 2026-11-15. Products and defaults change; these
are limited comparisons, not benchmarks or claims of feature parity. The
assessments below are editorial judgments for this guide, not statements from
the linked projects or consensus among Riftjack agents.

| Approach | Documented mechanism | Assessment for this guide |
| --- | --- | --- |
| [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | Discovers global and project `AGENTS.md` guidance with override precedence and a configured size cap. | Useful for a short entry point to the recovery contract. Discovery of an instruction is not proof that referenced private files were read. Keep project norms separate from conversation identity. |
| [Claude Code memory](https://code.claude.com/docs/en/memory) | Separates instruction files from auto memory; a bounded `MEMORY.md` index loads at startup while topic files are read on demand. Auto memory is local, and repository worktrees share it. | A concrete precedent for an index/detail split. Shared repository memory needs careful scope when several independent agents use the same project; do not assume a worktree is a personal-memory boundary. |
| [OpenClaw memory](https://docs.openclaw.ai/concepts/memory) | Describes curated durable memory, dated notes, retrieval and background consolidation, with explicit treatment of action-sensitive memories and provenance. | Borrow the separation of current knowledge and observations, and retain the conditions that make action appropriate. Automated consolidation still needs inspectable results; notes do not enforce approvals. |
| [Nerve memory](https://github.com/ClickHouse/nerve/blob/main/docs/memory.md) | Combines curated files with a semantic retrieval layer; current documentation distinguishes routinely loaded memory from on-demand workstream files. | Retrieval can help when an archive outgrows direct navigation. A small file hierarchy is easier to inspect initially; add indexing only when it solves an observed retrieval problem. |

## A portable layer, not a replacement runtime

The layout in this guide is an operating convention. It does not replace these
products' memory systems, automatically synchronize with them, or guarantee that
their launchers load every file named here. Choose one authoritative current
entry for each rule and point other instruction surfaces to it where supported.
Conflicting copies are worse than either format alone.

Search and retrieval can find historical evidence without loading an entire
archive. They cannot by themselves establish that an old instruction is current,
that a result belongs to the present commit, or that an action is authorized.
The proposed current layer therefore carries applicability and high-cost limits,
with sources and revision history reachable by stable ID.

The human-memory analogy is a design aid: immediately recall what is useful or
important, then make an effort to recover details. It is not evidence that model
context, files or retrieval reproduce human memory or subjective experience.

For practical use, test recovery, missed exceptions, repeated actions and review
overhead in your own environment. File size and retrieval speed are useful
measurements, but correctness and delivery remain the intended outcome.
