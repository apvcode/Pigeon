const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/preload.js'), 'utf8');
function extract(name, next) {
  return source.slice(source.indexOf(`  function ${name}(`), source.indexOf(`  function ${next}(`));
}
let writes = 0;
const document = {
  getElementById: () => ({}),
  head: { appendChild: () => writes++ },
  querySelector: () => null,
  querySelectorAll: () => { throw Error('Unscoped document scan'); },
  get body() { throw Error('Entire message history accessed'); }
};
const context = vm.createContext({ document, window: { location: { href: 'https://chat.x.com/i/chat/test', hash: '' } }, console });
vm.runInContext(extract('ensureStyles', 'flashSettingFeedback') + extract('isSettingsViewActive', 'findSettingsInsertTarget') + extract('findMarkAllReadRow', 'updatePrivacyDropdownItem'), context);
for (let i = 0; i < 100; i++) {
  vm.runInContext('ensureStyles()', context);
  assert.equal(vm.runInContext('isSettingsViewActive()', context), false);
  assert.equal(vm.runInContext('findMarkAllReadRow()', context), null);
}
assert.equal(writes, 0, 'Repeated checks must not reinsert CSS');
console.log('PASS: 100 repeated checks: no stylesheet writes, no full-history reads, no document-wide menu scans');
