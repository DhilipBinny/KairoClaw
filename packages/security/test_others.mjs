import { createStreamingRedactor } from './dist/output.js';
const cases = {
  dburl:    'postgres://' + 'a'.repeat(40000),
  password: 'password=' + 'a'.repeat(40000),
  oauth:    'access_token=' + 'a'.repeat(40000),
  master:   'master_key=' + 'a'.repeat(40000),
};
for (const [name, big] of Object.entries(cases)) {
  const out = [];
  const r = createStreamingRedactor((c) => out.push(c));
  const t0 = Date.now();
  for (let i = 0; i < big.length; i += 1000) r.push(big.slice(i, i+1000));
  const t1 = Date.now();
  r.flush();
  console.log(name, 'time=', (t1-t0), 'ms  leaks=', out.join('').includes('a'.repeat(40)), ' out:', JSON.stringify(out.join('').slice(0,40)));
}
