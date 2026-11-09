// Rulebook library: reads the PDFs in app/library, indexes every page, and answers questions with
// the book and page number (the number printed on the page, not the PDF's page count).
// Everything stays on this computer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import MiniSearch from 'minisearch';
import { APP_DIR } from './config.js';
import { askAI } from './ai.js';

export const LIB_DIR = path.join(APP_DIR, 'library');
const INDEX_DIR = path.join(LIB_DIR, '.index');
fs.mkdirSync(INDEX_DIR, { recursive: true });
const require = createRequire(import.meta.url);

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    // pdfjs warns about canvas support at import; it's only needed for drawing pages, not reading text.
    const warn = console.warn; const log = console.log;
    console.warn = (...a) => { if (!/canvas|DOMMatrix|Path2D|ImageData/i.test(String(a[0]))) warn(...a); };
    console.log = (...a) => { if (!/canvas|DOMMatrix|Path2D|ImageData/i.test(String(a[0]))) log(...a); };
    try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); }
    finally { console.warn = warn; console.log = log; }
  }
  return pdfjs;
}

// ---------- progress (for the Library tab) ----------
const progress = { active: null }; // { file, title, page, pages, queue }
export const libraryProgress = () => progress.active;

// ---------- books ----------
const bookKey = (file, stat) => crypto.createHash('sha1').update(`${path.basename(file)}|${stat.size}|${Math.round(stat.mtimeMs)}`).digest('hex').slice(0, 16);
const indexFile = (key) => path.join(INDEX_DIR, `${key}.json`);
const niceTitle = (file) => path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

function pdfFiles() {
  return fs.readdirSync(LIB_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.pdf$/i.test(d.name))
    .map((d) => path.join(LIB_DIR, d.name));
}

function readIndex(key) {
  try { return JSON.parse(fs.readFileSync(indexFile(key), 'utf8')); } catch { return null; }
}

export function listBooks() {
  return pdfFiles().map((file) => {
    const stat = fs.statSync(file);
    const key = bookKey(file, stat);
    const idx = readIndex(key);
    const meta = idx ? { title: idx.title, pages: idx.pages, offset: idx.offset, textPages: idx.textPages } : null;
    return {
      key, file: path.basename(file), sizeMb: Math.round(stat.size / 1e5) / 10,
      indexed: Boolean(idx), ...(meta || { title: niceTitle(file) }),
      indexing: progress.active?.file === path.basename(file),
      noText: Boolean(idx && idx.textPages < Math.max(3, idx.pages * 0.1)),
    };
  });
}

// ---------- reading a PDF ----------
// Rebuilds readable lines from pdf.js text items (groups items on the same baseline).
function pageText(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = Math.round(it.transform[5]);
    if (cur && Math.abs(cur.y - y) <= 2) cur.parts.push(it.str);
    else { cur = { y, parts: [it.str] }; lines.push(cur); }
    if (it.hasEOL) cur = null;
  }
  return lines.map((l) => l.parts.join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Printed page numbers are usually a lone number in the first or last few lines.
function pageNumberCandidates(lines) {
  const edge = [...lines.slice(0, 3), ...lines.slice(-3)];
  const out = new Set();
  for (const l of edge) {
    for (const m of l.matchAll(/(?:^|\s|\|)(\d{1,4})(?=$|\s|\|)/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 3000 && (l.length < 60 || /^\d{1,4}\b|\b\d{1,4}$/.test(l))) out.add(n);
    }
  }
  return [...out];
}

// The most common (PDF page − printed number) difference, if enough pages agree.
function detectOffset(pages) {
  const votes = new Map();
  pages.forEach((lines, i) => {
    for (const n of pageNumberCandidates(lines)) {
      const off = i + 1 - n;
      if (off >= -2000 && off <= 200) votes.set(off, (votes.get(off) || 0) + 1);
    }
  });
  let best = null, bestVotes = 0;
  for (const [off, v] of votes) if (v > bestVotes) { best = off; bestVotes = v; }
  return bestVotes >= Math.max(3, pages.length * 0.25) ? best : null;
}

function chunkPage(text, size = 900, overlap = 150) {
  if (text.length <= size + 200) return [text];
  const out = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    let end = Math.min(text.length, start + size);
    const dot = text.lastIndexOf('. ', end);
    if (end < text.length && dot > start + size * 0.6) end = dot + 1;
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - (size - overlap);
  }
  return out;
}

async function indexBook(file) {
  const stat = fs.statSync(file);
  const key = bookKey(file, stat);
  const { getDocument } = await loadPdfjs();
  const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    verbosity: 0,
    // pdf.js wants forward slashes and a trailing slash, even on Windows.
    cMapUrl: path.join(base, 'cmaps').replace(/\\/g, '/') + '/', cMapPacked: true,
    standardFontDataUrl: path.join(base, 'standard_fonts').replace(/\\/g, '/') + '/',
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
  });
  const doc = await task.promise;
  const info = await doc.getMetadata().catch(() => null);
  const metaTitle = String(info?.info?.Title || '').trim();
  const title = metaTitle && metaTitle.length > 3 && !/untitled|microsoft|\.indd|\.pdf$/i.test(metaTitle) ? metaTitle : niceTitle(file);

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    progress.active = { ...progress.active, file: path.basename(file), title, page: p, pages: doc.numPages };
    const page = await doc.getPage(p);
    const content = await page.getTextContent().catch(() => ({ items: [] }));
    pages.push(pageText(content.items));
    page.cleanup();
    if (p % 25 === 0) await new Promise((r) => setImmediate(r)); // stay responsive
  }
  await task.destroy();

  const offset = detectOffset(pages);
  const chunks = [];
  pages.forEach((lines, i) => {
    const text = lines.join('\n');
    if (text.length < 40) return;
    const printed = offset === null ? null : i + 1 - offset;
    chunkPage(text).forEach((t, k) => chunks.push({ id: `${key}:${i + 1}:${k}`, book: key, page: i + 1, printed: printed >= 1 ? printed : null, text: t }));
  });
  const index = { v: 1, key, file: path.basename(file), title, pages: pages.length, offset, textPages: pages.filter((l) => l.join('').length >= 40).length, chunks };
  fs.writeFileSync(indexFile(key), JSON.stringify(index));
  console.log(`[library] indexed "${title}": ${pages.length} pages, ${chunks.length} passages` +
    (offset === null ? ' (printed page numbers not found; using PDF pages)' : ` (printed page = PDF page ${offset >= 0 ? '−' : '+'} ${Math.abs(offset)})`));
  return index;
}

// Indexes new/changed PDFs and forgets removed ones. Safe to call often.
let syncing = null;
export function syncLibrary() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null; progress.active = null; });
  return syncing;
}
async function doSync() {
  const files = pdfFiles();
  const keep = new Set();
  const todo = [];
  for (const f of files) {
    const key = bookKey(f, fs.statSync(f));
    keep.add(`${key}.json`);
    if (!fs.existsSync(indexFile(key))) todo.push(f);
  }
  for (const name of fs.readdirSync(INDEX_DIR)) if (name.endsWith('.json') && !keep.has(name)) fs.rmSync(path.join(INDEX_DIR, name));
  for (let i = 0; i < todo.length; i++) {
    progress.active = { queue: todo.length - i, file: path.basename(todo[i]), title: niceTitle(todo[i]), page: 0, pages: 0 };
    try { await indexBook(todo[i]); }
    catch (err) { console.error(`[library] couldn't read ${path.basename(todo[i])}:`, err.message); }
  }
  searchCache = null;
}

// ---------- search ----------
const STOP = new Set(('a an and are as at be by can do does for from how i in is it its me my of on or the to what when where '
  + 'which who why will with you your about there this that rule rules work works use using get').split(' '));
let searchCache = null;
function searcher() {
  const files = fs.readdirSync(INDEX_DIR).filter((n) => n.endsWith('.json')).sort();
  const sig = files.join('|');
  if (searchCache?.sig === sig) return searchCache;
  const ms = new MiniSearch({
    fields: ['text'], storeFields: ['book', 'page', 'printed', 'text'],
    processTerm: (t) => { const w = t.toLowerCase(); return w.length > 1 && !STOP.has(w) ? w : null; },
  });
  const books = {};
  for (const f of files) {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), 'utf8'));
      books[idx.key] = { title: idx.title, file: idx.file };
      ms.addAll(idx.chunks);
    } catch { /* skip broken index */ }
  }
  searchCache = { sig, ms, books };
  return searchCache;
}

export function searchBooks(query, limit = 8) {
  const { ms, books } = searcher();
  const raw = ms.search(query, { prefix: (t) => t.length > 3, fuzzy: (t) => (t.length > 5 ? 0.15 : 0), combineWith: 'OR' }).slice(0, 5000);
  // Rules sections start with their name as a heading, so reward the words appearing together,
  // especially near the start of a passage or on a heading-like line (e.g. "MATRIX FIREWALL").
  const terms = query.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 1 && !STOP.has(w));
  const phrase = terms.join(' ');
  const hits = raw.map((h) => {
    const text = h.text.toLowerCase().replace(/\s+/g, ' ');
    let bonus = 1;
    if (terms.length > 1 && text.includes(phrase)) bonus += 1.5;
    const head = text.slice(0, 160);
    const inHead = terms.filter((t) => head.includes(t)).length;
    bonus += terms.length ? (inHead / terms.length) * 1.2 : 0;
    // Headings: an ALL-CAPS run at the start of a line ("MATRIX FIREWALL." / "EDGE") or a short title-like line.
    const headings = h.text.split('\n').map((line) => {
      const caps = line.match(/^\s*([A-Z][A-Z0-9'’&\- ]{2,60}?)(?=[.:—-]\s|$|\s+[A-Z][a-z])/);
      if (caps && caps[1].replace(/[^A-Z]/g, '').length >= 3) return caps[1].toLowerCase();
      // Title Case heading on its own line: "Matrix Firewall", "Ares Predator VI" (every word capitalized, short).
      const words = line.trim().split(/\s+/);
      return words.length <= 6 && line.length < 50 && !/[.,;:]$/.test(line.trim()) &&
        words.every((w) => /^[A-Z0-9]/.test(w) || /^(of|the|and|a|an|in|on|to|for|vs\.?)$/.test(w)) ? line.toLowerCase() : null;
    }).filter(Boolean);
    const headHits = Math.max(0, ...headings.map((hd) => terms.filter((t) => hd.includes(t)).length));
    if (terms.length && headHits === terms.length) bonus += 6;
    else if (headHits > 0) bonus += 1.5 * (headHits / terms.length);
    if (terms.length && terms.every((t) => text.includes(t))) bonus += 0.5;
    // Squash raw keyword counts (a page repeating a word 20 times isn't 20x more relevant), then apply the bonuses.
    return { ...h, score: Math.log1p(h.score) * bonus };
  }).sort((a, b) => b.score - a.score);
  // One hit per page, best first.
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const k = `${h.book}:${h.page}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...h, title: books[h.book]?.title || 'Unknown book', pageLabel: h.printed ? `p. ${h.printed}` : `PDF page ${h.page}` });
    if (out.length >= limit) break;
  }
  return out;
}

const RULES_SYSTEM = `You are a rules lookup assistant for a tabletop RPG group (mostly Shadowrun).
You get a question and numbered excerpts from the group's own rulebooks, each with its book title and page.
Answer using ONLY those excerpts, in this format (Discord markdown):

**<Topic>** — *<Book title>*, <page>
<1–3 sentences in your own words: what it is / how it works, with the key numbers if any.>

Then, if other excerpts are clearly relevant, a line "Also see:" listing up to 3 more as *Book*, page (a few words each).
Rules: always give the page exactly as written in the excerpt label (e.g. "p. 254" or "PDF page 12"). Keep it short.
Summarize instead of copying long passages; never quote more than one short phrase.
If the excerpts don't answer the question, say you couldn't find it in the books and suggest the closest page if any.`;

export async function askBooks(question) {
  const books = listBooks().filter((b) => b.indexed);
  if (!books.length) return { answer: 'No rulebooks yet. Add your PDFs in Note Tiger → Library.', hits: [] };
  const hits = searchBooks(question, 8);
  if (!hits.length) return { answer: `I couldn't find anything about that in your books (${books.length} indexed).`, hits: [] };
  const excerpts = hits.map((h, i) => `[${i + 1}] ${h.title}, ${h.pageLabel}:\n${h.text.slice(0, 1400)}`).join('\n\n');
  const answer = await askAI(RULES_SYSTEM, `QUESTION: ${question}\n\nEXCERPTS:\n${excerpts}`, 600);
  return { answer, hits: hits.map(({ title, pageLabel, page, book }) => ({ title, pageLabel, page, book })) };
}

// Saves an uploaded PDF into the library (name made safe), then indexes it.
export function addBook(name, buffer) {
  const safe = path.basename(String(name)).replace(/[^\w .()&,'-]+/g, '_').replace(/^\.+/, '').slice(0, 150);
  if (!/\.pdf$/i.test(safe)) throw new Error('Only PDF files can be added.');
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error(`${safe} doesn't look like a PDF.`);
  fs.writeFileSync(path.join(LIB_DIR, safe), buffer);
  syncLibrary().catch(() => {});
  return safe;
}

export function removeBook(key) {
  const book = listBooks().find((b) => b.key === key);
  if (!book) throw new Error('Book not found.');
  fs.rmSync(path.join(LIB_DIR, book.file), { force: true });
  fs.rmSync(indexFile(key), { force: true });
  searchCache = null;
}
