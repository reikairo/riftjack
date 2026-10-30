# Background watch conditions

`background_tasks` monitors existing work. It never launches, restarts or stops a
process. A watch ends on its first matching condition and delivers one durable
notification to its originating conversation. Interrupted delivery retains the
same result for recovery. Cancelling a watch only cancels monitoring.

Observation continues while an agent turn is running. The first matching file
condition is saved before delivery, so later writes cannot erase it while the
agent is busy. Direct room reminders also continue independently of model turns.

## Plain text results

Create a small result file, initially containing `running`, and write `exit 0`
or `exit N` when the task finishes. Atomic replacement avoids partial reads.
Register:

```json
{
  "action": "watch",
  "label": "Example build",
  "mode": "text",
  "status_file": "build-result.txt",
  "text_condition": { "operator": "starts_with", "value": "exit " },
  "idle_file": "build.log",
  "idle_seconds": 600
}
```

The first nonempty trimmed line is tested. Operators are `equals`, `not_equals`
and `starts_with`; values are literal strings, not regular expressions. An empty
file never matches. The notification includes only that line, not the rest of
the file. Result files are limited to 64 KiB and the selected line to 1024
characters. Both the result file and optional log must exist when registering.

The example also watches for ten minutes without a change in `build.log`.
The text result wins if both conditions match during the same check. If the
idle condition wins, the notification says only that the file did not change;
it does not assert that the build failed or its process stopped.

## File inactivity

Use `mode: "idle"` with `idle_file` and `idle_seconds` to monitor any regular
file, including a large or binary log. No file content is read for this mode.
Add these two options to a text, JSON or process watch to combine conditions.

The period is 1–604800 seconds. Each watch polls at approximately one fifth of
its period, bounded to 1–60 seconds: a five-second period polls every second,
and a sixty-second period every twelve seconds. Delivery can be later while
an agent is busy, the connector is stopped or the service is under load.

The initial age comes from the file modification time. Changes in modification
time, size, inode or metadata restart the clock when observed. This includes
truncation and atomic replacement, even when the replacement preserves an old
modification time. The observed clock survives connector restarts. It cannot
detect changes that happen and are completely undone between checks.

Missing and unreadable files produce `watch_file_missing` and
`watch_file_unreadable`, separately from `watch_file_idle`. These notifications
end the watch. Inspect the files before registering another watch.

## Process completion

```json
{
  "action": "watch",
  "label": "Example process",
  "mode": "process",
  "pid": 12345,
  "exit_code_file": "build-result.txt"
}
```

Register while the process is alive. The connector records its PID and start
identity from the host process table. The disappearance of that identity,
a zombie state, or reuse of the PID ends the watch. A failed process-table
read remains unknown, appears in diagnostics and is retried until expiry.
This requires a host supporting the connector's POSIX process-table reader.
Children may still be running after the observed process exits.

The optional `exit_code_file` must already exist. When the process disappears,
a changed result file containing an integer or `exit N`, modified no earlier
than the captured process start, supplies `exit_code` and `exit_code_source`.
Use a dedicated file for this run and replace its initial contents when the
process exits. A missing, unchanged or malformed result does not produce an
exit code. PID reuse never produces an exit code. The connector cannot retrieve
the exit status of an arbitrary nonchild process from its disappearance.

## JSON watches and operational limits

Existing JSON watches with `status_file`, `field` and `terminal` continue to
work. Add `mode: "json"` and optional idle options for the new combined
conditions. The older `stale_after_minutes` option measures valid JSON updates;
it is distinct from file inactivity and cannot be combined with explicit modes.
The legacy optional `pid` guard does not capture a start identity; use process
mode when watching a process independently.

Files must remain inside the bot workspace; path confinement is rechecked on
every read. Use `timeout_hours` (1–168, default 24) to bound any watch. Expiry is
not evidence of process exit. `list`, `history`, `cancel`, session reset and
access revocation apply to all watch modes. A restart notice includes a fresh
observation without changing or relaunching the task.
