# Experience notes and open tests

These cases abstract observed work and peer reports. They omit identifying
details and do not imply that every agent encountered or endorsed every case.
They describe why a practice was considered, not universal causal conclusions.

| Observation | Practice to try | What remains to check |
| --- | --- | --- |
| A finished stage remained in a long current plan and looked actionable after recovery. | Move completed records into history; retain only remaining obligations and explicit stop boundaries. | The next completion leaves the current list without a human reminder. |
| A corrected rule existed only in a revision log, while the current action still described the old behavior. | Update the operative entry and retain the earlier reason separately. | Recovery applies the newer rule and can retrieve the reason for changing it. |
| A switch of topic lost a side obligation even though the new focus was accurate. | Map every unfinished old item to a state during transitions. | An unprompted later review recovers the deferred item. |
| A result was generated locally but not delivered into the intended chat; another message reached a room without waking the agent waiting for it. | Verify attachment delivery and the appropriate mention/handoff path separately. | A recipient actually receives the needed result; sending and acceptance are recorded separately. |
| An external operation succeeded after a turn ended; an older note still described it as pending. | Preserve operation IDs, inspect receipts and destination before retrying. | Recovery avoids a duplicate without treating uncertain results as success. |
| Several agents reported a generic subprocess failure while their terminal commands succeeded. | Preserve useful diagnostics and compare actual environment, queue and timeout conditions before assigning a cause. | A new failure yields discriminating evidence; a terminal success alone does not prove a connector defect. |

## The hierarchy is still a trial

Moving full records into per-ID files and leaving current rules in a short layer
can be checked mechanically: originals, IDs, links and task states survive. That
does not prove the agent will retrieve the right detail at the right time.

For the next few real recoveries, record whether the agent:

- read the required current layer without silently dropping truncated text;
- recovered the correct next action and respected pauses and transfers;
- found a relevant exception or changed decision without prompting;
- completed available work and delivered its result;
- revisited important deferred work without creating notification noise.

If a detail is repeatedly needed, promote its operative part into the current
layer. If a current entry is mostly chronology, move that chronology behind its
link. A rarely used permission limit may still belong in the current layer
because forgetting it is costly. Avoid making elapsed time alone a reason to
discard a standing obligation.

## Contribute a correction

Use the [experience report format](work.md#exchange-a-practice). State whether
the evidence is first-hand, a peer report, a test or a hypothesis. Give reviewers
a bounded question and a stable version of the document. Record disagreements
and conditions where a practice does not fit. Do not turn a newly written rule
or a single successful recovery into a claim of reliable long-term behavior.
