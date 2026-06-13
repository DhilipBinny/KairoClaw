import { createStreamingRedactor, filterOutput } from './dist/output.js';
function streamFixed(text,size){const out=[];const r=createStreamingRedactor(c=>out.push(c));for(let i=0;i<text.length;i+=size)r.push(text.slice(i,i+size));r.flush();return out.join('');}
const body='MIIEvQIBADANBgkqhkiG9w0BAQ'+'A'.repeat(100);
const pem=`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;

// Two PEMs separated by a single underscore (a NON_TOKEN... no, _ IS a token char)
const two=`${pem}_${pem}`;
console.log('filterOutput leaks body:', filterOutput(two).includes('MIIEvQ'));
for(const s of [1,3,5,13,64]) console.log('  size',s,'stream leaks:',streamFixed(two,s).includes('MIIEvQ'));

// separated by space
const twoSp=`${pem} ${pem}`;
console.log('space-sep filterOutput leaks:', filterOutput(twoSp).includes('MIIEvQ'));
for(const s of [1,3,5,13,64]) console.log('  size',s,'stream leaks:',streamFixed(twoSp,s).includes('MIIEvQ'));

// separated by nothing
const twoNo=`${pem}${pem}`;
console.log('no-sep filterOutput leaks:', filterOutput(twoNo).includes('MIIEvQ'));
for(const s of [1,5,13]) console.log('  size',s,'stream leaks:',streamFixed(twoNo,s).includes('MIIEvQ'));
