// Pure-logic tests for layout.js (fixed-slot custom layout). Uses the REAL spiral from shapes.js (gi stubbed by the loader):
//   node --import ./dev/register.mjs dev/test_layout.mjs
import assert from 'node:assert/strict';
import {buildSpiral, MAX_RINGS} from '../shapes.js';
import * as L from '../layout.js';

const SPIRALS = {honeycomb: buildSpiral('honeycomb', MAX_RINGS), grid: buildSpiral('grid', MAX_RINGS)};
const envOf = (policy = 'packed', lattice = 'honeycomb') => L.makeEnv(SPIRALS[lattice], policy, lattice);
const names = n => Array.from({length: n}, (_, i) => `a${i}.desktop`);
const rootApps = l => Object.keys(l.root).filter(k => !L.isFolderKey(k));
let passed = 0;
const test = (name, fn) => { fn(); passed++; };

/** Invariants that must hold after EVERY operation. */
function check(env, l, what = '') {
    const seen = new Set();
    for (const lv of [L.ROOT, ...l.folders.map(f => f.id)]) {
        const m = L.levelMap(l, lv);
        const used = new Set();
        for (const k of Object.keys(m)) {
            const i = L.slotIndex(env, m[k]);
            assert.ok(i > 0, `${what}: ${lv}/${k} on a real non-centre slot`);
            assert.ok(!used.has(i), `${what}: no slot collision in ${lv}`);
            used.add(i);
            if (!L.isFolderKey(k)) {
                assert.ok(!seen.has(k), `${what}: ${k} lives in one place only`);
                seen.add(k);
            }
        }
        if (env.policy === 'packed') {
            const n = used.size;
            for (let i = 1; i <= n; i++)
                assert.ok(used.has(i), `${what}: packed level ${lv} has no hole (missing ${i} of ${n})`);
        }
    }
    const ids = l.folders.map(f => f.id);
    assert.equal(new Set(ids).size, ids.length, `${what}: folder ids unique`);
    for (const f of l.folders)
        assert.ok(Object.hasOwn(l.root, L.folderKey(f.id)), `${what}: folder ${f.id} has exactly one root tile`);
    for (const k of Object.keys(l.root)) {
        if (L.isFolderKey(k))
            assert.ok(l.folders.some(f => f.id === L.folderIdOf(k)), `${what}: tile ${k} has a folder`);
    }
}

/** A layout with n apps placed by reconcile (the same path new installs take). */
function seeded(env, n) {
    const r = L.reconcile(env, L.emptyLayout(env.lattice), names(n));
    check(env, r.layout, 'seed');
    return r.layout;
}

// ------------------------------------------------------------------ basics
test('reconcile of an empty layout appends every app at the tail, flagged fresh, packed', () => {
    const env = envOf();
    const l = seeded(env, 7);
    assert.equal(rootApps(l).length, 7);
    assert.deepEqual(l.fresh, names(7));
    assert.deepEqual(L.orderedKeys(env, l, L.ROOT), names(7));
});

test('swap exchanges exactly two tiles', () => {
    const env = envOf();
    const l = seeded(env, 9);
    const r = L.swap(env, l, L.ROOT, 'a1.desktop', 'a6.desktop');
    check(env, r.layout, 'swap');
    assert.deepEqual(L.diffPositions(l, r.layout).sort(), ['root/a1.desktop', 'root/a6.desktop']);
    assert.deepEqual(r.layout.root['a1.desktop'], l.root['a6.desktop']);
    assert.equal(l.root['a1.desktop'][0] === r.layout.root['a1.desktop'][0] && l.root['a1.desktop'][1] === r.layout.root['a1.desktop'][1], false, 'input untouched');
    assert.ok(!r.layout.fresh.includes('a1.desktop') && !r.layout.fresh.includes('a6.desktop'), 'moved tiles lose the fresh dot');
});

test('ZEN REGRESSION: placing A then moving B many times never moves A', () => {
    const env = envOf();
    let l = seeded(env, 30);
    l = L.swap(env, l, L.ROOT, 'a0.desktop', 'a12.desktop').layout; // "place Zen"
    const zen = [...l.root['a0.desktop']];
    for (const [a, b] of [['a3.desktop', 'a9.desktop'], ['a9.desktop', 'a20.desktop'], ['a5.desktop', 'a29.desktop'], ['a20.desktop', 'a1.desktop']]) {
        const before = l;
        l = L.swap(env, l, L.ROOT, a, b).layout;
        assert.deepEqual(l.root['a0.desktop'], zen, 'A stayed put');
        assert.equal(L.diffPositions(before, l).length, 2);
        check(env, l, 'zen');
    }
});

test('a new app changes zero existing tiles and lands at the tail', () => {
    const env = envOf();
    const l = seeded(env, 12);
    const r = L.reconcile(env, l, [...names(12), 'new.desktop']);
    assert.deepEqual(L.diffPositions(l, r.layout), ['root/new.desktop']);
    assert.equal(L.slotIndex(env, r.layout.root['new.desktop']), 13);
    assert.ok(r.layout.fresh.includes('new.desktop'));
});

test('sort order never influences a custom layout (reconcile ignores installed order for placed apps)', () => {
    const env = envOf();
    const l = seeded(env, 10);
    const r = L.reconcile(env, l, names(10).reverse());
    assert.equal(r.changed, false);
    assert.deepEqual(r.layout, l);
});

// ------------------------------------------------------------------ folders
test('makeFolder: folder takes the target slot, target then dragged; packed closes the hole with ONE tile', () => {
    const env = envOf();
    const l = seeded(env, 10);
    const r = L.makeFolder(env, l, L.ROOT, 'a2.desktop', 'a7.desktop', 'Work', 'kwork1');
    check(env, r.layout, 'makeFolder');
    assert.deepEqual(r.layout.root['f:kwork1'], l.root['a7.desktop']);
    const f = L.findFolder(r.layout, 'kwork1');
    assert.deepEqual(Object.keys(f.slots), ['a7.desktop', 'a2.desktop']);
    assert.equal(L.slotIndex(env, f.slots['a7.desktop']), 1);
    assert.equal(L.slotIndex(env, f.slots['a2.desktop']), 2);
    // changed: the folder tile (new), a7 + a2 (left the root), a9 (last tile jumped into the hole) = at most 3 pre-existing + folder
    const changed = L.diffPositions(l, r.layout).filter(k => k.startsWith('root/'));
    assert.deepEqual(changed.sort(), ['root/a2.desktop', 'root/a7.desktop', 'root/a9.desktop', 'root/f:kwork1'].sort());
    assert.deepEqual(r.layout.root['a9.desktop'], l.root['a2.desktop'], 'a9 filled a2\'s old slot');
});

test('makeFolder when the dragged app was the last tile: nothing jumps', () => {
    const env = envOf();
    const l = seeded(env, 6);
    const r = L.makeFolder(env, l, L.ROOT, 'a5.desktop', 'a1.desktop', 'X', 'k1');
    check(env, r.layout, 'last');
    assert.deepEqual(L.diffPositions(l, r.layout).filter(k => k.startsWith('root/')).sort(), ['root/a1.desktop', 'root/a5.desktop', 'root/f:k1']);
});

test('makeFolder refuses nesting / folder keys / same tile', () => {
    const env = envOf();
    let l = seeded(env, 5);
    l = L.newFolder(env, l, 'a1.desktop', 'F', 'k1').layout;
    assert.equal(L.makeFolder(env, l, L.ROOT, 'f:k1', 'a2.desktop', 'n', 'k2').error, 'missing');
    assert.equal(L.makeFolder(env, l, 'k1', 'a1.desktop', 'a1.desktop', 'n', 'k2').error, 'invalid');
    assert.equal(L.makeFolder(env, l, L.ROOT, 'a2.desktop', 'a2.desktop', 'n', 'k2').error, 'invalid');
});

test('newFolder from one app: no tile moves except that one', () => {
    const env = envOf();
    const l = seeded(env, 8);
    const r = L.newFolder(env, l, 'a3.desktop', '  My   apps  ', 'kz');
    check(env, r.layout, 'newFolder');
    assert.equal(L.findFolder(r.layout, 'kz').name, 'My apps');
    assert.deepEqual(r.layout.root['f:kz'], l.root['a3.desktop']);
    assert.deepEqual(L.diffPositions(l, r.layout).filter(k => k.startsWith('root/')).sort(), ['root/a3.desktop', 'root/f:kz']);
});

test('addToFolder from the root and from another folder; refuses the same folder', () => {
    const env = envOf();
    let l = seeded(env, 10);
    l = L.newFolder(env, l, 'a0.desktop', 'A', 'ka').layout;
    l = L.newFolder(env, l, 'a1.desktop', 'B', 'kb').layout;
    let r = L.addToFolder(env, l, 'a5.desktop', 'ka');
    check(env, r.layout, 'add1');
    assert.equal(L.levelOfApp(r.layout, 'a5.desktop'), 'ka');
    assert.equal(L.slotIndex(env, L.findFolder(r.layout, 'ka').slots['a5.desktop']), 2);
    const r2 = L.addToFolder(env, r.layout, 'a5.desktop', 'kb');
    check(env, r2.layout, 'add2');
    assert.equal(L.levelOfApp(r2.layout, 'a5.desktop'), 'kb');
    assert.equal(L.addToFolder(env, r2.layout, 'a5.desktop', 'kb').error, 'same');
    assert.equal(L.addToFolder(env, r2.layout, 'nope', 'kb').error, 'missing');
});

test('removeFromFolder: app goes to the root tail; folder hole closed per policy', () => {
    const env = envOf();
    let l = seeded(env, 6);
    l = L.makeFolder(env, l, L.ROOT, 'a1.desktop', 'a0.desktop', 'F', 'k1').layout;
    l = L.addToFolder(env, l, 'a2.desktop', 'k1').layout; // folder: a0, a1, a2
    const r = L.removeFromFolder(env, l, 'k1', 'a0.desktop');
    check(env, r.layout, 'remove');
    assert.equal(L.levelOfApp(r.layout, 'a0.desktop'), L.ROOT);
    const tail = Math.max(...Object.keys(l.root).map(k => L.slotIndex(env, l.root[k])));
    assert.equal(L.slotIndex(env, r.layout.root['a0.desktop']), tail + 1);
    assert.equal(Object.keys(L.findFolder(r.layout, 'k1').slots).length, 2);
});

test('custom folders are never auto-dissolved (empty and single-app folders stay)', () => {
    const env = envOf();
    let l = seeded(env, 4);
    l = L.newFolder(env, l, 'a0.desktop', 'F', 'k1').layout;
    l = L.removeFromFolder(env, l, 'k1', 'a0.desktop').layout;
    check(env, l, 'empty');
    assert.equal(L.findFolder(l, 'k1').name, 'F');
    assert.deepEqual(Object.keys(L.findFolder(l, 'k1').slots), []);
    const r = L.reconcile(env, l, names(4));
    assert.ok(L.findFolder(r.layout, 'k1'), 'reconcile keeps an empty folder');
});

test('deleteFolder: first app takes the folder slot, the rest go to the root tail', () => {
    const env = envOf();
    let l = seeded(env, 8);
    l = L.makeFolder(env, l, L.ROOT, 'a2.desktop', 'a1.desktop', 'F', 'k1').layout; // folder: a1, a2
    l = L.addToFolder(env, l, 'a3.desktop', 'k1').layout;
    const fslot = l.root['f:k1'];
    const r = L.deleteFolder(env, l, 'k1');
    check(env, r.layout, 'delete');
    assert.deepEqual(r.layout.root['a1.desktop'], fslot);
    assert.equal(L.levelOfApp(r.layout, 'a2.desktop'), L.ROOT);
    assert.equal(L.levelOfApp(r.layout, 'a3.desktop'), L.ROOT);
    assert.equal(r.layout.folders.length, 0);
    const e = L.deleteFolder(env, L.newEmptyFolder(env, seeded(env, 5), 'E', 'ke').layout, 'ke');
    check(env, e.layout, 'delete empty');
});

test('renameFolder trims and falls back to "Folder"', () => {
    const env = envOf();
    const l = L.newEmptyFolder(env, seeded(env, 3), 'x', 'k1').layout;
    assert.equal(L.findFolder(L.renameFolder(env, l, 'k1', '   ').layout, 'k1').name, 'Folder');
    assert.equal(L.findFolder(L.renameFolder(env, l, 'k1', 'a'.repeat(99)).layout, 'k1').name.length, L.MAX_NAME);
    assert.equal(L.renameFolder(env, l, 'nope', 'x').error, 'missing');
});

// ------------------------------------------------------------------ free policy
test('free: moveToSlot needs an empty slot; packed refuses it; swap still works', () => {
    const packed = envOf('packed');
    const free = envOf('free');
    const l = seeded(free, 5);
    assert.equal(L.moveToSlot(packed, l, L.ROOT, 'a0.desktop', L.slotAt(packed, 20)).error, 'policy');
    const r = L.moveToSlot(free, l, L.ROOT, 'a0.desktop', L.slotAt(free, 20));
    check(free, r.layout, 'move');
    assert.deepEqual(L.diffPositions(l, r.layout), ['root/a0.desktop']);
    assert.equal(L.moveToSlot(free, r.layout, L.ROOT, 'a1.desktop', L.slotAt(free, 20)).error, 'occupied');
    assert.equal(L.moveToSlot(free, r.layout, L.ROOT, 'a1.desktop', [0, 0]).error, 'invalid-slot');
    assert.equal(L.moveToSlot(free, r.layout, L.ROOT, 'a1.desktop', [999, 999]).error, 'invalid-slot');
});

test('free: holes stay, new apps never fill them; makeFolder leaves the hole', () => {
    const env = envOf('free');
    let l = seeded(env, 6);
    l = L.moveToSlot(env, l, L.ROOT, 'a0.desktop', L.slotAt(env, 30)).layout; // hole at 1
    const r = L.reconcile(env, l, [...names(6), 'n.desktop']);
    assert.equal(L.slotIndex(env, r.layout.root['n.desktop']), 31, 'tail, not the hole');
    const m = L.makeFolder(env, r.layout, L.ROOT, 'a2.desktop', 'a3.desktop', 'F', 'k1');
    check(env, m.layout, 'free folder');
    assert.deepEqual(L.diffPositions(r.layout, m.layout).filter(k => k.startsWith('root/')).sort(), ['root/a2.desktop', 'root/a3.desktop', 'root/f:k1']);
});

test('tidy compacts stably; setPolicy(packed) tidies, setPolicy(free) changes nothing', () => {
    const free = envOf('free');
    let l = seeded(free, 6);
    l = L.moveToSlot(free, l, L.ROOT, 'a0.desktop', L.slotAt(free, 25)).layout;
    l = L.moveToSlot(free, l, L.ROOT, 'a1.desktop', L.slotAt(free, 12)).layout;
    const t = L.tidy(free, l).layout;
    assert.deepEqual(L.orderedKeys(free, t, L.ROOT), L.orderedKeys(free, l, L.ROOT), 'order preserved');
    check(envOf('packed'), t, 'tidy');
    assert.deepEqual(L.setPolicy(free, l, 'free').layout, l);
    assert.deepEqual(L.setPolicy(free, l, 'packed').layout, t);
});

// ------------------------------------------------------------------ reconcile
test('uninstall parks (hole closed by one tile), reinstall restores the slot when free', () => {
    const env = envOf();
    const l = seeded(env, 8);
    const gone = names(8).filter(n => n !== 'a2.desktop');
    const r = L.reconcile(env, l, gone);
    check(env, r.layout, 'park');
    assert.ok(r.layout.parked['a2.desktop']);
    assert.deepEqual(L.diffPositions(l, r.layout).sort(), ['root/a2.desktop', 'root/a7.desktop']);
    // reinstall: parked slot (position 3) is now occupied by a7 -> appended as new instead
    const back = L.reconcile(env, r.layout, names(8));
    check(env, back.layout, 'reinstall');
    assert.equal(L.levelOfApp(back.layout, 'a2.desktop'), L.ROOT);
    assert.equal(Object.keys(back.layout.parked).length, 0);
    // free policy: slot stays free, so the reinstall comes home
    const fe = envOf('free');
    const fl = seeded(fe, 8);
    const fr = L.reconcile(fe, fl, gone);
    const fb = L.reconcile(fe, fr.layout, names(8));
    assert.deepEqual(fb.layout.root['a2.desktop'], fl.root['a2.desktop']);
});

test('an app that was in a folder returns to that folder when its slot is free', () => {
    const env = envOf('free');
    let l = seeded(env, 6);
    l = L.makeFolder(env, l, L.ROOT, 'a1.desktop', 'a0.desktop', 'F', 'k1').layout;
    const gone = L.reconcile(env, l, names(6).filter(n => n !== 'a1.desktop'));
    assert.equal(L.levelOfApp(gone.layout, 'a1.desktop'), null);
    const back = L.reconcile(env, gone.layout, names(6));
    assert.equal(L.levelOfApp(back.layout, 'a1.desktop'), 'k1');
});

test('a folder whose apps are all uninstalled is kept (empty)', () => {
    const env = envOf();
    let l = seeded(env, 4);
    l = L.newFolder(env, l, 'a0.desktop', 'F', 'k1').layout;
    const r = L.reconcile(env, l, names(4).slice(1));
    check(env, r.layout, 'empty folder');
    assert.ok(L.findFolder(r.layout, 'k1'));
});

test('clearFresh drops one flag and returns the same object when there is nothing to clear', () => {
    const env = envOf();
    const l = seeded(env, 3);
    const c = L.clearFresh(l, 'a1.desktop');
    assert.deepEqual(c.fresh, ['a0.desktop', 'a2.desktop']);
    assert.equal(L.clearFresh(c, 'a1.desktop'), c);
    assert.equal(l.fresh.length, 3, 'input untouched');
});

test('lattice shape switch: Packed re-compacts stably, Free relocates only invalid slots', () => {
    const hex = envOf('packed', 'honeycomb');
    const grid = envOf('packed', 'grid');
    const l = seeded(hex, 20);
    const g = L.reconcile(grid, l, names(20));
    check(grid, g.layout, 'shape packed');
    assert.equal(g.layout.lattice, 'grid');
    assert.equal(rootApps(g.layout).length, 20);
    const fh = envOf('free', 'honeycomb');
    const fl = seeded(fh, 20);
    const fg = L.reconcile(envOf('free', 'grid'), fl, names(20));
    check(envOf('free', 'grid'), fg.layout, 'shape free');
});

test('a Free layout loaded under Packed is compacted stably (policy switch while the Hive was closed)', () => {
    const free = envOf('free');
    let l = seeded(free, 6);
    l = L.moveToSlot(free, l, L.ROOT, 'a0.desktop', L.slotAt(free, 25)).layout;
    const order = L.orderedKeys(free, l, L.ROOT);
    const r = L.reconcile(envOf('packed'), l, names(6));
    check(envOf('packed'), r.layout, 'policy');
    assert.deepEqual(L.orderedKeys(envOf('packed'), r.layout, L.ROOT), order, 'same reading order');
    assert.equal(r.layout.policy, 'packed');
});

test('capacity: more apps than slots -> the surplus stays unplaced, no throw', () => {
    const env = envOf();
    const r = L.reconcile(env, L.emptyLayout('honeycomb'), names(L.capacity(env) + 20));
    check(env, r.layout, 'cap');
    assert.equal(rootApps(r.layout).length, L.capacity(env));
    assert.ok(r.notes.includes('full'));
    const full = L.newEmptyFolder(env, r.layout, 'x', 'k1');
    assert.equal(full.error, 'full');
});

// ------------------------------------------------------------------ snapshot
test('snapshotCurrent reproduces the on-screen order and folders exactly', () => {
    const env = envOf();
    const folders = [{id: 'k1', name: 'Dev', ids: ['c.desktop', 'a.desktop']}, {id: 'k2', name: 'Net', ids: ['n.desktop', 'm.desktop', 'hid.desktop']}];
    const rootKeys = ['f:k1', 'f:k2', 'x.desktop', 'y.desktop', 'hidden.desktop'];
    const s = L.snapshotCurrent(env, rootKeys, folders);
    check(env, s, 'snapshot');
    assert.deepEqual(L.orderedKeys(env, s, L.ROOT), rootKeys);
    assert.deepEqual(L.orderedKeys(env, s, 'k2'), ['n.desktop', 'm.desktop', 'hid.desktop']);
    assert.equal(L.slotIndex(env, s.root['f:k1']), 1);
    const r = L.reconcile(env, s, ['c.desktop', 'a.desktop', 'n.desktop', 'm.desktop', 'hid.desktop', 'x.desktop', 'y.desktop', 'hidden.desktop']);
    assert.equal(r.changed, false, 'a fresh snapshot is already consistent');
});

test('snapshotCurrent tolerates duplicates and junk', () => {
    const env = envOf();
    const s = L.snapshotCurrent(env, ['a', 'a', 'f:nope', '__proto__', 'b'], [{id: 'k', name: '', ids: ['a', 'z']}]);
    check(env, s, 'junk');
    assert.equal(L.levelOfApp(s, 'a'), 'k', 'folder membership wins over a duplicate root entry');
    assert.equal(L.levelOfApp(s, 'z'), 'k');
    assert.equal(L.levelOfApp(s, 'b'), L.ROOT);
});

// ------------------------------------------------------------------ parse / serialise
test('parse: blank, garbage, wrong types, hostile keys, future version never throw', () => {
    const env = envOf();
    assert.equal(L.parseLayout('', 'honeycomb').blank, true);
    for (const bad of ['{', 'null', '[]', '42', '{"version":2}', '{"version":"1"}', 'x'.repeat(L.MAX_TEXT + 1)]) {
        const p = L.parseLayout(bad, 'honeycomb');
        assert.equal(p.invalid, true, bad.slice(0, 20));
        assert.deepEqual(p.layout.root, {});
    }
    const p = L.parseLayout(JSON.stringify({
        version: 1, root: {'a': [1, 0], 'b': [1, 0], '__proto__': [2, 0], 'c': [0, 0], 'd': 'x', 'e': [1.5, 0], 'f': [2, 2]},
        folders: [{id: 'k', name: 5, slots: {'a': [1, 0], 'g': [2, 0]}}, {id: 'k', name: 'dup'}, 7],
        fresh: ['f', 'zzz'], parked: {'p': {where: 'k', slot: [3, 3]}, 'q': {where: 'nope', slot: [1, 1]}},
    }), 'honeycomb');
    assert.equal(p.invalid, false);
    assert.deepEqual(Object.keys(p.layout.root).sort(), ['a', 'f']);
    assert.deepEqual(Object.keys(L.findFolder(p.layout, 'k').slots), ['g'], 'a is in the root already');
    assert.equal(L.findFolder(p.layout, 'k').name, '5');
    assert.deepEqual(p.layout.fresh, ['f']);
    assert.deepEqual(Object.keys(p.layout.parked), ['p']);
    assert.ok(p.warnings.length > 0);
    assert.equal(Object.getPrototypeOf(p.layout.root), Object.prototype);
    assert.equal(({}).polluted, undefined);
    assert.ok(env);
});

test('serialise / parse round trip', () => {
    const env = envOf();
    let l = seeded(env, 12);
    l = L.makeFolder(env, l, L.ROOT, 'a1.desktop', 'a4.desktop', 'Zürich ✓', 'k1').layout;
    l = L.reconcile(env, l, names(11)).layout;
    const back = L.parseLayout(L.serializeLayout(l), 'honeycomb');
    assert.equal(back.invalid, false);
    assert.deepEqual(back.layout, l);
    assert.deepEqual(back.warnings, []);
});

// ------------------------------------------------------------------ undo / redo
test('UndoStack: one action = one step, redo cleared by a new action, cap respected', () => {
    const u = new L.UndoStack(3);
    assert.equal(u.undo('x'), null);
    u.push('A'); u.push('B');
    assert.equal(u.undo('C'), 'B');
    assert.equal(u.undo('B'), 'A');
    assert.equal(u.redo('A'), 'B');
    u.push('B'); // new action
    assert.equal(u.canRedo, false);
    for (const x of ['1', '2', '3', '4', '5']) u.push(x);
    let n = 0, cur = 'z';
    for (let p = u.undo(cur); p; p = u.undo(cur)) { cur = p; n++; }
    assert.equal(n, 3);
});

// ------------------------------------------------------------------ property tests
test('PROPERTY: random operation sequences keep every invariant and move only the expected tiles', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = a => a[Math.floor(rnd() * a.length)];
    for (const policy of ['packed', 'free']) {
        for (const lattice of ['honeycomb', 'grid']) {
            const env = envOf(policy, lattice);
            let installed = names(40);
            let l = L.reconcile(env, L.emptyLayout(lattice), installed).layout;
            let steps = 0;
            for (let i = 0; i < 400; i++) {
                const before = l;
                const root = Object.keys(l.root);
                const apps = rootApps(l);
                const folders = l.folders.map(f => f.id);
                const inFolder = l.folders.flatMap(f => Object.keys(f.slots).map(k => [f.id, k]));
                let r = null, bound = Infinity, label = '';
                switch (Math.floor(rnd() * 10)) {
                case 0: if (root.length > 1) { const [a, b] = [pick(root), pick(root)]; r = L.swap(env, l, L.ROOT, a, b); bound = 2; label = 'swap'; } break;
                case 1: if (apps.length > 1) { r = L.makeFolder(env, l, L.ROOT, pick(apps), pick(apps), 'F', L.newFolderId(new Set(folders), rnd)); bound = 4; label = 'makeFolder'; } break;
                case 2: if (apps.length) { r = L.newFolder(env, l, pick(apps), 'N', L.newFolderId(new Set(folders), rnd)); bound = 2; label = 'newFolder'; } break;
                case 3: if (apps.length && folders.length) { r = L.addToFolder(env, l, pick(apps), pick(folders)); bound = 2; label = 'add'; } break;
                case 4: if (inFolder.length) { const [f, k] = pick(inFolder); r = L.removeFromFolder(env, l, f, k); bound = 3; label = 'remove'; } break;
                case 5: if (folders.length) { r = L.deleteFolder(env, l, pick(folders)); bound = Infinity; label = 'delete'; } break;
                case 6: if (policy === 'free' && root.length) { r = L.moveToSlot(env, l, L.ROOT, pick(root), L.slotAt(env, 1 + Math.floor(rnd() * 80))); bound = 1; label = 'move'; } break;
                case 7: { const gone = installed.length > 5 && rnd() < 0.5 ? pick(installed) : null; const next = gone ? installed.filter(x => x !== gone) : [...installed, `n${i}.desktop`]; const rc = L.reconcile(env, l, next); installed = next; r = {layout: rc.layout, error: null}; bound = Infinity; label = 'reconcile'; } break;
                case 8: if (folders.length) { r = L.renameFolder(env, l, pick(folders), `n${i}`); bound = 0; label = 'rename'; } break;
                default: if (inFolder.length > 1) { const [f] = pick(inFolder); const ks = Object.keys(L.findFolder(l, f).slots); if (ks.length > 1) { r = L.swap(env, l, f, pick(ks), pick(ks)); bound = 2; label = 'folder swap'; } } break;
                }
                if (!r) continue;
                if (r.error) { assert.equal(r.layout, before, `${label}: a refusal returns the same object`); continue; }
                l = r.layout;
                steps++;
                check(env, l, `${policy}/${lattice} #${i} ${label}`);
                assert.notEqual(l, before);
                if (label === 'swap' || label === 'move' || label === 'folder swap' || label === 'rename') {
                    assert.ok(L.diffPositions(before, l).length <= bound, `${label} moved ${L.diffPositions(before, l)}`);
                }
                if (label === 'makeFolder' && policy === 'packed') assert.ok(L.diffPositions(before, l).filter(k => k.startsWith('root/')).length <= bound);
                if (label === 'remove' || label === 'add') assert.ok(L.diffPositions(before, l).length <= bound + 2, `${label}: ${L.diffPositions(before, l)}`);
                assert.deepEqual(L.parseLayout(L.serializeLayout(l), lattice).layout, l, 'always serialisable');
            }
            assert.ok(steps > 100, `exercised ${steps} operations`);
        }
    }
});

console.log(`layout: all ${passed} tests passed`);
