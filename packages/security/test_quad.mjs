import { createStreamingRedactor } from './dist/output.js';
for (const N of [250000, 500000, 1000000]) {
  const out = [];
  const r = createStreamingRedactor((c) => out.push(c));
  r.push('Bearer ');
  const t0 = Date.now();
  for (let i = 0; i < N/1000; i++) r.push('a'.repeat(1000));
  const t1 = Date.now();
  console.log('N=', N, 'time=', (t1-t0), 'ms');
}
