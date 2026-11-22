// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// tool calls), finds the lines each edit names at the first of three matching tiers, and
// changes every file or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are.

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

/** A file as lines: its line break, and whether its text ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** One line of a patch, normalised for a matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimWs(s);
}

/** Every 0-based position where the pattern lines match the file's lines at a tier. */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const np = pat.map((l) => normLine(l, tier));
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j]!, tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which the pattern occurs at least once, with its positions. */
function findTier(lines: string[], pat: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, pat, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first tier at which the pattern occurs at or after `from`, with its first position. */
function findTierFrom(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (const p of occurrences(lines, pat, t)) {
      if (p < from) continue;
      if (eof && p + pat.length !== lines.length) continue;
      return { tier: t, pos: p };
    }
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier with one. */
function findSingleLine(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return -1;
}

/** One line of the replacement text: a context line names its index in the old lines. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Replace the pattern's lines at `at` by the new lines (section 5, tier 2 re-indent). */
function applyReplace(doc: FileDoc, O: string[], N: NLine[], at: number, tier: number): FileDoc {
  const F = at < doc.lines.length ? leadingWs(doc.lines[at]!) : '';
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const out: string[] = [];
  for (const nl of N) {
    if (nl.ctx !== null) {
      out.push(doc.lines[at + nl.ctx]!);
    } else if (tier === 2 && nl.text !== '' && !/^[ \t]+$/.test(nl.text) && nl.text.startsWith(P)) {
      out.push(F + nl.text.slice(P.length));
    } else {
      out.push(nl.text);
    }
  }
  return { lines: [...doc.lines.slice(0, at), ...out, ...doc.lines.slice(at + O.length)], br: doc.br, final: doc.final };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];
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

/** One body line of a unified hunk or a V4A chunk; `bs` when a `\` line follows it. */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  bs: boolean;
}

interface Hunk {
  a: number;
  entries: BodyEntry[];
  line: number;
}

/** A hunk's old lines O and new lines N (context lines carry their index in O). */
function hunkON(h: Hunk): { O: string[]; N: NLine[]; bsLast: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const e of h.entries) {
    if (e.kind === 'ctx') {
      N.push({ text: e.text, ctx: O.length });
      O.push(e.text);
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else {
      N.push({ text: e.text, ctx: null });
    }
  }
  let bsLast = false;
  for (let i = h.entries.length - 1; i >= 0; i--) {
    const e = h.entries[i]!;
    if (e.kind === 'ctx' || e.kind === 'new') {
      bsLast = e.bs;
      break;
    }
  }
  return { O, N, bsLast };
}

/** Apply one hunk of a section to a file, `d` the length drift of the section's earlier hunks. */
function applyHunk(doc: FileDoc, h: Hunk, on: { O: string[]; N: NLine[]; bsLast: boolean }, d: number, strict: boolean, failPath: string): FileDoc {
  const { O, N, bsLast } = on;
  if (O.length === 0) {
    const at = Math.min(h.a + d, doc.lines.length);
    const lines = [...doc.lines.slice(0, at), ...N.map((x) => x.text), ...doc.lines.slice(at)];
    let fin = doc.final;
    if (at === doc.lines.length && N.length > 0) fin = !bsLast;
    return { lines, br: doc.br, final: fin };
  }
  const found = findTier(doc.lines, O, strict);
  if (found === null) throw new Fail('no-match', failPath);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const out = applyReplace(doc, O, N, best, found.tier);
  if (best + O.length === doc.lines.length) {
    out.final = N.length === 0 ? out.lines.length > 0 : !bsLast;
  }
  return out;
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path of a `--- `/`+++ ` line: text after the four characters, up to the first tab, trimmed. */
function headerPath(s: string): string {
  return s.split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse a unified diff (SPEC.md section 6) into its sections' edits. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'none' | 'header' | 'body' | 'after' = 'none';
  let body: string[] = [];
  let bodyHunk: Hunk | null = null;
  const newSection = (): Section => ({
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    create: false,
    del: false,
    hunks: [],
  });
  const endBody = (): void => {
    if (bodyHunk === null) return;
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const entries: BodyEntry[] = [];
    for (const l of body) {
      if (l === '') entries.push({ kind: 'ctx', text: '', bs: false });
      else if (l.startsWith(' ')) entries.push({ kind: 'ctx', text: l.slice(1), bs: false });
      else if (l.startsWith('-')) entries.push({ kind: 'old', text: l.slice(1), bs: false });
      else if (l.startsWith('+')) entries.push({ kind: 'new', text: l.slice(1), bs: false });
      else if (l.startsWith('\\')) {
        const p = entries[entries.length - 1];
        if (p !== undefined) p.bs = true;
      }
    }
    bodyHunk.entries = entries;
    cur!.hunks.push(bodyHunk);
    bodyHunk = null;
    body = [];
    state = 'after';
  };
  const hunkA = (l: string): number | null => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    return m === null ? null : Number(m[1]);
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (state === 'body') {
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) || l.startsWith('@@')) {
        endBody();
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        body.push(l);
        i++;
        continue;
      }
      endBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l.slice(4));
      const newP = headerPath(lines[i + 1]!.slice(4));
      if (cur !== null && state === 'header' && !cur.hasPair) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
        sections.push(cur);
        state = 'header';
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkA(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      bodyHunk = { a, entries: [], line: i + 1 };
      body = [];
      state = 'body';
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.pairNew = headerPath(l.slice(4));
        cur.hasPair = true;
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice(10).trim();
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
    i++;
  }
  if (state === 'body') endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** The text of a created file: the `+` lines of all its hunks, in order. */
function creationText(hunks: Hunk[]): string {
  const lines: string[] = [];
  let bsLast = false;
  let anyPlus = false;
  for (const h of hunks) {
    for (const e of h.entries) {
      if (e.kind === 'new') {
        lines.push(e.text);
        bsLast = e.bs;
        anyPlus = true;
      }
    }
  }
  if (!anyPlus) return '';
  return `${lines.join('\n')}${bsLast ? '' : '\n'}`;
}

/** One unified section as one edit. */
function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = s.pairOld ?? s.renameOld ?? s.diffOld;
    const newRaw = s.pairNew ?? s.renameNew ?? s.diffNew;
    const oldIsNull = oldRaw === '/dev/null';
    const newIsNull = newRaw === '/dev/null';
    let oldP: string | null = oldRaw === null || oldIsNull ? null : stripAB(oldRaw);
    let newP: string | null = newRaw === null || newIsNull ? null : stripAB(newRaw);
    if (oldP === null) oldP = newP;
    if (newP === null) newP = oldP;
    if (oldP === null || newP === null) throw new Exit2('error: parse 1');
    const isCreate = oldIsNull || s.create;
    const isDelete = !isCreate && (newIsNull || s.del);
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, creationText(s.hunks));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let doc = parseFile(cur);
    let d = 0;
    for (const h of s.hunks) {
      const on = hunkON(h);
      doc = applyHunk(doc, h, on, d, strict, oldP);
      d += on.N.length - on.O.length;
    }
    const text = joinFile(doc);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push({ old: oldP, nw: newP });
    } else {
      tree.now.set(oldP, text);
    }
  };
}

/** One SEARCH/REPLACE block as one edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseFile(cur);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const out = applyReplace(doc, oldLines, N, found.pos[0]!, found.tier);
    tree.now.set(path, joinFile(out));
  };
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

function v4aAdd(path: string, flines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, flines.length === 0 ? '' : `${flines.join('\n')}\n`);
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as one edit. */
function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const idx = findSingleLine(doc.lines, ch.anchor, cursor, strict);
        if (idx === -1) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const h: Hunk = { a: 0, entries: ch.entries, line: 0 };
      const on = hunkON(h);
      if (on.O.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const lines = [...doc.lines.slice(0, at), ...on.N.map((x) => x.text), ...doc.lines.slice(at)];
        doc = { lines, br: doc.br, final: doc.final };
        cursor = at + on.N.length;
        continue;
      }
      const found = findTierFrom(doc.lines, on.O, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      doc = applyReplace(doc, on.O, on.N, found.pos, found.tier);
      cursor = found.pos + on.N.length;
    }
    const text = joinFile(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Parse a V4A patch (SPEC.md section 8) into its sections' edits. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice(13).trim();
      const flines: string[] = [];
      i++;
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x) || x.trimEnd() === '*** End Patch') break;
        if (x.startsWith('+')) flines.push(x.slice(1));
        else if (x === '') flines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push(v4aAdd(path, flines));
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice(16).trim();
      i++;
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x) || x.trimEnd() === '*** End Patch') break;
        if (blank(x)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDelete(path));
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice(16).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let sawBody = false;
      let sawMove = false;
      const closeChunk = (strip: boolean): void => {
        if (cur === null) return;
        if (strip) {
          const e = cur.entries;
          while (e.length > 0 && e[e.length - 1]!.kind === 'ctx' && e[e.length - 1]!.text === '') e.pop();
        }
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x) || x.trimEnd() === '*** End Patch') break;
        if (!sawBody && !sawMove && x.startsWith('*** Move to:')) {
          moveTo = x.slice(12).trim();
          sawMove = true;
          i++;
          continue;
        }
        if (x.startsWith('@@')) {
          closeChunk(false);
          cur = { anchor: x.slice(2).trim(), eof: false, entries: [] };
          sawBody = true;
          i++;
          continue;
        }
        if (x.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk(false);
          i++;
          continue;
        }
        if (x === '' || x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, entries: [] };
            sawBody = true;
          }
          if (x === '') cur.entries.push({ kind: 'ctx', text: '', bs: false });
          else if (x.startsWith(' ')) cur.entries.push({ kind: 'ctx', text: x.slice(1), bs: false });
          else if (x.startsWith('-')) cur.entries.push({ kind: 'old', text: x.slice(1), bs: false });
          else cur.entries.push({ kind: 'new', text: x.slice(1), bs: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
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
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.now.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
