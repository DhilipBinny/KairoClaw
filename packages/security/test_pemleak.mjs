import { createStreamingRedactor, filterOutput } from './dist/output.js';
function streamFixed(text,size){const out=[];const r=createStreamingRedactor(c=>out.push(c));for(let i=0;i<text.length;i+=size)r.push(text.slice(i,i+size));r.flush();return out.join('');}

const body='MIIEvQIBADANBgkqhkiG9w0BAQ'+'A'.repeat(100);
// Case A: clean single PEM
const a=`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
console.log('A filterOutput leaks body:', filterOutput(a).includes('MIIEvQ'));
for(const s of [1,3,5,13]) console.log('A size',s,'leaks:',streamFixed(a,s).includes('MIIEvQ'));

// Case B: PEM immediately followed by another BEGIN (no separator) — the mashed double-PEM
const b=`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY----------BEGIN PRIVATE KEY-----\n${body}`;
console.log('\nB filterOutput leaks body:', filterOutput(b).includes('MIIEvQ'), 'filtered:', JSON.stringify(filterOutput(b)));
for(const s of [1,3,5,13]) console.log('B size',s,'leaks:',streamFixed(b,s).includes('MIIEvQ'));
