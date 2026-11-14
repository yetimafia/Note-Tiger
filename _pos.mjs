import fs from 'node:fs';
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(process.argv[2])), verbosity: 0 }).promise;
const out = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  for (const a of await page.getAnnotations()) if (a.subtype === 'Widget') out.push({ p, n: a.fieldName, t: a.checkBox ? 'c' : 't', r: a.rect, ml: !!a.multiLine, ph: vp.height });
}
fs.writeFileSync('/tmp/pos.json', JSON.stringify(out));
console.log(out.length);
