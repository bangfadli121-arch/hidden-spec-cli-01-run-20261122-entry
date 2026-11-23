# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bangfadli121-arch/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bangfadli121-arch/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an AI-written edit to a tree of text files. It reads one patch and
applies it atomically: every file changes, or none does.

## Formats

- **Unified diffs** — `diff --git` / `---` / `+++` sections with `@@` hunks. Line
  numbers are often wrong, so hunks match by content, taking the occurrence
  nearest the hunk's line number. Creates, deletes and renames are supported.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`,
  with the file path on the line before the block. An empty old block creates a
  file; a non-empty old block must occur exactly once.
- **V4A patches** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` /
  `*** Update File:` / `*** Move to:` / `@@` anchors / `*** End of File` /
  `*** End Patch`, applied with a cursor that moves through the file.
- **JSON tool calls** — one JSON array, or one edit object per line
  (`create`, `str_replace`, `insert`).

The format is detected automatically, or forced with `--format=NAME`.

## Matching

Old lines are matched at the first of three tiers that finds them: exact,
ignoring trailing whitespace, or ignoring leading and trailing whitespace (with
re-indentation of added lines). `--strict` uses the exact tier only.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file; without it, or with `-`, the patch is read from
standard input. `--check` reports what would change without writing anything.
Exit code 0 means the tree was written (or, with `--check`, would be written);
exit 1 lists the edits that failed and writes nothing; exit 2 reports a usage,
missing-patch, format or parse error.

## Files

- `main.ts` — the whole tool (Node 22+, standard library only).
- `runner.ts` — the kit's trial runner (unchanged).
- `SPEC.md` — the specification, version 1.

Run the practice set with `node check.ts <practice.json>` (check.ts is not part
of the repository; copy it in from the kit when testing).
