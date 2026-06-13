import { createStreamingRedactor, filterOutput } from './dist/output.js';

// All recognized secret tokens (well-formed, so filterOutput removes them).
const SECRETS = [
  'agw_sk_' + 'a'.repeat(64),
  'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'ant-ABCDEFGHIJKLMNOPQRSTUVWX',
  'Bearer abcdefghijklmnopqrstuvwxyz0123',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
  'postgres://user:pass@host:5432/db',
  'mysql://u:p@h/db',
  'mongodb+srv://u:p@h/db',
  'redis://u:p@h:6379',
  'access_token=abcdefghijklmnopqrstuvwxyz',
  'AKIAIOSFODNN7EXAMPLE',
  'AIza' + 'A'.repeat(35),
  'ghp_' + 'B'.repeat(36),
  'gho_' + 'C'.repeat(36),
  'ghs_' + 'D'.repeat(36),
  'github_pat_' + 'E'.repeat(30),
  'xoxb-1234567890-abcdefghij',
  'xoxp-9999999999-zzzzzzzzzz',
  'sk_live_' + 'F'.repeat(24),
  'pk_live_' + 'G'.repeat(24),
  '123456789:AAHfakeTokenABCDEFGHIJKLMNOPQRSTUVW',
  'BSA1234567890abcdefABCDEF_xyz',
  'AGW_MASTER_KEY=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==',
  'master_key: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXox',
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ' + 'A'.repeat(100) + '\n-----END PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIabc' + 'Z'.repeat(80) + '\n-----END RSA PRIVATE KEY-----',
  'password=hunter2hunter2',
  'client_secret=abcdefgh12345',
];

// The contiguous "needle" of each secret that must never appear raw if filterOutput removed it.
// For multi-line/structured ones we use a distinctive body substring.
const NEEDLES = [
  'agw_sk_' + 'a'.repeat(64),
  'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'ant-ABCDEFGHIJKLMNOPQRSTUVWX',
  'abcdefghijklmnopqrstuvwxyz0123', // bearer body
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0', // jwt payload
  'user:pass@host', // pg url body
  'AKIAIOSFODNN7EXAMPLE',
  'AIza' + 'A'.repeat(35),
  'ghp_' + 'B'.repeat(36),
  'gho_' + 'C'.repeat(36),
  'ghs_' + 'D'.repeat(36),
  'github_pat_' + 'E'.repeat(30),
  'xoxb-1234567890-abcdefghij',
  'sk_live_' + 'F'.repeat(24),
  'pk_live_' + 'G'.repeat(24),
  'AAHfakeTokenABCDEFGHIJKLMNOPQRSTUVW', // telegram secret
  'BSA1234567890abcdefABCDEF_xyz',
  'MIIEvQIBADANBgkqhkiG9w0BAQ', // pem body
  'MIIabc' + 'Z'.repeat(80),
  'hunter2hunter2',
];

const VOCAB = [
  'hello ', 'world ', 'the answer is ', 'eyJ', '.', '..', '_', '-', ' ', '\n', '\t',
  'A'.repeat(40), 'A'.repeat(300), 'token=', 'secret ', 'Bearer ', 'sk-', 'AKIA', 'AIza', 'ghp_',
  '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----',
  '123456789:', ':', '=', '"', "'", 'master_key', 'AGW_MASTER_KEY',
  'eyJhbGciOiJIUzI1NiJ9', 'http://', 'postgres://', 'xoxb-',
  ...SECRETS,
];

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

function streamFixed(text, size) {
  const out = [];
  const r = createStreamingRedactor((c) => out.push(c));
  for (let i = 0; i < text.length; i += size) r.push(text.slice(i, i + size));
  const live = out.join('');
  r.flush();
  return { full: out.join(''), live };
}

const rnd = lcg(0xC0FFEE);
let leaks = 0, checked = 0;
const sizes = [1, 2, 3, 5, 7, 13, 64, 200, 1000, 8191, 8192, 8193, 20000];

const ITERS = 60000;
for (let iter = 0; iter < ITERS; iter++) {
  // Build a random input. Sometimes very large to cross 8192.
  let text = '';
  const targetLen = rnd() < 0.3 ? 12000 + Math.floor(rnd() * 30000) : 0;
  const words = 1 + Math.floor(rnd() * 30);
  for (let w = 0; w < words; w++) text += VOCAB[Math.floor(rnd() * VOCAB.length)];
  while (text.length < targetLen) text += VOCAB[Math.floor(rnd() * VOCAB.length)];

  const filtered = filterOutput(text);
  const size = sizes[Math.floor(rnd() * sizes.length)];

  const t0 = Date.now();
  const { full, live } = streamFixed(text, size);
  const dt = Date.now() - t0;
  if (dt > 2000) { console.log('SLOW', dt, 'ms len', text.length, 'size', size); }

  checked++;
  // No-leak property: any needle that filterOutput removed must not appear raw in full output stream.
  for (let n = 0; n < NEEDLES.length; n++) {
    const needle = NEEDLES[n];
    const inWhole = text.includes(needle);
    if (!inWhole) continue;
    const filteredHasIt = filtered.includes(needle);
    if (filteredHasIt) continue; // filterOutput kept it; not a recognized-removed secret here
    if (full.includes(needle) || live.includes(needle)) {
      leaks++;
      if (leaks <= 10) {
        console.log('=== LEAK ===');
        console.log('needle:', JSON.stringify(needle.slice(0, 60)));
        console.log('chunk size:', size);
        console.log('input:', JSON.stringify(text.slice(0, 400)));
        console.log('inFull:', full.includes(needle), 'inLive:', live.includes(needle));
      }
    }
  }
}

console.log(`\nDone. iterations=${ITERS} checked=${checked} leaks=${leaks}`);
