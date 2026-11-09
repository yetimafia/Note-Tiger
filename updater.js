// Updates: checks GitHub for a newer Note Tiger release, downloads its installer and runs it.
// The installer closes Note Tiger, updates it (settings, sessions and books are kept) and starts it again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { APP_DIR, UPDATE_REPO, UPDATE_CHECK } from './config.js';

export const CURRENT_VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

let info = { current: CURRENT_VERSION, latest: null, newer: false, checkedAt: null, error: null };
let download = null;   // { state: 'downloading'|'starting'|'failed', got, total, error }

// GET with redirects (GitHub downloads redirect to its file servers). Resolves with the response stream.
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'NoteTiger', Accept: 'application/vnd.github+json, application/octet-stream' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), hops + 1));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('timed out')));
  });
}
async function getJSON(url) {
  const res = await get(url);
  let body = '';
  for await (const c of res) body += c;
  return { status: res.statusCode, data: (() => { try { return JSON.parse(body); } catch { return {}; } })() };
}

const parse = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
export function isNewer(a, b) {   // is a newer than b?
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export function updateStatus() {
  return { ...info, enabled: UPDATE_CHECK, canInstall: process.platform === 'win32', download };
}

export async function checkForUpdate() {
  try {
    const { status, data: rel } = await getJSON(`${process.env.GITHUB_API || 'https://api.github.com'}/repos/${UPDATE_REPO}/releases/latest`);
    if (status === 404) { info = { ...info, latest: null, newer: false, checkedAt: new Date().toISOString(), error: null }; return updateStatus(); }
    if (status !== 200) throw new Error(`GitHub answered ${status}`);
    const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    info = {
      current: CURRENT_VERSION, latest, newer: Boolean(asset) && isNewer(latest, CURRENT_VERSION),
      notes: String(rel.body || '').slice(0, 4000), url: rel.html_url, published: rel.published_at,
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
      checkedAt: new Date().toISOString(), error: null,
    };
    if (info.newer) console.log(`[update] Note Tiger ${latest} is available (you have ${CURRENT_VERSION}).`);
  } catch (err) {
    info = { ...info, checkedAt: new Date().toISOString(), error: `Couldn't check for updates (${err.message}).` };
  }
  return updateStatus();
}

// Downloads the installer, then runs it silently in update mode. beforeInstall() lets the manager stop the bot first.
export async function installUpdate(beforeInstall = async () => {}) {
  if (process.platform !== 'win32') throw new Error('Updating from the app works on Windows. Download the installer from GitHub instead.');
  if (download?.state === 'downloading' || download?.state === 'starting') return updateStatus();
  if (!info.newer || !info.asset) await checkForUpdate();
  if (!info.newer || !info.asset) throw new Error('You already have the newest version.');
  const { url, size, name } = info.asset;
  const dest = path.join(os.tmpdir(), name.replace(/[^\w.-]+/g, '_'));
  download = { state: 'downloading', got: 0, total: size, error: null };
  (async () => {
    try {
      const res = await get(url);
      if (res.statusCode !== 200) { res.resume(); throw new Error(`download failed (${res.statusCode})`); }
      const out = fs.createWriteStream(dest);
      for await (const chunk of res) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        download.got += chunk.length;
      }
      await new Promise((ok, fail) => out.end((err) => (err ? fail(err) : ok())));
      const head = Buffer.alloc(2);
      const fd = fs.openSync(dest, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
      if (head.toString() !== 'MZ' || (size && fs.statSync(dest).size !== size)) throw new Error('the download looks broken; try again');
      download.state = 'starting';
      console.log(`[update] installing ${info.latest}. Note Tiger will close and reopen in about a minute.`);
      await beforeInstall();
      // /S = no questions, /UPDATE = keep shortcuts as they are, skip the local-AI download, start Note Tiger after.
      spawn(dest, ['/S', '/UPDATE'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } catch (err) {
      download = { ...download, state: 'failed', error: err.message };
      console.error('[update]', err.message);
    }
  })();
  return updateStatus();
}

export function startUpdateChecks() {
  if (!UPDATE_CHECK) return;
  setTimeout(() => checkForUpdate(), 30_000);
  setInterval(() => checkForUpdate(), 6 * 3600_000);
}
