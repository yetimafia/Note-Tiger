import fs from 'node:fs'; import * as S from './sheets.js';
const b = await S.readFormBoxes(fs.readFileSync(process.argv[2]));
console.log('boxes', b.length);
for (const x of b) console.log(`${x.page} ${x.type.padEnd(8)} ${JSON.stringify(x.name).padEnd(30)} = ${JSON.stringify(x.value).slice(0,60).padEnd(40)} | ${x.label.slice(0,60)}`);
