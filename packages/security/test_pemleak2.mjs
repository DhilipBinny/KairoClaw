import { createStreamingRedactor, filterOutput } from './dist/output.js';
function streamFixed(text,size){const out=[];const r=createStreamingRedactor(c=>out.push(c));for(let i=0;i<text.length;i+=size)r.push(text.slice(i,i+size));r.flush();return out.join('');}

const body='MIIEvQIBADANBgkqhkiG9w0BAQ'+'A'.repeat(100);
// exact-ish from fuzz repro (size 5): single clean PEM then ghp_ then master key then sk- then partial BEGIN
const text=`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAGW_MASTER_KEY=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==sk------BEGIN PRI`;
const f=filterOutput(text);
console.log('filterOutput keeps body MIIEvQ:', f.includes('MIIEvQ'));
console.log('filtered:', JSON.stringify(f.slice(0,120)));
for(const s of [1,3,5,13]){
  const o=streamFixed(text,s);
  console.log('size',s,'stream leaks MIIEvQ:',o.includes('MIIEvQ'));
}
