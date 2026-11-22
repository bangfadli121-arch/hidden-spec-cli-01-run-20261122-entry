// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It covers all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, the all-or-nothing write, and the three
// formats written here: line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function fileModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function modelText(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s));
const tiers = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

/** Every 0-based position where O matches the file's lines at this tier. */
function occurrencesAt(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return out;
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(fileLines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tiers(strict)) {
    const positions = occurrencesAt(fileLines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, deleted, or added. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

const opsOld = (ops: Op[]): string[] => ops.filter((o) => o.kind !== 'add').map((o) => o.text);
const opsNew = (ops: Op[]): string[] => ops.filter((o) => o.kind !== 'del').map((o) => o.text);

/**
 * Re-indent plain new lines at tier 2: F is the leading whitespace of the file's first
 * matched line, P that of O's first line; a non-blank line starting with P has P replaced by F.
 */
function reindentLines(n: string[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2 || o.length === 0) return [...n];
  const p = leadOf(o[0]!);
  const f = leadOf(fileLines[pos]!);
  return n.map((t) => {
    if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/**
 * Build the lines a hunk or chunk writes: context lines are the file's own matched lines,
 * added lines are the patch's, re-indented at tier 2.
 */
function buildNewLines(fileLines: string[], ops: Op[], pos: number, tier: number): string[] {
  const o = opsOld(ops);
  const p = o.length === 0 ? '' : leadOf(o[0]!);
  const f = o.length === 0 ? '' : leadOf(fileLines[pos]!);
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  pairOld: boolean;
  pairNew: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path a `--- `/`+++ ` line names: after the four characters, up to the first tab, trimmed, a/ or b/ removed. /dev/null means no file. */
function diffPath(line: string): string | null {
  let s = line.slice(4).split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';

/** True when a `\` line immediately follows the hunk body's last context or `+` line. */
function backslashAfterLast(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.startsWith(' ') || body[i]!.startsWith('+')) last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.startsWith('\\');
}

/** True when a `\` line immediately follows the body's last `+` line (created files). */
function backslashAfterLastPlus(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.startsWith('+')) last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.startsWith('\\');
}

function bodyOps(body: string[]): Op[] {
  const ops: Op[] = [];
  for (const l of body) {
    if (l === '') ops.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) ops.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) ops.push({ kind: 'del', text: l.slice(1) });
    else if (l.startsWith('+')) ops.push({ kind: 'add', text: l.slice(1) });
    // A `\` line refers to the body line before it; it carries no content of its own.
  }
  return ops;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      inHeader = false;
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(b)) break;
        hunk.body.push(b);
        i += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('diff --git')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: m[1], newP: m[2], pairOld: false, pairNew: false, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.pairOld || cur.pairNew) {
          // The header already has its pair; this pair starts a new section.
          cur = { oldP: diffPath(line), newP: diffPath(lines[i + 1]!), pairOld: true, pairNew: true, newFile: false, deletedFile: false, hunks: [] };
          sections.push(cur);
        } else {
          cur.oldP = diffPath(line);
          cur.newP = diffPath(lines[i + 1]!);
          cur.pairOld = true;
          cur.pairNew = true;
        }
        i += 2;
        continue;
      }
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = { oldP: diffPath(line), newP: diffPath(lines[i + 1]!), pairOld: true, pairNew: true, newFile: false, deletedFile: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        if (!cur.pairNew) cur.newP = diffPath(line);
      } else if (line.startsWith('rename from ')) {
        if (!cur.pairOld) cur.oldP = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.pairNew) cur.newP = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks in order to a file model; throws Fail('no-match', path). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = [...model.lines];
  let final = model.final;
  let d = 0;
  for (const hunk of hunks) {
    const ops = bodyOps(hunk.body);
    const o = opsOld(ops);
    const n = opsNew(ops);
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const written = buildNewLines(lines, ops, pos, found.tier);
      if (pos + o.length === lines.length) final = !backslashAfterLast(hunk.body);
      lines = [...lines.slice(0, pos), ...written, ...lines.slice(pos + o.length)];
    } else {
      const ins = Math.min(Math.max(hunk.a + d, 0), lines.length);
      if (ins === lines.length) final = !backslashAfterLast(hunk.body);
      lines = [...lines.slice(0, ins), ...n, ...lines.slice(ins)];
    }
    d += n.length - o.length;
  }
  return { lines, br: model.br, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP;
    return (tree: Tree) => {
      // Every path the edit names is checked for safety before anything else about it.
      const checkPaths: string[] = [];
      if (isCreate) {
        if (newP !== null && newP !== undefined) checkPaths.push(newP);
      } else if (isDelete) {
        if (oldP !== null && oldP !== undefined) checkPaths.push(oldP);
      } else {
        if (oldP !== null && oldP !== undefined) checkPaths.push(oldP);
        if (newP !== null && newP !== undefined) checkPaths.push(newP);
      }
      for (const p of checkPaths) {
        if (!safe(p)) throw new Fail('unsafe', p);
      }
      if (isCreate) {
        const dest = newP ?? '';
        if (dest === '') throw new Fail('unsafe', dest);
        if (tree.get(dest) !== null) throw new Fail('exists', dest);
        const added: string[] = [];
        for (const hunk of sec.hunks) {
          for (const l of hunk.body) {
            if (l.startsWith('+')) added.push(l.slice(1));
          }
        }
        let final = false;
        if (added.length > 0) {
          let lastPlus: Hunk | null = null;
          for (const hunk of sec.hunks) {
            if (hunk.body.some((l) => l.startsWith('+'))) lastPlus = hunk;
          }
          final = lastPlus === null ? false : !backslashAfterLastPlus(lastPlus.body);
        }
        tree.now.set(dest, added.length === 0 ? '' : added.join('\n') + (final ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const src = oldP ?? '';
        if (src === '') throw new Fail('unsafe', src);
        if (tree.get(src) === null) throw new Fail('missing', src);
        tree.now.set(src, null);
        return;
      }
      const src = oldP ?? '';
      const dest = isMove ? (newP ?? '') : src;
      if (src === '' || dest === '') throw new Fail('unsafe', src === '' ? src : dest);
      const cur = tree.get(src);
      if (cur === null) throw new Fail('missing', src);
      if (isMove && tree.get(dest) !== null) throw new Fail('exists', dest);
      const out = applyHunks(fileModel(cur), sec.hunks, strict, src);
      const text = modelText(out);
      if (isMove) {
        tree.now.set(src, null);
        tree.now.set(dest, text);
        tree.recordMove(src, dest);
      } else {
        tree.now.set(src, text);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      const te = lines[j]!.trimEnd();
      if (te === '=======') {
        eq = j;
        break;
      }
      if (te === '>>>>>>> REPLACE' || te === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      const te = lines[j]!.trimEnd();
      if (te === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (te === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(sIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((block) => {
    const path = block.path;
    const oldLines = block.oldLines;
    const newLines = block.newLines;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const m = fileModel(cur);
      const found = findTier(m.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const written = reindentLines(newLines, oldLines, m.lines, pos, found.tier);
      const outLines = [...m.lines.slice(0, pos), ...written, ...m.lines.slice(pos + oldLines.length)];
      tree.now.set(path, modelText({ lines: outLines, br: m.br, final: m.final }));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string;
  eof: boolean;
  ops: Op[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

const v4aBodyOp = (l: string): Op => {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'del', text: l.slice(1) };
  return { kind: 'add', text: l.slice(1) };
};

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateLine = i + 1;
    const start = i + 1;
    let j = start;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j += 1;
    }
    const raw = lines.slice(start, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const sec: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], updateLine };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '') sec.lines.push('');
        else if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else throw new Exit2(`error: parse ${start + k + 1}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${start + k + 1}`);
      }
    } else {
      let idx = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      let curChunk: V4aChunk | null = null;
      let afterEof = false;
      for (let k = idx; k < raw.length; k += 1) {
        const l = raw[k]!;
        const ln = start + k + 1;
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${ln}`);
          curChunk.eof = true;
          sec.chunks.push(curChunk);
          curChunk = null;
          afterEof = true;
          continue;
        }
        if (l.startsWith('@@')) {
          if (curChunk !== null) sec.chunks.push(curChunk);
          curChunk = { anchor: l.slice(2).trim(), eof: false, ops: [] };
          afterEof = false;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${ln}`);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (afterEof) throw new Exit2(`error: parse ${ln}`);
          if (curChunk === null) {
            if (sec.chunks.length === 0) curChunk = { anchor: '', eof: false, ops: [] };
            else throw new Exit2(`error: parse ${ln}`);
          }
          curChunk.ops.push(v4aBodyOp(l));
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      if (curChunk !== null) sec.chunks.push(curChunk);
      if (sec.moveTo === null && sec.chunks.length === 0) throw new Exit2(`error: parse ${updateLine}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => {
    const path = sec.path;
    if (sec.kind === 'add') {
      const fileLines = sec.lines;
      return (tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const m = fileModel(cur);
      let fileLines = [...m.lines];
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== '') {
          let foundIdx = -1;
          for (const tier of tiers(strict)) {
            for (let j = cursor; j < fileLines.length; j += 1) {
              if (normLine(fileLines[j]!, tier) === normLine(chunk.anchor, tier)) {
                foundIdx = j;
                break;
              }
            }
            if (foundIdx >= 0) break;
          }
          if (foundIdx < 0) throw new Fail('no-match', path);
          cursor = foundIdx + 1;
        }
        const o = opsOld(chunk.ops);
        if (o.length === 0) {
          const ins = chunk.eof ? fileLines.length : cursor;
          const added = opsNew(chunk.ops);
          fileLines = [...fileLines.slice(0, ins), ...added, ...fileLines.slice(ins)];
          cursor = ins + added.length;
        } else {
          let found: { tier: number; pos: number } | null = null;
          for (const tier of tiers(strict)) {
            const occ = occurrencesAt(fileLines, o, tier).filter((p) => p >= cursor && (!chunk.eof || p + o.length === fileLines.length));
            if (occ.length > 0) {
              found = { tier, pos: occ[0]! };
              break;
            }
          }
          if (found === null) throw new Fail('no-match', path);
          const written = buildNewLines(fileLines, chunk.ops, found.pos, found.tier);
          fileLines = [...fileLines.slice(0, found.pos), ...written, ...fileLines.slice(found.pos + o.length)];
          cursor = found.pos + written.length;
        }
      }
      const text = modelText({ lines: fileLines, br: m.br, final: m.final });
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, text);
        tree.recordMove(path, moveTo);
      } else {
        tree.now.set(path, text);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  // A file moved by a successful move edit replaces its D and A lines with one R line, sorting by <new>.
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  const seenMoves = new Set<string>();
  for (const [o, n] of tree.moves) {
    const moveKey = `${o}\0${n}`;
    if (seenMoves.has(moveKey)) continue;
    seenMoves.add(moveKey);
    if (tree.original(o) !== null && tree.original(n) === null && tree.get(o) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
