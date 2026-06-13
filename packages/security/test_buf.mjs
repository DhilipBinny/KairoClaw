import { createStreamingRedactor, filterOutput } from './dist/output.js';

// Measure CPU and whether output is produced incrementally for a giant unterminated Bearer token.
const N = 2_000_000; // 2 MB token body
const out = [];
const r = createStreamingRedactor((c) => out.push(c));
r.push('Bearer ');
const t0 = Date.now();
let emittedDuring = 0;
for (let i = 0; i < N/1000; i++) {
  r.push('a'.repeat(1000));
  emittedDuring = out.length;
}
const t1 = Date.now();
console.log('push time for', N, 'chars:', (t1-t0), 'ms');
console.log('emitted chunks during streaming (before flush):', emittedDuring);
r.flush();
console.log('total output length:', out.join('').length);
console.log('leaks aaaa(40):', out.join('').includes('a'.repeat(40)));
