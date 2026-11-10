// The campaign book: the whole campaign as one PDF, for printing or catching up a new player.
// Story so far, runners, run history, contacts, places, loose ends, every session's recap, and the best quotes.
// GM-only material (NPC voice cards, prep notes) is left out.
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { APP_DIR, CAMPAIGN_NAME } from './config.js';
import { listSessions, readJSON, sessionStats, formatDuration, knownGuilds } from './store.js';
import { buildCampaign, latestStory, allQuotes } from './campaign.js';

const FONTS = path.join(APP_DIR, 'fonts');
const C = { ink: '#1d1d24', dim: '#6b6f7a', accent: '#d9600b', rule: '#e4dccf', soft: '#f6f1e8' };

// Emoji and other symbols the font can't draw are dropped (they'd print as boxes).
const plain = (t) => String(t ?? '')
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
  .replace(/[ \t]+/g, ' ').trim();

export async function campaignBook(gid) {
  const sessions = listSessions(gid).filter((s) => fs.existsSync(path.join(s.dir, 'recap.md')));
  const c = buildCampaign(gid);
  const story = latestStory(gid);
  const quotes = allQuotes(gid);
  const server = knownGuilds().find((g) => g.id === gid)?.name || '';

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 64, bottom: 64, left: 64, right: 64 }, bufferPages: true,
    info: { Title: `${CAMPAIGN_NAME}: campaign book`, Creator: 'Note Tiger' } });
  doc.registerFont('body', path.join(FONTS, 'DejaVuSans.ttf'));
  doc.registerFont('bold', path.join(FONTS, 'DejaVuSans-Bold.ttf'));
  doc.registerFont('italic', path.join(FONTS, 'DejaVuSans-Oblique.ttf'));
  const chunks = [];
  doc.on('data', (b) => chunks.push(b));
  const done = new Promise((ok) => doc.on('end', ok));
  const W = doc.page.width - 128;

  const space = (n = 8) => { doc.y += n; };
  const ensure = (h) => { if (doc.y + h > doc.page.height - 72) doc.addPage(); };
  const para = (text, { font = 'body', size = 10.5, color = C.ink, indent = 0, gap = 5 } = {}) => {
    const t = plain(text); if (!t) return;
    doc.font(font).fontSize(size).fillColor(color).text(t, 64 + indent, doc.y, { width: W - indent, lineGap: 2 });
    space(gap);
  };
  // **bold** spans inside a line.
  const rich = (text, { size = 10.5, indent = 0, bullet = false } = {}) => {
    const t = plain(text).replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1$2'); if (!t) return;
    ensure(size * 2);
    const x = 64 + indent;
    if (bullet) { const y = doc.y; doc.font('body').fontSize(size).fillColor(C.accent).text('•', x - 10, y, { lineBreak: false }); doc.y = y; }
    const parts = t.split(/\*\*/);
    doc.x = x;
    parts.forEach((p, i) => {
      if (!p) return;
      doc.font(i % 2 ? 'bold' : 'body').fontSize(size).fillColor(C.ink)
        .text(p, i === 0 || doc.x === x ? x : undefined, undefined, { width: W - indent, lineGap: 2, continued: i < parts.length - 1 && parts.slice(i + 1).some(Boolean) });
    });
    space(4);
  };
  const h1 = (text) => {
    doc.addPage();
    doc.font('bold').fontSize(22).fillColor(C.accent).text(plain(text), 64, 64, { width: W });
    doc.moveTo(64, doc.y + 4).lineTo(64 + W, doc.y + 4).lineWidth(2).strokeColor(C.accent).stroke();
    space(16);
    toc.push({ title: plain(text), page: doc.bufferedPageRange().count });
  };
  const h2 = (text, sub = '') => {
    ensure(60);
    space(6);
    doc.font('bold').fontSize(14).fillColor(C.ink).text(plain(text), 64, doc.y, { width: W });
    if (sub) doc.font('body').fontSize(9.5).fillColor(C.dim).text(plain(sub), { width: W });
    space(6);
  };
  const h3 = (text) => {
    ensure(40); space(4);
    doc.font('bold').fontSize(11.5).fillColor(C.accent).text(plain(text).replace(/\*\*/g, ''), 64, doc.y, { width: W });
    space(3);
  };
  // A recap or story in Discord markdown.
  const markdown = (md) => {
    for (const raw of String(md || '').split('\n')) {
      const line = raw.trim();
      if (!line) { space(3); continue; }
      if (/^#{1,6}\s/.test(line)) { h3(line.replace(/^#+\s*/, '')); continue; }
      if (/^\*\*[^*]+\*\*\s*(—.*)?$/.test(line) && line.length < 90) { h3(line); continue; }
      if (/^[-*•]\s+/.test(line)) { rich(line.replace(/^[-*•]\s+/, ''), { indent: 14, bullet: true }); continue; }
      if (/^>\s?/.test(line)) { para(line.replace(/^>\s?/, ''), { font: 'italic', color: C.dim, indent: 10 }); continue; }
      rich(line);
    }
  };
  const toc = [];

  // ---- cover ----
  const logo = path.join(FONTS, 'tiger-256.png');
  doc.rect(0, 0, doc.page.width, doc.page.height).fill('#14161f');
  if (fs.existsSync(logo)) doc.image(logo, doc.page.width / 2 - 90, 150, { width: 180 });
  doc.font('bold').fontSize(34).fillColor('#ffffff').text(plain(CAMPAIGN_NAME), 64, 360, { width: W, align: 'center' });
  doc.font('body').fontSize(14).fillColor('#ffb032').text('Campaign book', 64, doc.y + 8, { width: W, align: 'center' });
  const first = sessions[0], last = sessions.at(-1);
  doc.font('body').fontSize(11).fillColor('#aab0c0').text(
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}${first ? ` · ${first.date}${last !== first ? ` to ${last.date}` : ''}` : ''}${server ? ` · ${server}` : ''}`,
    64, doc.y + 18, { width: W, align: 'center' });
  doc.font('body').fontSize(9).fillColor('#6b7184').text(`Made by Note Tiger on ${new Date().toISOString().slice(0, 10)}`, 64, doc.page.height - 100, { width: W, align: 'center' });
  doc.addPage();   // contents go here (filled in at the end)
  const tocPage = doc.bufferedPageRange().count - 1;

  // ---- the story so far ----
  if (story) {
    h1('The story so far');
    para(`Through ${story.title} (${story.date})`, { color: C.dim, size: 9.5 });
    for (const p of story.text.split(/\n\s*\n/)) para(p, { gap: 8 });
  }

  // ---- runners ----
  if (c.runners.length) {
    h1('The runners');
    for (const r of c.runners) {
      h2(r.name, `${r.player ? `Played by ${r.player} · ` : ''}${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'}`);
      if (r.status) rich(`**Right now:** ${r.status}`);
      if (r.gear.length) rich(`**Gear & chrome:** ${r.gear.join(', ')}`);
      const big = r.sessions.filter((x) => x.moment);
      if (big.length) { rich('**Big moments**'); for (const x of big) rich(`${x.moment} (${x.title})`, { indent: 14, bullet: true }); }
      rich('**Session by session**');
      for (const x of r.sessions) rich(`**${x.title}:** ${x.did}`, { indent: 14, bullet: true });
    }
  }

  // ---- runs ----
  if (c.jobs.length) {
    h1('Run history');
    for (const j of [...c.jobs].reverse()) {
      h2(j.name, [j.status, j.johnson && `hired by ${j.johnson}`, j.first?.title].filter(Boolean).join(' · '));
      if (j.task) para(j.task);
      if (j.payOffered) rich(`**Offered:** ${j.payOffered}`, { indent: 14, bullet: true });
      if (j.payReceived) rich(`**Got:** ${j.payReceived}`, { indent: 14, bullet: true });
      if (j.complications) rich(`**Complications:** ${j.complications}`, { indent: 14, bullet: true });
      if (j.outcome) rich(`**Outcome:** ${j.outcome}`, { indent: 14, bullet: true });
    }
  }

  // ---- contacts and places ----
  if (c.contacts.length) {
    h1('Contacts & NPCs');
    for (const n of c.contacts) {
      h2(n.name, [n.who, n.attitude && `attitude: ${n.attitude}`].filter(Boolean).join(' · '));
      for (const h of n.history) rich(`**${h.title}:** ${h.text}`, { indent: 14, bullet: true });
    }
  }
  if (c.places.length) {
    h1('Places');
    for (const p of c.places) {
      h2(p.name, p.what);
      for (const h of p.history) rich(`**${h.title}:** ${h.text}`, { indent: 14, bullet: true });
    }
  }
  if (c.open.length || c.closed.length) {
    h1('Loose ends');
    if (c.open.length) { h3('Still open'); for (const t of c.open) rich(`${t.text} (since ${t.opened?.title || '?'})`, { indent: 14, bullet: true }); }
    if (c.closed.length) { h3('Tied up'); for (const t of c.closed) rich(`${t.text}${t.how ? `: ${t.how}` : ''}`, { indent: 14, bullet: true }); }
  }

  // ---- sessions ----
  for (const s of sessions) {
    h1(`${s.title}`);
    const st = sessionStats(s.dir);
    const bits = [s.date, st?.totalMs > 1 && `${formatDuration(st.totalMs)} session`,
      st?.totalMs > 1 && `${st.gamePct}% playing, ${st.squirrelPct}% squirrels`, st?.combatMs > 60_000 && `${formatDuration(st.combatMs)} in combat`].filter(Boolean);
    para(bits.join(' · '), { color: C.dim, size: 9.5, gap: 10 });
    markdown(fs.readFileSync(path.join(s.dir, 'recap.md'), 'utf8'));
  }

  // ---- quotes ----
  if (quotes.length) {
    h1('Best lines');
    for (const q of quotes) {
      ensure(50);
      doc.font('italic').fontSize(12).fillColor(C.ink).text(`“${plain(q.quote)}”`, 64, doc.y, { width: W });
      doc.font('body').fontSize(9.5).fillColor(C.dim).text(`— ${plain(q.by)}${q.tableTalk ? ' (table talk)' : ''} · ${plain(q.title)}`, { width: W });
      space(10);
    }
  }

  // ---- contents, page numbers ----
  doc.switchToPage(tocPage);
  doc.font('bold').fontSize(22).fillColor(C.accent).text('Contents', 64, 64, { width: W });
  space(14);
  for (const e of toc) {
    if (doc.y > doc.page.height - 90) break;   // a very long campaign: the rest is still in the book
    const y = doc.y;
    doc.font('body').fontSize(11).fillColor(C.ink).text(e.title, 64, y, { width: W - 50, lineBreak: false, ellipsis: true });
    doc.font('body').fontSize(11).fillColor(C.dim).text(String(e.page), 64 + W - 40, y, { width: 40, align: 'right' });
    doc.y = y + 18;
  }
  const range = doc.bufferedPageRange();
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;   // the footer sits below the normal text area
    doc.font('body').fontSize(8.5).fillColor(C.dim)
      .text(`${plain(CAMPAIGN_NAME)} · ${i + 1}`, 64, doc.page.height - 44, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
