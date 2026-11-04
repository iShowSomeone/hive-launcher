// Structural before/after comparison (NOT timings: the sandbox has no GNOME Shell). Counts the actors a scene needs and how much
// work a second open() repeats, for ~95 apps in the flat and the custom layout.
//   git show <old>:hive.js > hive_orig.js && node --import ./dev/register.mjs dev/bench_scene.mjs
import {fixtures, FakeSettings, makeStub} from './gi-stubs.mjs';
const apps = n => Array.from({length: n}, (_, i) => ({id: `A${String(i).padStart(3, '0')}.desktop`, name: `A${i}`, cats: 'Utility;'}));
async function measure(file, mode, policy, edit) {
    fixtures.apps = apps(95);
    const {HiveOverlay} = await import(file);
    const st = new FakeSettings({'sort-mode': 'name', 'group-mode': mode, 'hidden-apps': [], 'recent-apps': [], 'center-widget': 'logo', 'custom-layout': '', 'custom-policy': policy, 'show-empty': true});
    const ov = new HiveOverlay(st);
    ov._entry = {get_text: () => '', set_text() {}, grab_key_focus() {}, set_reactive() {}, set_style() {}, get_hint_actor: () => null, get_primary_icon: () => null, set_primary_icon() {}, clutter_text: {has_key_focus: () => false, get_text: () => '', set_selection() {}}};
    ov._hint = makeStub('h'); ov._wake = () => {}; ov._W = 1920; ov._H = 1080; ov._mon = {x: 0, y: 0}; ov._open = true;
    ov._applyOptions(); ov._rebuild(); ov._markRunning(); ov._applyLayout();
    if (edit) { ov._enterEdit(); }
    const cells = ov._cells.length, empties = ov._cells.filter(c => c.kind === 'empty').length, area = ov._cells.filter(c => c.area).length;
    // a second open: how much of the pipeline re-runs? (new code short-circuits; old code redoes it)
    let rp = 0; for (const c of ov._cells) if (c.area) { const q = c.area.queue_repaint; c.area.queue_repaint = () => { rp++; }; }
    ov._applyOptions(); const rebuilt = ov._rebuild(); if (ov._applyTheme.length > 0 || true) { try { ov._applyTheme(); } catch (_e) {} }
    return {cells, empties, drawingAreas: area, repaintsOnReopen: rp, rebuiltOnReopen: rebuilt};
}
const rows = [];
for (const [label, mode, policy, edit] of [['flat (Honey default)', 'none', 'packed', false], ['custom, Packed', 'custom', 'packed', false], ['custom, Free, editing', 'custom', 'free', true]]) {
    let before = null;
    try { before = await measure('../hive_orig.js', mode, policy, edit); } catch (e) { before = {error: String(e).slice(0, 60)}; }
    const after = await measure('../hive.js', mode, policy, edit);
    rows.push({scenario: label, before, after});
}
for (const r of rows) {
    console.log(`\n${r.scenario}`);
    console.log('  1.9.1:', JSON.stringify(r.before));
    console.log('  1.10 :', JSON.stringify(r.after));
}
