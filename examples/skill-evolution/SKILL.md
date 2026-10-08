---
name: local-destination-example
description: Inspect file existence for one extracted local Markdown destination in this example.
---

1. Use only for a trusted local checkout and an existing source document.
2. Extract the destination separately; the script does not parse Markdown.
3. Run `python3 scripts/check_target.py SOURCE DESTINATION` from this example directory, quoting both arguments.
4. Read the JSON fields. `present` establishes regular-file existence only. A fragment is always unverified; never describe this result as a valid link.
5. Report missing, skipped and error results explicitly. Refer to README.md for scope and exit codes.
6. If section validity is required, use a separate renderer-aware review or state that it remains unverified.
