const PEM_BEGIN=/-----BEGIN (?:RSA )?PRIVATE KEY-----/;
const PEM_END=/-----END (?:RSA )?PRIVATE KEY-----/;
const body='MIIEvQ'+'A'.repeat(100);
const pem=`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
// buffer state: full first PEM + separator + begin + partial body of 2nd (no END yet)
const buf=`${pem}_-----BEGIN PRIVATE KEY-----\n${body.slice(0,60)}`;
const pm=PEM_BEGIN.exec(buf);
console.log('first BEGIN index:', pm.index);
console.log('PEM_END after first BEGIN exists:', PEM_END.test(buf.slice(pm.index)));
console.log('=> heldStart does NOT hold for PEM (first BEGIN has an END). 2nd body is releasable.');
