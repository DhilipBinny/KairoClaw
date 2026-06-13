import { createStreamingRedactor, filterOutput } from './dist/output.js';

const big = 'Bearer ' + 'a'.repeat(30000);
console.log('filterOutput(whole):', JSON.stringify(filterOutput(big).slice(0,60)));

const out = [];
const r = createStreamingRedactor((c) => out.push(c));
for (let i = 0; i < big.length; i += 1000) r.push(big.slice(i, i+1000));
const live = out.join('');
r.flush();
const full = out.join('');
console.log('live leaks aaaa(40):', live.includes('a'.repeat(40)));
console.log('full leaks aaaa(40):', full.includes('a'.repeat(40)));
console.log('full contains REDACTED:', full.includes('REDACTED'));
console.log('full length:', full.length, 'first 80:', JSON.stringify(full.slice(0,80)));
