// Needs the previous hive.js copied next to it as hive_orig.js (e.g. from the last release zip):
//   cp <old>/hive.js hive_orig.js && node --import ./dev/register.mjs dev/regress.mjs
// Confirms that with folders off the layout is identical to the old version.
import assert from 'node:assert/strict';
import {fixtures, FakeSettings, makeStub} from './gi-stubs.mjs';
const mkApps = n => Array.from({length: n}, (_, i) => ({id: `A${String(i).padStart(3, '0')}.desktop`, name: `A${i}`, cats: 'Utility;'}));
async function layout(file, n, hidden, query) {
    fixtures.apps = mkApps(n);
    const {HiveOverlay} = await import(file);
    const st = new FakeSettings({'sort-mode': 'name', 'hidden-apps': hidden});
    const ov = new HiveOverlay(st);
    let text = ''; ov._entry = {get_text: () => text, set_text() {}, grab_key_focus() {}, set_reactive() {}, set_style() {}, get_hint_actor: () => null, get_primary_icon: () => null, set_primary_icon() {}, clutter_text: {has_key_focus: () => false}};
    ov._hint = makeStub('h'); ov._wake = () => {}; ov._W = 1920; ov._H = 1080; ov._mon = {x: 0, y: 0};
    ov._applyOptions(); ov._rebuild(); ov._markRunning();
    ov._query = query; ov._applyLayout();
    return ov._cells.map(c => [c.kind, c.entry?.id ?? null, +c.tx.toFixed(3), +c.ty.toFixed(3), c.tvis]);
}
for (const [n, hidden, q] of [[0, [], ''], [1, [], ''], [12, [], ''], [60, ['A003.desktop', 'A007.desktop'], ''], [60, ['A003.desktop'], 'a1'], [200, [], '']]) {
    const a = await layout('../hive_orig.js', n, hidden, q), b = await layout('../hive.js', n, hidden, q);
    assert.deepEqual(b, a, `layout differs for ${n} apps, hidden=${hidden.length}, q='${q}'`);
    console.log(`  ✓ ${n} apps, ${hidden.length} hidden, query '${q}': identical (${a.length} cells)`);
}
