import { createStreamingRedactor, filterOutput } from './dist/output.js';
function streamFixed(text,size){const out=[];const r=createStreamingRedactor(c=>out.push(c));const live=[];for(let i=0;i<text.length;i+=size){r.push(text.slice(i,i+size));}const l=out.join('');r.flush();return {full:out.join(''),live:l};}
// R4: JWT with header 1025..8000 chars
for(const hlen of [1025,2000,5000,8000]){
  const header='eyJ'+'A'.repeat(hlen-3);
  const jwt=`${header}.eyJ${'B'.repeat(40)}.${'C'.repeat(40)}`;
  const text=`auth ${jwt} ok`;
  let leak=false;
  for(const s of [1,7,64,500,8193]){
    const {full,live}=streamFixed(text,s);
    if(live.includes(header)||full.includes(header)) leak=true;
    if(!full.includes('***JWT_REDACTED***')) leak=true;
  }
  console.log('header len',hlen,'redacted-never-raw:', !leak);
}
// double JWT analog
const h='eyJ'+'A'.repeat(200);
const jwt=`${h}.eyJ${'B'.repeat(40)}.${'C'.repeat(40)}`;
const two=`${jwt} ${jwt.slice(0,h.length+30)}`; // second one unterminated
console.log('double-jwt filterOutput leaks header:', filterOutput(two).includes(h));
for(const s of [5,13,64]) console.log('  size',s,'stream leaks h:',streamFixed(two,s).full.includes(h)||streamFixed(two,s).live.includes(h));
