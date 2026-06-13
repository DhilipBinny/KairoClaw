import { createStreamingRedactor } from './dist/output.js';
for (const prefix of ['Bearer ', 'password=']) {
  const out = [];
  const r = createStreamingRedactor((c) => out.push(c));
  r.push(prefix);
  // push and after every 5000 chars, time a single push to detect growing cost
  let big = 'a'.repeat(1000);
  let t0 = Date.now();
  for (let i = 0; i < 30; i++) r.push(big);
  console.log(prefix, '30k chars time', Date.now()-t0, 'ms, outLen', out.join('').length);
}
