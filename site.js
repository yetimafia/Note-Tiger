// Player website: encrypts sessions with the group password and publishes them to GitHub Pages.
// Players open the site, type the password, and read recaps + color-coded transcripts in their browser.
//
// Encryption: AES-256-GCM, key from PBKDF2-SHA256 (600,000 rounds) of the group password + a random salt.
// Only config.json (salt, rounds) and the viewer page are readable without the password.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  APP_DIR, DATA_DIR, CAMPAIGN_NAME, SITE_ENABLED, SITE_PASSWORD, SITE_REPO, SITE_BRANCH, GITHUB_TOKEN,
} from './config.js';
import {
  knownGuilds, listSessions, readJSON, writeJSON, sessionLines, readLabels, transcriptEntries, speakerColors,
  baseName, sessionStats, gidOf, sessionTimeline,
} from './store.js';
import { buildCampaign, latestStory, allQuotes } from './campaign.js';

const ITERATIONS = 600_000;
const STATE_FILE = path.join(DATA_DIR, 'site.json');   // salt, password check, file names (stays on this PC)
const SITE_DIR = path.join(APP_DIR, 'site');

export const siteConfigured = () => Boolean(SITE_ENABLED && SITE_PASSWORD && SITE_REPO && GITHUB_TOKEN);
export function siteUrl() {
  const [owner, repo] = String(SITE_REPO).split('/');
  if (!owner || !repo) return null;
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo.toLowerCase()}/` : `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

// ---------- encryption ----------
let keyCache = null;
function siteState() {
  let st = readJSON(STATE_FILE, null);
  const check = (salt) => crypto.createHash('sha256').update(`${salt}:${SITE_PASSWORD}`).digest('hex');
  // New password (or first run): new salt, so everything gets re-encrypted and old links need the new password.
  if (!st || st.check !== check(st.salt)) {
    const salt = crypto.randomBytes(16).toString('base64');
    st = { salt, iterations: ITERATIONS, check: check(salt), files: {}, published: {}, passwordChanged: Boolean(st) };
    writeJSON(STATE_FILE, st);
    keyCache = null;
  }
  return st;
}
function siteKey(st) {
  if (!keyCache || keyCache.salt !== st.salt) {
    keyCache = { salt: st.salt, key: crypto.pbkdf2Sync(SITE_PASSWORD, Buffer.from(st.salt, 'base64'), st.iterations, 32, 'sha256') };
  }
  return keyCache.key;
}
// gzip -> AES-GCM; output base64(iv | ciphertext | tag), the layout WebCrypto expects.
export function encryptJSON(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(obj))), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([iv, body]).toString('base64');
}

// ---------- what gets published ----------
export function sessionPayload(dir) {
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const gid = gidOf(dir);
  const entries = transcriptEntries(sessionLines(dir), readJSON(path.join(dir, 'notes.json'), []), readLabels(dir));
  const colors = speakerColors(gid, entries.filter((e) => e.kind === 'say').map((e) => e.speaker));
  const recapFile = path.join(dir, 'recap.md');
  return {
    title: meta.title, date: meta.date, channel: meta.voiceChannel || null,
    recap: fs.existsSync(recapFile) ? fs.readFileSync(recapFile, 'utf8') : null,
    stats: sessionStats(dir),
    timeline: sessionTimeline(dir),
    entries: entries.map((e) => ({
      t: e.t, k: e.kind === 'note' ? 'n' : 's', s: e.speaker, x: e.text,
      ...(e.offTopic ? { o: 1 } : {}), ...(e.recap ? { r: 1 } : {}),
      c: e.kind === 'note' ? null : colors[baseName(e.speaker)] || null,
    })),
  };
}

function allSessionDirs() {
  return knownGuilds().flatMap((g) => listSessions(g.id).map((s) => s.dir))
    .filter((d) => fs.existsSync(path.join(d, 'transcript.jsonl')) && readJSON(path.join(d, 'meta.json'), {}).endedAt);
}

export function manifestFor(st, dirs) {
  const sessions = dirs.map((dir) => {
    const meta = readJSON(path.join(dir, 'meta.json'), {});
    const id = st.files[dir];
    if (!id) return null;
    const stats = sessionStats(dir);
    const colors = speakerColors(gidOf(dir), sessionLines(dir).map((l) => l.speaker));
    const people = [...new Set(sessionLines(dir).map((l) => baseName(l.speaker)))].map((name) => ({ name, color: colors[name] }));
    return { id, file: `${id}.enc`, title: meta.title, date: meta.date, stats, people, sort: meta.startedAt || meta.date };
  }).filter(Boolean).sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
  // Contacts and loose ends for each server that has sessions on the site.
  const trackers = [...new Set(dirs.map(gidOf))].map((gid) => {
    const c = buildCampaign(gid);
    const at = (x) => (x ? { title: x.title, date: x.date } : null);
    return {
      server: knownGuilds().find((g) => g.id === gid)?.name || '',
      contacts: c.contacts.map((n) => ({ name: n.name, who: n.who, attitude: n.attitude, first: at(n.first), history: n.history.map((h) => ({ date: h.date, title: h.title, text: h.text })) })),
      places: c.places.map((n) => ({ name: n.name, what: n.what, first: at(n.first), history: n.history.map((h) => ({ date: h.date, title: h.title, text: h.text })) })),
      runners: c.runners.map((r) => ({ name: r.name, player: r.player, color: r.color, status: r.status, gear: r.gear, first: at(r.first),
        sessions: r.sessions.map((x) => ({ title: x.title, date: x.date, did: x.did, moment: x.moment, talkPct: x.talkPct })) })),
      jobs: c.jobs.map((j) => ({ name: j.name, johnson: j.johnson, task: j.task, payOffered: j.payOffered, payReceived: j.payReceived,
        status: j.status, outcome: j.outcome, complications: j.complications, first: at(j.first), last: at(j.last) })),
      story: latestStory(gid),
      quotes: allQuotes(gid),
      open: c.open.map((t) => ({ n: t.n, text: t.text, opened: at(t.opened) })),
      closed: c.closed.map((t) => ({ text: t.text, how: t.how, opened: at(t.opened), closed: at(t.closed) })),
    };
  }).filter((t) => t.contacts.length || t.places.length || t.runners.length || t.jobs.length || t.open.length || t.closed.length || t.story || t.quotes.length);
  return { campaign: CAMPAIGN_NAME, updated: new Date().toISOString(), sessions, trackers };
}

// ---------- GitHub ----------
async function gh(method, url, body) {
  const res = await fetch(`${process.env.GITHUB_API || 'https://api.github.com'}/repos/${SITE_REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NoteTiger',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || res.statusText;
    if (res.status === 401) throw new Error('GitHub rejected the token. Create a new one and paste it in Settings → Player website.');
    if (res.status === 403 || res.status === 404) throw new Error(`GitHub said "${msg}". Check the repository name and that the token has Contents (and Pages) read & write access to it.`);
    throw new Error(`GitHub error ${res.status}: ${msg}`);
  }
  return data;
}

// Commits files (path -> string or Buffer) to the site branch in one commit. Creates the branch if needed.
async function commitFiles(files, message, { removeOthersIn = null } = {}) {
  const ref = await gh('GET', `/git/ref/heads/${SITE_BRANCH}`);
  const parent = ref?.object?.sha ?? null;
  const baseTree = parent ? (await gh('GET', `/git/commits/${parent}`)).tree.sha : null;
  const tree = [];
  for (const [p, content] of Object.entries(files)) {
    if (Buffer.isBuffer(content)) {
      const blob = await gh('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' });
      tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    } else {
      tree.push({ path: p, mode: '100644', type: 'blob', content });
    }
  }
  // Remove encrypted files that aren't part of the site anymore (e.g. after a password change).
  if (removeOthersIn && baseTree) {
    const existing = await gh('GET', `/git/trees/${baseTree}?recursive=1`);
    for (const item of existing?.tree ?? []) {
      if (item.type === 'blob' && item.path.startsWith(removeOthersIn) && !(item.path in files)) {
        tree.push({ path: item.path, mode: '100644', type: 'blob', sha: null });
      }
    }
  }
  const newTree = await gh('POST', '/git/trees', { ...(baseTree ? { base_tree: baseTree } : {}), tree });
  const commit = await gh('POST', '/git/commits', { message, tree: newTree.sha, parents: parent ? [parent] : [] });
  if (parent) await gh('PATCH', `/git/refs/heads/${SITE_BRANCH}`, { sha: commit.sha, force: false });
  else await gh('POST', '/git/refs', { ref: `refs/heads/${SITE_BRANCH}`, sha: commit.sha });
}

async function ensurePages() {
  const pages = await gh('GET', '/pages');
  if (pages) return pages.html_url || siteUrl();
  try {
    const created = await gh('POST', '/pages', { source: { branch: SITE_BRANCH, path: '/' } });
    return created.html_url || siteUrl();
  } catch (err) {
    throw new Error(`Published, but couldn't switch on GitHub Pages automatically (${err.message}). ` +
      `On GitHub open the repository → Settings → Pages → Source "Deploy from a branch" → ${SITE_BRANCH} / root → Save.`);
  }
}

// ---------- publish ----------
let busy = Promise.resolve();
// Publishes the given session folders (or every finished session) and refreshes the session list.
export function publishSite({ dirs = null, all = false } = {}) {
  const run = busy.then(() => doPublish({ dirs, all }));
  busy = run.catch(() => {});
  return run;
}

async function doPublish({ dirs, all }) {
  if (!SITE_ENABLED) throw new Error('The player website is turned off in Settings.');
  if (!GITHUB_TOKEN || !SITE_REPO) throw new Error('Add your GitHub token and repository in Settings → Player website.');
  if (!SITE_PASSWORD || SITE_PASSWORD.length < 8) throw new Error('Set a group password (at least 8 characters) in Settings → Player website.');
  const st = siteState();
  const key = siteKey(st);
  const every = allSessionDirs();
  // After a password change everything must be re-encrypted.
  const target = all || st.passwordChanged ? every : (dirs ?? []).filter((d) => every.includes(d));
  for (const d of target) if (!st.files[d]) st.files[d] = crypto.randomBytes(12).toString('hex');

  const files = {};
  for (const d of target) {
    files[`data/${st.files[d]}.enc`] = encryptJSON(sessionPayload(d), key);
    st.published[d] = new Date().toISOString();
  }
  files['data/manifest.enc'] = encryptJSON(manifestFor(st, every), key);
  files['data/config.json'] = JSON.stringify({ v: 1, salt: st.salt, iterations: st.iterations });
  files['index.html'] = fs.readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8');
  files['tiger.png'] = fs.readFileSync(path.join(SITE_DIR, 'tiger.png'));
  files['.nojekyll'] = '';
  files['robots.txt'] = 'User-agent: *\nDisallow: /\n';

  console.log(`[website] publishing ${target.length} session${target.length === 1 ? '' : 's'}…`);
  await commitFiles(files, `Update sessions (${target.length})`, { removeOthersIn: all || st.passwordChanged ? 'data/' : null });
  st.passwordChanged = false;
  writeJSON(STATE_FILE, st);
  const url = await ensurePages();
  console.log(`[website] published: ${url}`);
  return { url, published: target.length, total: every.length };
}

// A live game from another program (Dungeon Tiger): its join link goes on the site, encrypted like everything else,
// so only people with the group password see the "Join the dungeon" button.
export function publishLive({ url, token, title, offline } = {}) {
  const run = busy.then(async () => {
    if (!siteConfigured()) throw new Error('Note Tiger\'s player website isn\'t set up (Settings → Player website).');
    if (!offline && !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(String(url || ''))) throw new Error('That isn\'t a link Note Tiger will post.');
    const st = siteState();
    // After a password change, the whole site has to be re-encrypted first.
    if (st.passwordChanged || !Object.keys(st.published || {}).length) await doPublish({ all: true });
    const key = siteKey(siteState());
    const live = offline ? { offline: true, at: new Date().toISOString() }
      : { url, token: String(token || '').replace(/[^\w-]/g, '').slice(0, 64), title: String(title || 'Dungeon Tiger').slice(0, 60), at: new Date().toISOString() };
    await commitFiles({ 'data/live.enc': encryptJSON(live, key), 'index.html': fs.readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8') }, offline ? 'Live game ended' : 'Live game link');
    const siteLink = await ensurePages().catch(() => siteUrl());
    console.log(`[website] ${offline ? 'took down the live game link' : 'posted the live game link'}`);
    return { ok: true, siteUrl: siteLink };
  });
  busy = run.catch(() => {});
  return run;
}

export function siteStatus() {
  const st = readJSON(STATE_FILE, null);
  return {
    enabled: SITE_ENABLED, configured: siteConfigured(), url: siteUrl(), repo: SITE_REPO || null,
    published: st ? Object.keys(st.published || {}) : [],
  };
}
