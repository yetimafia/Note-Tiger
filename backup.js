// Backs up the data folder (sessions, contacts, loose ends, settings) to a PRIVATE GitHub repository,
// and restores it on a new PC. Only changed files are uploaded. Tokens and passwords (.env) are never included.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, BACKUP_ENABLED, BACKUP_REPO, BACKUP_TOKEN } from './config.js';
import { readJSON, writeJSON } from './store.js';

const STATE_FILE = path.join(DATA_DIR, '..', 'backup-state.json');   // outside data/, so it isn't backed up itself
const BRANCH = 'main';
const SKIP = [/(^|\/)transcript\.(html|txt)$/, /(^|\/)\./, /\.tmp$/];   // the .txt/.html are rebuilt from transcript.jsonl
const DAY = 24 * 3600_000;

export const backupConfigured = () => Boolean(BACKUP_ENABLED && BACKUP_REPO && BACKUP_TOKEN);
const state = () => readJSON(STATE_FILE, { last: null, lastError: null, files: 0, repo: null });
const saveState = (s) => writeJSON(STATE_FILE, s);
export function backupStatus() {
  return { enabled: BACKUP_ENABLED, configured: backupConfigured(), repo: BACKUP_REPO || null, running, ...state() };
}

async function gh(method, url, body) {
  const res = await fetch(`${process.env.GITHUB_API || 'https://api.github.com'}/repos/${BACKUP_REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${BACKUP_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NoteTiger',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 404 || res.status === 409) && method === 'GET') return null;   // 409 = empty repository
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || res.statusText;
    if (res.status === 401) throw new Error('GitHub rejected the token. Create a new one and paste it in Settings → Backups.');
    if (res.status === 403 || res.status === 404) throw new Error(`GitHub said "${msg}". Check the repository name and that the token has Contents read & write access to ${BACKUP_REPO}.`);
    throw new Error(`GitHub error ${res.status}: ${msg}`);
  }
  return data;
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (SKIP.some((re) => re.test(rel))) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile() && st.size < 50 * 1024 * 1024) out.push({ rel, full, mtime: st.mtimeMs });
  }
  return out;
}
// The id git gives a file's contents, so unchanged files are recognized without uploading them.
const gitSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// Refuses to put your sessions in a public repository.
async function checkRepo() {
  if (!BACKUP_REPO || !/^[\w.-]+\/[\w.-]+$/.test(BACKUP_REPO)) throw new Error('Type the backup repository as owner/name in Settings → Backups.');
  if (!BACKUP_TOKEN) throw new Error('Add a GitHub token in Settings → Backups.');
  const repo = await gh('GET', '');
  if (!repo) throw new Error(`Can't find ${BACKUP_REPO}. Create it on GitHub as a Private repository, and give your token access to it.`);
  if (!repo.private) throw new Error(`${BACKUP_REPO} is public, so anyone could read your sessions. Make it private (GitHub → the repository → Settings → Change visibility), then try again.`);
  return repo;
}

let running = null;
export function backupNow(reason = 'manual') {
  if (running) return running;
  running = doBackup(reason).finally(() => { running = null; });
  return running;
}

async function doBackup(reason) {
  const st = state();
  try {
    await checkRepo();
    const ref = await gh('GET', `/git/ref/heads/${BRANCH}`);
    let parent = ref?.object?.sha ?? null;
    if (!parent) {
      // Empty repository: the Git Data API needs one commit first.
      await gh('PUT', '/contents/README.md', {
        message: 'Note Tiger backups',
        content: Buffer.from('# Note Tiger backups\n\nSessions, contacts and settings from Note Tiger. Keep this repository **private**.\n' +
          'To restore on a new PC: install Note Tiger, add this repository in Settings → Backups, then click **Restore**.\n').toString('base64'),
        branch: BRANCH,
      });
      parent = (await gh('GET', `/git/ref/heads/${BRANCH}`)).object.sha;
    }
    const baseTree = (await gh('GET', `/git/commits/${parent}`)).tree.sha;
    const existing = new Map(((await gh('GET', `/git/trees/${baseTree}?recursive=1`))?.tree ?? [])
      .filter((i) => i.type === 'blob').map((i) => [i.path, i.sha]));

    const files = walk(DATA_DIR);
    const tree = [];
    let uploaded = 0;
    for (const f of files) {
      const buf = fs.readFileSync(f.full);
      const p = `data/${f.rel}`;
      const sha = gitSha(buf);
      if (existing.get(p) === sha) { existing.delete(p); continue; }
      existing.delete(p);
      const blob = await gh('POST', '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' });
      tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
      uploaded++;
    }
    // Files deleted here (e.g. a removed session) are removed from the backup too; history keeps old copies.
    let removed = 0;
    for (const p of existing.keys()) if (p.startsWith('data/')) { tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); removed++; }

    if (tree.length) {
      const newTree = await gh('POST', '/git/trees', { base_tree: baseTree, tree });
      const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const commit = await gh('POST', '/git/commits', { message: `Backup ${when} (${uploaded} changed, ${removed} removed)`, tree: newTree.sha, parents: [parent] });
      await gh('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
    }
    Object.assign(st, { last: new Date().toISOString(), lastError: null, files: files.length, changed: uploaded, removed, repo: BACKUP_REPO });
    saveState(st);
    console.log(`[backup] ${tree.length ? `${uploaded} changed, ${removed} removed` : 'nothing changed'} (${files.length} files, ${reason})`);
    return backupStatus();
  } catch (err) {
    Object.assign(st, { lastError: err.message, lastErrorAt: new Date().toISOString() });
    saveState(st);
    console.error('[backup]', err.message);
    throw err;
  }
}

// Downloads the backup into the data folder. Files that already match are left alone.
export async function restoreBackup() {
  await checkRepo();
  const ref = await gh('GET', `/git/ref/heads/${BRANCH}`);
  if (!ref) throw new Error(`${BACKUP_REPO} doesn't have a backup in it yet.`);
  const commit = await gh('GET', `/git/commits/${ref.object.sha}`);
  const items = ((await gh('GET', `/git/trees/${commit.tree.sha}?recursive=1`))?.tree ?? [])
    .filter((i) => i.type === 'blob' && i.path.startsWith('data/'));
  let written = 0;
  for (const i of items) {
    const rel = i.path.slice(5);
    if (rel.split('/').some((part) => part === '..' || part === '')) continue;
    const dest = path.join(DATA_DIR, ...rel.split('/'));
    if (fs.existsSync(dest) && gitSha(fs.readFileSync(dest)) === i.sha) continue;
    const blob = await gh('GET', `/git/blobs/${i.sha}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(blob.content, 'base64'));
    written++;
  }
  console.log(`[backup] restored ${written} file(s) from ${BACKUP_REPO}`);
  return { restored: written, total: items.length, from: commit.message };
}

// Checked every hour: back up when something changed and the last backup is a day old, and at least weekly.
export function startBackupSchedule() {
  const check = () => {
    if (!backupConfigured() || running) return;
    const st = state();
    const last = st.last ? Date.parse(st.last) : 0;
    const age = Date.now() - last;
    const changed = walk(DATA_DIR).some((f) => f.mtime > last);
    if ((changed && age > DAY) || age > 7 * DAY || (st.lastError && Date.now() - Date.parse(st.lastErrorAt || 0) > 6 * 3600_000 && changed)) {
      backupNow('scheduled').catch(() => {});
    }
  };
  setTimeout(check, 2 * 60_000);
  setInterval(check, 3600_000);
}
