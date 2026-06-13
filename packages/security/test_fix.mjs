// Simulate the fixed heldStart: hold from the FIRST BEGIN that has no END after it,
// scanning all BEGINs.
const PEM_BEGIN_G=/-----BEGIN (?:RSA )?PRIVATE KEY-----/g;
const PEM_END=/-----END (?:RSA )?PRIVATE KEY-----/;
function fixedHeldStartPemIndex(buf){
  let m, last=-1;
  PEM_BEGIN_G.lastIndex=0;
  while((m=PEM_BEGIN_G.exec(buf))){
    if(!PEM_END.test(buf.slice(m.index))) { last=m.index; break; }
  }
  return last;
}
const body='MIIEvQ'+'A'.repeat(100);
const pem=`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
const buf=`${pem}_-----BEGIN PRIVATE KEY-----\n${body.slice(0,60)}`;
console.log('fixed hold index (should point at 2nd BEGIN, not -1):', fixedHeldStartPemIndex(buf));
console.log('that index char:', JSON.stringify(buf.slice(fixedHeldStartPemIndex(buf), fixedHeldStartPemIndex(buf)+30)));
