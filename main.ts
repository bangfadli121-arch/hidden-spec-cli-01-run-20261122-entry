// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It applies AI-written edits in four formats (unified diff,
// SEARCH/REPLACE, V4A, JSON tool calls) to a tree of text files, atomically: every file changes
// or nothing does. Sections 1-4, 9 and 10 of SPEC.md (command line, output and exit codes, safe
// paths, format detection, JSON edits, all-or-nothing write) follow the kit's starter; sections
// 5-8 (three-tier line matching, unified diffs, SEARCH/REPLACE, V4A) are implemented here.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines: its line break, its lines, whether it ends with a break (SPEC section 3). */
function splitFile(text: string): { lines: string[]; br: string; fin: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, fin: false };
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/* Section 5: matching lines at three tiers. */

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return bothTrim(a) === bothTrim(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, or null when it occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** O and N of one hunk or chunk, with the context-line correspondence (N index -> O index). */
interface ON {
  o: string[];
  n: string[];
  ctx: Map<number, number>;
  bsAfter: boolean;
}

/** Build O/N from body lines (' ' context, '-' old, '+' new, '\' marker, '' empty context). */
function buildON(body: string[]): ON {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  let lastCtxPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl === '') {
      ctx.set(n.length, o.length);
      o.push('');
      n.push('');
      lastCtxPlus = k;
    } else if (bl[0] === ' ') {
      ctx.set(n.length, o.length);
      o.push(bl.slice(1));
      n.push(bl.slice(1));
      lastCtxPlus = k;
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push(bl.slice(1));
      lastCtxPlus = k;
    }
  }
  const bsAfter = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
  return { o, n, ctx, bsAfter };
}

/** The lines N writes over the matched lines: context lines as the file's own, tier-2 re-indent. */
function reindent(n: string[], o: string[], fileLines: string[], at: number, tier: number, ctx: Map<number, number>): string[] {
  if (tier !== 2) return n.map((line, j) => (ctx.has(j) ? fileLines[at + ctx.get(j)!]! : line));
  const f = leadWs(fileLines[at]!);
  const p = leadWs(o[0]!);
  return n.map((line, j) => {
    if (ctx.has(j)) return fileLines[at + ctx.get(j)!]!;
    if (line === '' || wsOnly(line)) return line;
    return line.startsWith(p) ? f + line.slice(p.length) : line;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
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

/* Section 6: unified diffs. */

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function headerPath(rest: string): string {
  return rest.split('\t')[0]!.trim();
}

function pathOrNull(p: string): string | null {
  const s = stripPrefix(p);
  return s === '/dev/null' ? null : s;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const newSection = (s: Section): void => {
    sections.push(s);
    cur = s;
    inHeader = true;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSection({ pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, gitOld: m[1]!, gitNew: m[2]!, create: false, del: false, hunks: [] });
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldN = pathOrNull(headerPath(l.slice(4)));
      const newN = pathOrNull(headerPath(lines[i + 1]!.slice(4)));
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = oldN;
        cur.pairNew = newN;
      } else {
        newSection({ pairOld: oldN, pairNew: newN, renOld: undefined, renNew: undefined, gitOld: undefined, gitNew: undefined, create: false, del: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && !l.startsWith('@@')) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        if (cur.pairNew === undefined) cur.pairNew = pathOrNull(headerPath(l.slice(4)));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      i = j;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.gitOld !== undefined ? s.gitOld : null;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.gitNew !== undefined ? s.gitNew : null;
  if (oldP === null && newP === null) return () => { throw new Fail('unsafe', ''); };
  const isCreate = (oldP === null || s.create) && newP !== null;
  const isDelete = !isCreate && (newP === null || s.del);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  if (isCreate) {
    const np = newP!;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let fin = true;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.startsWith('+')) plus.push(h.body[k]!.slice(1));
        }
        const lastPlus = (() => {
          for (let k = h.body.length - 1; k >= 0; k--) if (h.body[k]!.startsWith('+')) return k;
          return -1;
        })();
        if (lastPlus >= 0) fin = !(lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.startsWith('\\'));
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
    };
  }
  if (isDelete) {
    const op = oldP!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = oldP!;
  const np = newP!;
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const f = splitFile(before);
    let lines = f.lines.slice();
    let fin = f.fin;
    let d = 0;
    for (const h of s.hunks) {
      const on = buildON(h.body);
      if (on.o.length > 0) {
        const found = findTier(lines, on.o, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        let bd = Math.abs(best - target);
        for (const p of found.occ) {
          const dd = Math.abs(p - target);
          if (dd < bd) {
            bd = dd;
            best = p;
          }
        }
        const seg = reindent(on.n, on.o, lines, best, found.tier, on.ctx);
        if (best + on.o.length === lines.length) fin = !on.bsAfter;
        lines.splice(best, on.o.length, ...seg);
        d += on.n.length - on.o.length;
      } else {
        const at = Math.min(h.a + d, lines.length);
        if (at === lines.length) fin = !on.bsAfter;
        lines.splice(at, 0, ...on.n);
        d += on.n.length;
      }
    }
    const out = joinFile(lines, f.br, fin);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push({ old: op, nw: np });
    } else {
      tree.now.set(op, out);
    }
  };
}

/* Section 7: SEARCH/REPLACE blocks. */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    const old: string[] = [];
    let j = i + 1;
    let sep = -1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      old.push(lines[j]!);
      j++;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const nw: string[] = [];
    let k = sep + 1;
    let rep = -1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      nw.push(lines[k]!);
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, old, nw, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const seg = reindent(nw, old, f.lines, at, found.tier, new Map());
    const lines = f.lines.slice();
    lines.splice(at, old.length, ...seg);
    tree.now.set(path, joinFile(lines, f.br, f.fin));
  };
}

/* Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateLine = i + 1;
    i++;
    const content: { t: string; n: number }[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      content.push({ t: lines[i]!, n: i + 1 });
      i++;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.t)) content.pop();
    edits.push(v4aEdit(kind, path, content, updateLine, strict));
  }
  return edits;
}

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, content: { t: string; n: number }[], updateLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const ls: string[] = [];
    for (const c of content) {
      if (c.t === '') ls.push('');
      else if (c.t.startsWith('+')) ls.push(c.t.slice(1));
      else throw new Exit2(`error: parse ${c.n}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, ls.length === 0 ? '' : ls.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    const bad = content.find((c) => !blank(c.t));
    if (bad !== undefined) throw new Exit2(`error: parse ${bad.n}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0]!.t.startsWith('*** Move to: ')) {
    moveTo = content[0]!.t.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let afterEof = false;
  for (; idx < content.length; idx++) {
    const c = content[idx]!;
    if (c.t === '*** End of File') {
      if (cur !== null) {
        cur.eof = true;
        chunks.push(cur);
        cur = null;
      }
      afterEof = true;
      continue;
    }
    if (c.t.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = c.t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      afterEof = false;
      continue;
    }
    if (c.t.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${c.n}`);
    if (c.t === '' || c.t[0] === ' ' || c.t[0] === '-' || c.t[0] === '+') {
      if (afterEof) throw new Exit2(`error: parse ${c.n}`);
      if (cur === null) cur = { anchor: null, eof: false, body: [] };
      cur.body.push(c.t);
      continue;
    }
    throw new Exit2(`error: parse ${c.n}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = f.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && foundAt < 0; t++) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(lines[k]!, ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const on = buildON(ch.body);
      if (on.o.length > 0) {
        let pick: { tier: number; at: number } | null = null;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && pick === null; t++) {
          const occ = occurrences(lines, on.o, t).filter((p) => p >= cursor && (!ch.eof || p + on.o.length === lines.length));
          if (occ.length > 0) pick = { tier: t, at: occ[0]! };
        }
        if (pick === null) throw new Fail('no-match', path);
        const seg = reindent(on.n, on.o, lines, pick.at, pick.tier, on.ctx);
        lines.splice(pick.at, on.o.length, ...seg);
        cursor = pick.at + seg.length;
      } else {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...on.n);
        cursor = at + on.n.length;
      }
    }
    const out = joinFile(lines, f.br, f.fin);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/* Section 9: JSON edits. */

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

/* Sections 1, 2 and 10: invocation, output and exit codes, order and atomicity. */

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of tree.moves) {
    if (tree.original(m.old) === null || tree.original(m.nw) !== null) continue;
    if (tree.get(m.old) !== null || tree.get(m.nw) === null) continue;
    const di = rows.findIndex((r) => r.line === `D ${m.old}`);
    const ai = rows.findIndex((r) => r.line === `A ${m.nw}`);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
