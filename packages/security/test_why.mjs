import { filterOutput } from './dist/output.js';
function check(buf) {
  const cut = buf.length - 128;
  const head = buf.slice(0, cut), tail = buf.slice(cut);
  const ok = filterOutput(buf) === filterOutput(head) + filterOutput(tail);
  return ok;
}
console.log('bearer guard ok (releases):', check('Bearer ' + 'a'.repeat(9000)));
console.log('password guard ok (releases):', check('password=' + 'a'.repeat(9000)));
