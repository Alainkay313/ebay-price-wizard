// Run with Node.js 18+: node --test test-content.cjs
// Unit tests execute the shipped helpers with a small DOM stub. Not a live eBay test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const context = vm.createContext({
  localStorage: { getItem: () => null },
  Event: class { constructor(type) { this.type = type; } },
  setTimeout: () => {},
});
// Stop before the browser bootstrap; expose existing helpers only inside the test.
vm.runInContext(source.slice(0, source.indexOf('  // ─── Bootstrap')) +
  '\nglobalThis.api = { safeFloat, normalizeHdd, parseCameraQty, parseChannel, ' +
  'matchColumnRole, isPriceEmpty, processVisibleRows, skuTokenFor, setInputValue }; })();', context);
const api = context.api;
function row(channel = '8 channel', hdd = '2TB', cameras = '4 cameras', value = '') {
  const input = {
    value, style: {}, events: [], focus() {},
    dispatchEvent(event) { this.events.push(event.type); }
  };
  const cells = [channel, hdd, cameras].map(textContent => ({ textContent }));
  cells.push({ querySelector: () => input });
  return { input, querySelectorAll: () => cells };
}
function run(rows, options = {}, preview = false, ids = new Set()) {
  const logs = [];
  const config = {
    channelPrices: { 8: 100 }, hddPrices: { '2tb': 50 }, cameraPrice: 20,
    enabledHdds: new Set(['2tb']), onlyEmpty: true, promoMultiplier: 1, ...options
  };
  const result = api.processVisibleRows({ querySelectorAll: () => rows },
    { nvr: 0, hdd: 1, camera: 2, price: 3 }, config, ids, logs, preview);
  return { ...result, logs };
}
test('finite numeric input and formatted pounds', () => {
  assert.equal(api.safeFloat('£1,234.50'), 1234.5);
  for (const bad of ['', 'abc', '12oops', 'Infinity', 'NaN', '1e999']) {
    assert.equal(api.safeFloat(bad), null);
  }
});
test('HDD, camera and channel parsing', () => {
  assert.equal(api.normalizeHdd('No Hard Drive'), '0tb');
  assert.equal(api.normalizeHdd('6T'), '6tb');
  assert.equal(api.normalizeHdd('500GB'), '500gb');
  assert.equal(api.normalizeHdd('unknown'), null);
  assert.equal(api.parseCameraQty('NO Camera (Only NVR)'), 0);
  assert.equal(api.parseCameraQty('4x camera'), 4);
  assert.equal(api.parseChannel('32ch'), 32);
});
test('base price and input/change/blur events', () => {
  const r = row();
  assert.equal(run([r]).processed, 1);
  assert.equal(r.input.value, '230.00');
  assert.deepEqual(r.input.events, ['input', 'change', 'blur']);
});
test('promotion divides by 0.88 for an input of 10', () => {
  const r = row();
  run([r], { promoMultiplier: 100 / (100 - 10 * 1.2) });
  assert.equal(r.input.value, '261.36');
});
test('preview shows calculated price without editing the field', () => {
  const r = row();
  const result = run([r], {}, true);
  assert.equal(r.input.value, '');
  assert.equal(r.input.events.length, 0);
  assert.match(result.logs[0], /230\.00/);
});
test('only-empty preserves existing prices and accepts zero variants', () => {
  const existing = row('8ch', '2TB', '4', '999.99');
  assert.equal(run([existing]).processed, 0);
  assert.equal(existing.input.value, '999.99');
  for (const value of ['', '0', '0.0', '0.00', '£0.00']) {
    assert.equal(api.isPriceEmpty({ value }), true);
  }
  run([existing], { onlyEmpty: false });
  assert.equal(existing.input.value, '230.00');
});
test('unknown or disabled HDDs never silently cost zero', () => {
  const unknown = row('8ch', '3TB');
  assert.equal(run([unknown], { enabledHdds: new Set(['3tb']) }).skipped, 1);
  assert.equal(unknown.input.value, '');
  assert.equal(run([row()], { enabledHdds: new Set() }).skipped, 1);
});
test('custom HDD price and missing recorder handling', () => {
  const custom = row('8ch', '3TB');
  run([custom], { enabledHdds: new Set(['3tb']), hddPrices: { '3tb': 70 } });
  assert.equal(custom.input.value, '250.00');
  assert.equal(run([row('64ch')]).skipped, 1);
  assert.equal(run([row()], { channelPrices: { 8: -10 } }).skipped, 1);
});
test('invalid calculated price is skipped', () => {
  const r = row();
  assert.equal(run([r], { cameraPrice: Infinity }).skipped, 1);
  assert.equal(r.input.value, '');
});
test('distinct rows remain distinct in rapid one-row previews', () => {
  const ids = new Set();
  const a = row(), b = row();
  assert.equal(run([a], {}, true, ids).processed, 1);
  assert.equal(run([b], {}, true, ids).processed, 1);
  assert.equal(run([a], {}, true, ids).processed, 0);
});
test('SKU token mapping, numeric patterns and omission', () => {
  assert.equal(api.skuTokenFor({ map: { '4 cameras': 'CAM' }, pattern: '{n}x{v}' }, '4 cameras'), '4xCAM');
  assert.equal(api.skuTokenFor({ map: {}, pattern: '{v}' }, 'No HDD'), '');
  assert.equal(api.skuTokenFor({ map: { '2TB': '2TB' }, pattern: '{v}' }, '2TB'), '2TB');
});
test('manifest references exist and PNG dimensions match declarations', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.5.2');
  for (const script of manifest.content_scripts.flatMap(x => x.js)) {
    assert.ok(fs.existsSync(path.join(__dirname, script)));
  }
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = fs.readFileSync(path.join(__dirname, file));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});
