// Local control panel: http://localhost:3080 (only reachable from this computer).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(here, '.env');
const ENV_EXAMPLE = path.join(here, '.env.example');

// Settings the panel can edit. Secrets are never sent back to the browser, only whether they're set.
export const SETTINGS = [
  { key: 'DISCORD_TOKEN', secret: true },
  { key: 'ANTHROPIC_API_KEY', secret: true },
  { key: 'CAMPAIGN_NAME' },
  { key: 'CLAUDE_MODEL' },
  { key: 'OLLAMA_MODEL' },
  { key: 'WHISPER_MODEL' },
  { key: 'SEPARATE_TABLE_TALK' },
  { key: 'LOG_CHANNEL' },
  { key: 'RECAP_CHANNEL' },
  { key: 'GM_ROLE' },
  { key: 'SKIP_OPENING_RECAP' },
  { key: 'SITE_ENABLED' },
  { key: 'SITE_REPO' },
  { key: 'GITHUB_TOKEN', secret: true },
  { key: 'SITE_PASSWORD', secret: true },
  { key: 'SITE_SHARE_PASSWORD' },
];

function readEnvLines() {
  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(fs.existsSync(ENV_EXAMPLE) ? ENV_EXAMPLE : ENV_FILE, ENV_FILE);
  }
  return fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
}

export function readEnv() {
  const out = {};
  for (const line of readEnvLines()) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function writeEnv(changes) {
  const lines = readEnvLines();
  const done = new Set();
  const updated = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && m[1] in changes) { done.add(m[1]); return `${m[1]}=${changes[m[1]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(changes)) if (!done.has(k)) updated.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, updated.join('\n'));
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('Request too large');
  }
  return data ? JSON.parse(data) : {};
}

// ctx: functions supplied by index.js
export function startWeb(ctx, port) {
  const server = http.createServer(async (req, res) => {
    // Block requests from other websites (they can't read localhost, but they could try to POST).
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Forbidden' });
    if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') {
      return send(res, 415, { error: 'Expected JSON' });
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/favicon.png') {
        const icon = path.join(here, 'tiger.png');
        if (fs.existsSync(icon)) return send(res, 200, fs.readFileSync(icon), 'image/png');
        return send(res, 404, { error: 'Not found' });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, fs.readFileSync(path.join(here, 'ui.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });

      // GET /api/status
      if (parts[1] === 'status' && req.method === 'GET') return send(res, 200, ctx.status());

      // GET/POST /api/settings
      if (parts[1] === 'settings') {
        if (req.method === 'GET') {
          const env = readEnv();
          const out = {};
          for (const s of SETTINGS) out[s.key] = s.secret ? { set: Boolean(env[s.key]) } : (env[s.key] ?? '');
          return send(res, 200, out);
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const changes = {};
          for (const s of SETTINGS) {
            if (!(s.key in body)) continue;
            const v = String(body[s.key] ?? '').replace(/[\r\n]/g, '').trim();
            if (s.secret && v === '' && !body[`clear_${s.key}`]) continue; // empty = keep existing secret
            changes[s.key] = v;
          }
          writeEnv(changes);
          return send(res, 200, { ok: true });
        }
      }

      // GET /api/progress
      if (parts[1] === 'progress' && req.method === 'GET') return send(res, 200, ctx.progress());

      // GET /api/logs
      if (parts[1] === 'logs' && req.method === 'GET') return send(res, 200, ctx.logs());

      // POST /api/setup-local-ai  (opens a window that installs Ollama + the model)
      if (parts[1] === 'setup-local-ai' && req.method === 'POST') { ctx.setupLocalAI(); return send(res, 200, { ok: true }); }

      // POST /api/site/publish {all: true} or {gid, id}
      if (parts[1] === 'site' && parts[2] === 'publish' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, await ctx.publishSite(body));
      }

      // POST /api/bot/start, /api/bot/stop
      if (parts[1] === 'bot' && req.method === 'POST') {
        if (parts[2] === 'start') { ctx.startBot(); return send(res, 200, { ok: true }); }
        if (parts[2] === 'stop') { await ctx.stopBot(); return send(res, 200, { ok: true }); }
      }

      // POST /api/stop  (quit Note Tiger completely: tray "Quit" and the installer use this)
      if (parts[1] === 'stop' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setTimeout(() => ctx.quit(), 100);
        return;
      }

      // POST /api/restart
      if (parts[1] === 'restart' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setTimeout(() => ctx.restart(), 300);
        return;
      }

      // GET /api/sessions/:guild
      if (parts[1] === 'sessions' && parts[2] && !parts[3] && req.method === 'GET') {
        return send(res, 200, ctx.listSessions(parts[2]));
      }

      // /api/sessions/:guild/:id  (GET read, DELETE remove)  /recap (POST regenerate)  /transcript (GET download)
      if (parts[1] === 'sessions' && parts[2] && parts[3]) {
        const [guild, id, action] = [parts[2], decodeURIComponent(parts[3]), parts[4]];
        if (!action && req.method === 'GET') return send(res, 200, ctx.readSession(guild, id));
        if (!action && req.method === 'DELETE') { ctx.deleteSession(guild, id); return send(res, 200, { ok: true }); }
        if (action === 'recap' && req.method === 'POST') return send(res, 200, { recap: await ctx.regenerateRecap(guild, id) });
        if (action === 'repost' && req.method === 'POST') return send(res, 200, await ctx.repostSession(guild, id));
        if (action === 'transcript' && req.method === 'GET') {
          const s = ctx.readSession(guild, id);
          const asText = url.searchParams.get('format') === 'txt';
          res.writeHead(200, {
            'Content-Type': asText ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
            'Content-Disposition': `attachment; filename="transcript-${s.date || id}.${asText ? 'txt' : 'html'}"`,
          });
          return res.end(asText ? s.transcript : ctx.transcriptHtml(guild, id));
        }
      }

      // POST /api/ask {guild, question}
      if (parts[1] === 'ask' && req.method === 'POST') {
        const { guild, question } = await readBody(req);
        if (!guild || !question) return send(res, 400, { error: 'Pick a server and type a question.' });
        return send(res, 200, { answer: await ctx.ask(guild, String(question).slice(0, 2000)) });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[panel]', err);
      return send(res, 500, { error: err.message });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Is Note Tiger (or the old start-bot.bat window) already running? Close it and try again.`);
      process.exit(3);
    }
    console.error('Control panel error:', err.message);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Control panel: http://localhost:${port}`));
  return server;
}
