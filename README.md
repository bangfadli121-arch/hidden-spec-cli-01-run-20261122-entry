# mend

One patch tool for every AI edit format. `mend` applies an edit that an AI model
wrote to a tree of text files, in four formats: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Every file is changed or nothing is.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When
  `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` the tree is written, `1` one or more edits failed (nothing is
written; every failure is reported), `2` a usage, no-patch, format or parse error.

See `SPEC.md` for the full specification.

## How it works

- Line matching runs at three tiers: exact, ignoring trailing whitespace, then
  ignoring leading and trailing whitespace with re-indentation of added lines.
- Unified hunks find the occurrence nearest to their (often wrong) line number,
  handle empty-old insertions, `\ No newline at end of file`, creation, deletion
  and moves.
- SEARCH/REPLACE blocks take their path from the line before the marker (or the
  previous block's path) and fail as ambiguous when the old text occurs twice.
- V4A sections support Add, Delete and Update files, `Move to`, anchors and a
  cursor, and `End of File` chunks.
- Edits apply in order to the tree as earlier edits left it; a failed edit
  changes nothing, later edits still run, and when any edit failed no file is
  written at all.

## Requirements

Node 22 and its standard library alone; nothing is installed. Deterministic:
the same run gives the same exit code, stdout and files every time.

## License

MIT. See `LICENSE`.
