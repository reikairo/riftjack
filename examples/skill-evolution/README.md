# From procedure to script

This portable example implements the corrected procedure from Riftjack issue #16.
It requires Python 3.9+ and its standard library. It is not installed as an agent skill.

## The learning example

This is an illustrative history, not a report of an experiment:

1. Repeated checks of fragment-free links suggest checking target files.
2. The procedure mistakenly generalizes existence to “link valid”.
3. A script automates the mechanical file check, preserving that overstatement.
4. A counterexample has a surviving file but a deleted section.
5. The corrected procedure and output separate existence from unverified fragments.

Only the corrected implementation is provided here. Its result cannot establish
that a heading exists, even if the file is present.

## Interface

From this directory:

```sh
python3 scripts/check_target.py README.md 'README.md#interface'
```

The script reports JSON fields `file`, `fragment`, and `reason`.
`file` is `present`, `missing`, `not_checked`, or `error`.
`fragment` is `absent` or `not_checked`, including an empty fragment after `#`.
Exit 0 means a normal report, including missing or unsupported destinations;
exit 1 means a source/target inspection error; argument errors exit 2.
Read the report rather than treating exit 0 as success of link validation.

Input is one already extracted destination, not Markdown syntax. Relative paths
resolve against the resolved source document's directory, which is also the
allowed tree. Symlinks resolve before containment is checked. URLs, absolute
paths, fragment-only destinations, encoded destinations, query strings,
backslashes, angle brackets and control characters are outside this example.
Paths with `.` or `..` components or trailing slashes are also not checked,
to avoid normalizing away file-versus-directory constraints.
Directories are reported as non-regular targets. File contents and readability
are not checked: a successful stat establishes existence only. Failed metadata
access is an error, not proof of absence.

Use a stable trusted checkout. Resolution and inspection are separate filesystem
operations; this is not a security boundary against concurrent hostile changes.
No network requests, file modifications or automatic link repairs occur.

## Evidence to collect before adoption

The included unittest suite covers these cases:

- Existing regular file: present, fragment absent.
- Missing file: missing.
- Nested relative file: resolved relative to the source, not shell cwd.
- File with a section fragment: present, fragment not checked.
- Same file after the section is deleted: same result, never “link valid”.
- External URL: not checked.
- Outside-tree path or symlink: not checked.
- Unavailable source or inaccessible target metadata: error.

## Preserve reasons in Git

Keep current instructions in SKILL.md. Review changes to code and interpretation
together. A commit explanation can record:

> Separate file existence from anchor validity. A removed heading leaves the
> file present, so the previous conclusion overstated the evidence. Report
> fragments as unverified. Renderer-specific verification remains out of scope.

Record checks actually performed, remaining limits and the condition for
reconsideration in the commit body. A separate decision file is optional.
Git can restore a script revision; it cannot undo downstream actions taken
because of a misleading report.

Run the focused checks from the repository root:

```sh
python3 -m unittest discover -s examples/skill-evolution/scripts/tests -v
```

The before/after fixtures differ in their heading; both intentionally leave the
fragment unverified. This checks the claim boundary, not anchor validity.
