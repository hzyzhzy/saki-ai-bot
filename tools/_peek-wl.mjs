import { readFileSync } from 'node:fs';

const t = readFileSync('C:/SnowLuma/index.mjs', 'utf8').split(/\r?\n/);
for (let n = 4905; n < 4940; n++) console.log(`${n + 1}: ${t[n]}`);
