// Drives the real HiveOverlay (hive.js, shapes.js, glass.js, keynav.js, grouping.js) with stubbed GNOME libraries.
//   node --import ./dev/register.mjs dev/smoke.mjs
import assert from 'node:assert/strict';
import {fixtures, FakeSettings, Clutter, makeStub} from './gi-stubs.mjs';

const {HiveOverlay} = await import('../hive.js');
const K = Clutter;
const mk = (id, cats, extra = {}) => ({id: `${id}.desktop`, name: id, cats, ...extra});
const APPS = () => [
    mk('Code', 'Development;IDE;'), mk('Meld', 'Development;'), mk('Git', 'Development;'),
    mk('Text', 'Utility;TextEditor;'), mk('Calc', 'Utility;'),
    mk('Firefox', 'Network;WebBrowser;'), mk('Mail', 'Network;Email;'),
    mk('Steam', 'Game;'), mk('Solo', 'Education;'), mk('Weird', 'X-Foo;'),
];
const ev = (sym, state = 0) => ({get_key_symbol: () => sym, get_state: () => state});
const CTRL = 4, SHIFT = 1, ALT = 8;

function makeOverlay(values = {}, apps = APPS()) {
    fixtures.apps = apps;
    fixtures.launched.length = 0; fixtures.newWindows.length = 0; fixtures.connects = {};
    const settings = new FakeSettings({
        'sort-mode': 'name', 'group-mode': 'none', 'hidden-apps': [], 'recent-apps': [], 'center-widget': 'logo',
        'custom-layout': '', 'custom-policy': 'packed', ...values,
    });
    const ov = new HiveOverlay(settings);
    let text = '';
    ov._entry = {
        get_text: () => text || 'Search apps…', // like the real field, which may report its placeholder
        grab_key_focus() {}, set_reactive() {}, set_style() {}, get_hint_actor: () => null,
        get_primary_icon: () => null, set_primary_icon() {}, clutter_text: {has_key_focus: () => false, get_text: () => text, set_selection() {}},
        set_text(t) { text = t; if (ov._suppressText || ov._prompt) return; ov._query = t.trim(); ov._applyLayout(); },
    };
    ov._hintInfo = {text: ''};
    ov._hint = makeStub('hint', {set_text: t => { ov._hintInfo.text = t; }});
    ov._wake = () => {};
    ov._W = 1920; ov._H = 1080; ov._mon = {x: 0, y: 0}; ov._open = true;
    ov.closed = 0;
    ov.close = () => { ov.closed++; };
    ov._applyOptions(); ov._rebuild(); ov._markRunning(); ov._applyLayout(); ov._updateHint();
    ov.settings = settings;
    ov.captured = fixtures.connects['captured-event'] ?? [];
    ov.rebuilds = []; const realRebuild = ov._rebuild.bind(ov);
    ov._rebuild = () => { const before = ov._sig; const r = realRebuild(); if (r) ov.rebuilds.push(`${before}\n  -> ${ov._sig}\n${new Error().stack.split('\n').slice(2, 7).join('\n')}`); return r; };
    return ov;
}
const visible = ov => ov._cells.filter(c => c.kind !== 'empty' && c.tvis >= 0.5);
const slots = cells => new Set(cells.map(c => `${c.tx.toFixed(2)},${c.ty.toFixed(2)}`)).size;
const finite = ov => ov._cells.every(c => Number.isFinite(c.tx) && Number.isFinite(c.ty));
const key = (ov, sym, state = 0) => ov._onKey(ev(sym, state));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// ============================================================================ flat lattice (default behaviour unchanged)
console.log('flat lattice');
{
    const ov = makeOverlay();
    test('no folders: static layout, every app visible', () => {
        assert.equal(ov._grouped, false);
        assert.equal(ov._folderCells.size, 0);
        assert.equal(visible(ov).length, 11, 'logo + 10 apps');
        assert.equal(ov._order.length, 11);
        assert.ok(finite(ov));
    });
    test('arrow keys: first press highlights the centre tile, then moves', () => {
        assert.equal(key(ov, K.KEY_Down), true);
        const first = ov._hovered;
        assert.equal(first.kind, 'logo');
        key(ov, K.KEY_Down);
        assert.notEqual(ov._hovered, first);
        assert.ok(ov._hovered.ty > first.ty);
        assert.equal(ov._panT.x, ov._hovered.tx, 'view pans to the highlighted tile');
        assert.equal(ov._panT.y, ov._hovered.ty);
    });
    test('Home / End / Tab / Shift+Tab', () => {
        key(ov, K.KEY_Home); assert.equal(ov._hovered.kind, 'logo');
        key(ov, K.KEY_End); assert.equal(ov._hovered, ov._order[ov._order.length - 1]);
        key(ov, K.KEY_Home);
        const seen = new Set();
        for (let i = 0; i < ov._order.length; i++) { key(ov, K.KEY_Tab); seen.add(ov._hovered); }
        assert.equal(seen.size, ov._order.length, 'Tab visits every tile');
        assert.equal(ov._hovered.kind, 'logo', 'and wraps back to the start');
        key(ov, K.KEY_ISO_Left_Tab); assert.equal(ov._hovered, ov._order[ov._order.length - 1]);
        key(ov, K.KEY_Home); key(ov, K.KEY_Tab, SHIFT); assert.equal(ov._hovered, ov._order[ov._order.length - 1], 'Shift+Tab goes back');
    });
    test('Ctrl+arrow and PageDown leap further than a single step (room to leap needed: 40 apps)', () => {
        const saved = fixtures.apps;
        const big = makeOverlay({}, Array.from({length: 40}, (_, i) => mk(`B${String(i).padStart(2, '0')}`, '')));
        for (const [sym, axis] of [[K.KEY_Right, 'tx'], [K.KEY_Down, 'ty'], [K.KEY_Left, 'tx'], [K.KEY_Up, 'ty']]) {
            key(big, K.KEY_Home); key(big, sym); const one = Math.abs(big._hovered[axis]);
            key(big, K.KEY_Home); key(big, sym, CTRL); const leap = Math.abs(big._hovered[axis]);
            assert.ok(leap > one, `${axis}: ${leap} > ${one}`);
            key(big, K.KEY_Home); key(big, sym, SHIFT); assert.equal(Math.abs(big._hovered[axis]), leap, 'Shift leaps too');
        }
        key(big, K.KEY_Home); key(big, K.KEY_Page_Down); const pg = big._hovered.ty;
        key(big, K.KEY_Home); key(big, K.KEY_Down); assert.ok(pg > big._hovered.ty, 'PageDown goes further than Down');
        fixtures.apps = saved; // fixtures are shared between overlays
    });
    test('every tile can be reached with the arrow keys alone', () => {
        const reach = new Set();
        for (const start of ov._order) {
            for (const [sym] of [[K.KEY_Up], [K.KEY_Down], [K.KEY_Left], [K.KEY_Right]]) {
                ov._hovered = start; key(ov, sym); if (ov._hovered !== start) reach.add(ov._hovered);
            }
        }
        assert.ok(reach.size >= ov._order.length - 1, `reachable ${reach.size}/${ov._order.length}`);
    });
    test('Enter: plain falls through to the entry, modifiers act directly', () => {
        key(ov, K.KEY_Home); key(ov, K.KEY_Right);
        const target = ov._hovered;
        assert.equal(key(ov, K.KEY_Return), false, 'plain Enter is left to the search field');
        ov._activateCell(ov._focused());
        assert.deepEqual(fixtures.launched, [target.entry.id]);
        assert.ok(ov.closed > 0);
        assert.equal(key(ov, K.KEY_Return, SHIFT), true);
        assert.deepEqual(fixtures.newWindows, [target.entry.id]);
        let menuFor = null, detailsFor = null;
        ov._showCellMenu = (c) => { menuFor = c; }; ov._detailsFor = c => { detailsFor = c; };
        key(ov, K.KEY_Return, CTRL); key(ov, K.KEY_KP_Enter, ALT);
        assert.equal(menuFor, target); assert.equal(detailsFor, target);
    });
    test('Menu key opens the menu of the highlighted tile (or the nearest one)', () => {
        let menuFor = null; ov._showCellMenu = c => { menuFor = c; };
        ov._hovered = null; key(ov, K.KEY_Menu);
        assert.ok(menuFor, 'a tile was highlighted and its menu requested');
    });
    test('search: text keeps Left/Right/Home for editing, arrows walk the results, Esc clears then closes', () => {
        ov._entry.set_text('e');
        assert.ok(ov._results.length > 0);
        assert.equal(key(ov, K.KEY_Left), false); assert.equal(key(ov, K.KEY_Right), false); assert.equal(key(ov, K.KEY_Home), false);
        assert.equal(ov._hovered, ov._results[0], 'best match is highlighted');
        const before = ov._hovered; key(ov, K.KEY_Down);
        assert.ok(ov._results.includes(ov._hovered));
        assert.equal(key(ov, K.KEY_Escape), true); assert.equal(ov._query, '');
        const closed = ov.closed; key(ov, K.KEY_Escape); assert.equal(ov.closed, closed + 1);
        assert.ok(before);
    });
    test('REGRESSION: Left/Right/Home/End navigate even when the entry reports placeholder text', () => {
        assert.equal(ov._entry.get_text(), 'Search apps…');
        key(ov, K.KEY_Home); const home = ov._hovered;
        assert.equal(key(ov, K.KEY_Right), true, 'Right is consumed, not left to the text field');
        const r = ov._hovered; assert.notEqual(r, home);
        assert.equal(key(ov, K.KEY_Left), true); assert.equal(ov._hovered, home, 'Left goes back');
        assert.equal(key(ov, K.KEY_End), true); assert.equal(ov._hovered, ov._order[ov._order.length - 1]);
        assert.equal(key(ov, K.KEY_Home), true); assert.equal(ov._hovered, ov._order[0]);
    });
    test('keys are caught in the capture phase, before the focused text field', () => {
        assert.ok(ov.captured.length >= 1, 'root has captured-event handlers (keys first, then the menu-dismiss one)');
        const fire = (sym, state = 0) => ov.captured[0](null, {type: () => K.EventType.KEY_PRESS, ...ev(sym, state)});
        key(ov, K.KEY_Home); const home = ov._hovered;
        assert.equal(fire(K.KEY_Right), true); assert.notEqual(ov._hovered, home);
        assert.equal(fire(K.KEY_a), false, 'ordinary typing still reaches the text field');
        assert.equal(ov.captured[0](null, {type: () => 'motion', ...ev(K.KEY_Right)}), false, 'non-key events are ignored by the key handler');
    });
    test('F3 / Shift+F3 and the centre menu switch folder modes, with a footer message', () => {
        const o = makeOverlay({'group-mode': 'none'});
        key(o, K.KEY_F3); assert.equal(o.settings.get_string('group-mode'), 'categories');
        assert.equal(o._grouped, true); assert.match(o._hintInfo.text, /^Folders: By category/);
        key(o, K.KEY_F3); assert.equal(o.settings.get_string('group-mode'), 'gnome');
        assert.match(o._hintInfo.text, /no GNOME app folders found/, 'tells you when a mode has nothing to show');
        key(o, K.KEY_F3); assert.equal(o.settings.get_string('group-mode'), 'custom');
        key(o, K.KEY_F3); assert.equal(o.settings.get_string('group-mode'), 'none'); assert.equal(o._grouped, false);
        key(o, K.KEY_F3, SHIFT); assert.equal(o.settings.get_string('group-mode'), 'custom', 'Shift+F3 goes backwards');
        key(o, K.KEY_F3, SHIFT); assert.equal(o.settings.get_string('group-mode'), 'gnome');
        key(o, K.KEY_F3, SHIFT); key(o, K.KEY_F3, SHIFT); // back to categories, then off
        o._flash('x'); const t = fixtures.timers[o._flashSource - 1]; assert.equal(typeof t, 'function');
        t(); assert.equal(o._flashText, ''); assert.match(o._hintInfo.text, /Drag or arrow keys/, 'message expires');
        let items = null; o._openMenu = (it) => { items = it; };
        o._showCellMenu(o._cells[0], 0, 0);
        const labels = items.map(i => i.label);
        assert.ok(labels.includes('Folders (F3)') && labels.includes('By category (automatic)') && labels.includes('My GNOME app folders'));
        items.find(i => i.label === 'By category (automatic)').onClick();
        assert.equal(o.settings.get_string('group-mode'), 'categories'); assert.equal(o._grouped, true);
        assert.equal(items.find(i => i.label === 'Off (one flat lattice)').icon, 'object-select-symbolic', 'the mode active when the menu opened is ticked');
        assert.equal(items.find(i => i.label === 'By category (automatic)').icon, undefined);
        o._showCellMenu(o._cells[0], 0, 0);
        assert.equal(items.find(i => i.label === 'By category (automatic)').icon, 'object-select-symbolic', 'and a reopened menu ticks the new mode');
    });
    test('F1 toggles the key help; Esc dismisses it first', () => {
        key(ov, K.KEY_F1);
        assert.equal(ov._help, true); assert.match(ov._hintInfo.text, /Arrows move/); assert.equal(ov._hint.visible, true);
        const closed = ov.closed; key(ov, K.KEY_Escape);
        assert.equal(ov._help, false); assert.equal(ov.closed, closed, 'Esc only closed the help');
        assert.match(ov._hintInfo.text, /F1 keys/);
        key(ov, K.KEY_F1); key(ov, K.KEY_F1); assert.equal(ov._help, false);
    });
    test('F2 / Shift+F2 cycle the centre widget without rebuilding the lattice', () => {
        const logo = ov._cells[0]; key(ov, K.KEY_Home); const hov = ov._hovered;
        key(ov, K.KEY_F2); assert.equal(ov.settings.get_string('center-widget'), 'clock');
        key(ov, K.KEY_F2); assert.equal(ov.settings.get_string('center-widget'), 'analog');
        key(ov, K.KEY_F2, SHIFT); key(ov, K.KEY_F2, SHIFT); assert.equal(ov.settings.get_string('center-widget'), 'logo');
        key(ov, K.KEY_F2, SHIFT); assert.equal(ov.settings.get_string('center-widget'), 'media', 'wraps backwards');
        key(ov, K.KEY_F2); assert.equal(ov.settings.get_string('center-widget'), 'logo', 'and forwards');
        assert.equal(ov.rebuilds.length, 0, `rebuilt: ${ov.rebuilds[0]}`); assert.equal(ov._cells[0], logo, 'same actors: no rebuild'); assert.equal(ov._hovered, hov, 'focus kept');
    });
    test('a resting pointer does not steal the keyboard highlight until it really moves', () => {
        key(ov, K.KEY_Home); key(ov, K.KEY_Right); const focus = ov._hovered;
        const other = ov._order[ov._order.length - 1];
        ov._press = null; ov._menuCard = null; ov._contains = () => false; ov._hit = () => other;
        const m = (x, y) => ({get_coords: () => [x, y]});
        assert.equal(ov._onMotion(m(500, 500)), true); assert.equal(ov._hovered, focus, 'baseline motion ignored');
        ov._onMotion(m(503, 502)); assert.equal(ov._hovered, focus, 'jitter ignored');
        ov._onMotion(m(560, 540)); assert.equal(ov._hovered, other, 'real movement takes the highlight back');
        assert.equal(ov._kbdLock, null);
    });
    test('the real frame loop runs over the lattice', () => {
        for (let i = 0; i < 5; i++) ov._tick();
        assert.ok(ov._cells.every(c => Number.isFinite(c.sx) && Number.isFinite(c.sy) && Number.isFinite(c.stot)));
    });
}

// ============================================================================ folders by category
console.log('folders (categories)');
{
    const ov = makeOverlay({'group-mode': 'categories'});
    const names = () => [...ov._folderCells.values()].map(f => f.entry.name);
    test('folder tiles are created for categories with 2+ apps', () => {
        assert.equal(ov._grouped, true);
        assert.deepEqual(names().sort(), ['Development', 'Internet', 'Utilities']);
        assert.equal(ov._tiles.filter(c => c.kind === 'folder').length, 3);
    });
    test('root level: logo + folders + loose apps; grouped apps are hidden', () => {
        const vis = visible(ov);
        assert.equal(vis.length, 1 + 3 + 3, 'logo, 3 folders, Steam/Solo/Weird');
        assert.equal(slots(vis), vis.length, 'no two tiles share a slot');
        assert.ok(ov._appCells.filter(c => c.group).every(c => c.tvis === 0));
        assert.ok(finite(ov));
        assert.deepEqual(ov._order.map(c => c.kind).slice(0, 4), ['logo', 'folder', 'folder', 'folder']);
    });
    test('decorative empty tiles fill the ring without overlapping', () => {
        const shown = ov._cells.filter(c => c.tvis >= 0.5);
        assert.equal(slots(shown), shown.length);
    });
    test('a folder is reachable from the keyboard and Enter steps inside', () => {
        key(ov, K.KEY_Home); key(ov, K.KEY_Tab);
        assert.equal(ov._hovered.kind, 'folder');
        const f = ov._hovered;
        ov._activateCell(ov._focused());
        assert.equal(ov._folder, f.entry.id);
        assert.match(ov._hintInfo.text, new RegExp(`^${f.entry.name}`));
        const vis = visible(ov);
        assert.equal(vis.length, 1 + f.members.length);
        assert.ok(vis.every(c => c.kind === 'logo' || c.group === f.entry.id));
        assert.equal(slots(vis), vis.length);
        assert.ok(f.members.every(m => m.vis === 0), 'members burst out of the folder tile');
        assert.ok(f.members.every(m => m.lx === f.tx && m.ly === f.ty));
    });
    test('inside a folder: navigation stays inside, search still reaches every app', () => {
        key(ov, K.KEY_Home); key(ov, K.KEY_Tab);
        assert.ok(ov._hovered.group === ov._folder);
        ov._entry.set_text('fire');
        assert.equal(ov._results.length, 1); assert.equal(ov._results[0].entry.name, 'Firefox');
        ov._entry.set_text('');
        assert.equal(ov._folder !== null, true, 'clearing the search returns to the open folder');
        assert.equal(visible(ov).length, 1 + ov._folderCells.get(ov._folder).members.length);
    });
    test('Backspace leaves the folder and highlights it again; Esc does too', () => {
        const id = ov._folder;
        assert.equal(key(ov, K.KEY_BackSpace), true);
        assert.equal(ov._folder, null); assert.equal(ov._hovered, ov._folderCells.get(id));
        assert.equal(visible(ov).length, 7);
        assert.match(ov._hintInfo.text, /Drag or arrow keys/);
        ov._openFolder(id); const closed = ov.closed;
        key(ov, K.KEY_Escape); assert.equal(ov._folder, null); assert.equal(ov.closed, closed, 'Esc leaves the folder instead of closing');
        key(ov, K.KEY_Escape); assert.equal(ov.closed, closed + 1, 'a second Esc closes');
    });
    test('the centre tile steps out of a folder; Backspace with no folder edits the text', () => {
        const f = [...ov._folderCells.values()][0]; ov._openFolder(f.entry.id);
        ov._logoClick(); assert.equal(ov._folder, null);
        assert.equal(key(ov, K.KEY_BackSpace), false);
    });
    test('running apps mark their folder as running', () => {
        fixtures.apps.find(a => a.name === 'Code').state = 2;
        ov._markRunning();
        assert.equal(ov._folderCells.get('cat:Development').running, true);
        assert.equal(ov._folderCells.get('cat:Utility').running, false);
        fixtures.apps.find(a => a.name === 'Code').state = 0;
    });
    test('the frame loop runs with folder tiles (captions, hover, fisheye)', () => {
        key(ov, K.KEY_Home); key(ov, K.KEY_Tab);
        for (let i = 0; i < 8; i++) ov._tick();
        assert.ok(ov._cells.every(c => Number.isFinite(c.stot)));
    });
    test('hidden apps do not count toward folder contents', () => {
        const o2 = makeOverlay({'group-mode': 'categories', 'hidden-apps': ['Meld.desktop', 'Git.desktop']});
        // Development is left with 1 visible app: the folder is dissolved and Code shows loose
        assert.ok(![...o2._folderCells.values()].some(f => f.entry.name === 'Development'));
        assert.ok(visible(o2).some(c => c.entry?.name === 'Code'));
        assert.ok(!visible(o2).some(c => c.entry?.name === 'Meld'));
    });
    test('right-click menu for a folder', () => {
        let opened = null; ov._openMenu = (items, x, y, title) => { opened = {items, title}; };
        const f = [...ov._folderCells.values()][0]; ov._showCellMenu(f, 0, 0);
        assert.equal(opened.title, f.entry.name); assert.equal(opened.items[0].label, 'Open folder');
    });
}

// ============================================================================ GNOME app folders
console.log('folders (GNOME app folders)');
{
    fixtures.gnomeFolders = [
        {id: 'Utilities', name: 'X-GNOME-Utilities.directory', translate: true, apps: ['Calc.desktop'], categories: [], excluded: []},
        {id: 'Dev', name: 'Dev stuff', translate: false, apps: [], categories: ['Development'], excluded: ['Meld.desktop']},
        {id: 'Gone', name: 'Gone', translate: false, apps: ['nope.desktop'], categories: [], excluded: []},
    ];
    const ov = makeOverlay({'group-mode': 'gnome'});
    test('uses the user\'s folders, translated names, drops empty ones', () => {
        const byId = Object.fromEntries([...ov._folderCells].map(([id, c]) => [id, c]));
        assert.deepEqual(Object.keys(byId).sort(), ['gnome:Dev', 'gnome:Utilities']);
        assert.equal(byId['gnome:Utilities'].entry.name, 'Utilities~tr');
        assert.deepEqual(byId['gnome:Dev'].members.map(m => m.entry.name), ['Code', 'Git']);
        assert.equal(visible(ov).length, 1 + 2 + 7, 'logo, 2 folders, 7 loose apps (Meld is excluded from Dev)');
        assert.equal(slots(visible(ov)), visible(ov).length);
    });
    test('an unreadable folder schema falls back to a flat lattice', () => {
        fixtures.gnomeFolders = [];
        const o2 = makeOverlay({'group-mode': 'gnome'});
        assert.equal(o2._grouped, false); assert.equal(visible(o2).length, 11);
    });
}

// ============================================================================ recently opened
console.log('recently opened');
{
    const ov = makeOverlay({'sort-mode': 'recent'});
    let refreshed = 0; const realRefresh = ov._refresh.bind(ov); ov._refresh = f => { refreshed++; realRefresh(f); };
    test('launching records the app, most recent first, without rebuilding the Hive', () => {
        ov._noteRecent('Mail.desktop'); ov._noteRecent('Code.desktop');
        assert.deepEqual(ov.settings.get_strv('recent-apps'), ['Code.desktop', 'Mail.desktop']);
        ov._noteRecent('Mail.desktop');
        assert.deepEqual(ov.settings.get_strv('recent-apps'), ['Mail.desktop', 'Code.desktop']);
        const w = ov.settings.writes.length; ov._noteRecent('Mail.desktop');
        assert.equal(ov.settings.writes.length, w, 'no write when nothing changed');
        assert.equal(refreshed, 0, 'changed::recent-apps is ignored');
    });
    test('apps started anywhere in the session count (app-state-changed → STARTING)', () => {
        fixtures.handlers['app-state-changed'](null, {state: 1, get_id: () => 'Steam.desktop'});
        assert.equal(ov.settings.get_strv('recent-apps')[0], 'Steam.desktop');
        fixtures.handlers['app-state-changed'](null, {state: 2, get_id: () => 'Solo.desktop'});
        assert.equal(ov.settings.get_strv('recent-apps')[0], 'Steam.desktop', 'only STARTING is recorded');
    });
    test('history is capped', () => {
        for (let i = 0; i < 100; i++) ov._noteRecent(`x${i}.desktop`);
        assert.equal(ov.settings.get_strv('recent-apps').length, 64);
        assert.equal(ov.settings.get_strv('recent-apps')[0], 'x99.desktop');
    });
    test('"Recently opened" order: recent first (newest first), the rest by name', () => {
        ov.settings.values.set('recent-apps', ['Mail.desktop', 'Code.desktop', 'gone.desktop']);
        const ids = ov._buildEntries().map(e => e.id);
        assert.deepEqual(ids.slice(0, 2), ['Mail.desktop', 'Code.desktop']);
        const rest = ids.slice(2); assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)));
    });
    test('other settings still rebuild, centre-widget does not', () => {
        refreshed = 0; ov.settings._set('shape', 'circle'); assert.equal(refreshed, 1);
        ov.settings._set('center-widget', 'clock'); assert.equal(refreshed, 2);
    });
    test('launching from the Hive records it', () => {
        const o = makeOverlay(); const cell = o._appCells[3];
        o._launch(cell); assert.equal(o.settings.get_strv('recent-apps')[0], cell.entry.id);
        o._newWindow(o._appCells[1]); assert.equal(o.settings.get_strv('recent-apps')[0], o._appCells[1].entry.id);
    });
}

// ============================================================================ scale
console.log('large libraries');
{
    const many = Array.from({length: 150}, (_, i) => mk(`App${String(i).padStart(3, '0')}`, ['Development;', 'Utility;', 'Network;', 'Game;', ''][i % 5]));
    for (const mode of ['none', 'categories']) {
        test(`150 apps, group-mode=${mode}: every app has its own slot and the frame loop runs`, () => {
            const ov = makeOverlay({'group-mode': mode}, many);
            const vis = visible(ov);
            assert.equal(slots(vis), vis.length); assert.ok(finite(ov));
            if (mode === 'categories') {
                assert.equal(ov._folderCells.size, 4);
                for (const f of ov._folderCells.values()) {
                    ov._openFolder(f.entry.id);
                    const v = visible(ov); assert.equal(v.length, 1 + 30); assert.equal(slots(v), v.length);
                    ov._leaveFolder();
                }
            } else {
                assert.equal(vis.length, 151);
            }
            for (let i = 0; i < 3; i++) ov._tick();
        });
    }
    test('an empty library does not throw', () => {
        const ov = makeOverlay({'group-mode': 'categories'}, []);
        key(ov, K.KEY_Down); key(ov, K.KEY_Tab); key(ov, K.KEY_End); ov._tick();
    });
}

// ============================================================================ custom layout (Edit Hive, M1)
console.log('custom layout');
{
    const LY = await import('../layout.js');
    const pos = ov => new Map(visible(ov).map(c => [c.kind === 'folder' ? `f:${c.entry.name}` : c.kind === 'app' ? c.entry.id : c.kind, `${c.tx.toFixed(1)},${c.ty.toFixed(1)}`]));
    const stored = ov => LY.parseLayout(ov.settings.get_string('custom-layout'), 'honeycomb').layout;
    const menuItems = (ov, cell) => { let items = null; const real = ov._openMenu; ov._openMenu = it => { items = it; }; ov._showCellMenu(cell, 10, 10); ov._openMenu = real; return items; };
    const cellOf = (ov, id) => ov._cells.find(c => c.kind === 'app' && c.entry.id === `${id}.desktop`);
    const folderNamed = (ov, name) => [...ov._folderCells.values()].find(c => c.entry.name === name);
    const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

    test('switching to custom copies the arrangement on screen exactly (flat, then categories) and saves it', () => {
        for (const mode of ['none', 'categories']) {
            const ov = makeOverlay({'group-mode': mode});
            const before = pos(ov);
            const names = [...ov._folderCells.values()].map(f => f.entry.name).sort();
            ov.settings.set_string('group-mode', 'custom');
            assert.equal(ov._custom, true);
            assert.deepEqual(pos(ov), before, `${mode}: no visible tile moved`);
            assert.deepEqual([...ov._folderCells.values()].map(f => f.entry.name).sort(), names, 'same folders');
            assert.ok(ov.settings.get_string('custom-layout').startsWith('{"version":1'), 'snapshot persisted at once');
        }
    });
    test('the snapshot is frozen: changing the Order setting afterwards moves nothing', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        const before = pos(ov);
        ov.settings.set_string('sort-mode', 'frequency');
        ov.settings.set_string('sort-mode', 'name');
        assert.deepEqual(pos(ov), before);
    });
    test('a folder\'s contents also survive the switch', () => {
        const ov = makeOverlay({'group-mode': 'categories'});
        const dev = folderNamed(ov, 'Development'); ov._openFolder(dev.entry.id); const inside = pos(ov); ov._leaveFolder();
        ov.settings.set_string('group-mode', 'custom');
        ov._openFolder(folderNamed(ov, 'Development').entry.id);
        assert.deepEqual(pos(ov), inside);
        ov._leaveFolder();
    });
    test('right-click > Move to folder: only that app leaves, the rest stay exactly where they were', () => {
        const ov = makeOverlay({'group-mode': 'categories'}); ov.settings.set_string('group-mode', 'custom');
        const before = pos(ov);
        const items = menuItems(ov, cellOf(ov, 'Solo') ?? cellOf(ov, 'Weird'));
        assert.ok(items.some(i => i.label === 'Move to folder…'));
        let sub = null; ov._openMenu = it => { sub = it; };
        items.find(i => i.label === 'Move to folder…').onClick();
        const dev = sub.find(i => i.label === 'Development'); assert.ok(dev && sub.some(i => i.label === 'New folder…'));
        const rebuilds = ov.rebuilds.length;
        dev.onClick();
        assert.equal(ov.rebuilds.length, rebuilds + 1, 'exactly one rebuild: our own settings write does not trigger another');
        assert.equal(ov._selfWrite, 0);
        const after = pos(ov);
        const gone = [...before.keys()].filter(k => !after.has(k));
        assert.equal(gone.length, 1, `one tile left the root: ${gone}`);
        for (const [k, v] of after) {
            if (!before.has(k) || k === 'f:Development') continue;
            // the single "last tile jumps into the hole" move is allowed; everything else must be untouched
        }
        const moved = [...after].filter(([k, v]) => before.get(k) !== v && before.has(k));
        assert.ok(moved.length <= 1, `at most one tile jumped into the hole: ${moved.map(m => m[0])}`);
        assert.equal(LY.findFolder(stored(ov), LY.folderIdOf(Object.keys(stored(ov).root).find(k => LY.isFolderKey(k) && stored(ov).folders.find(f => f.id === LY.folderIdOf(k)).name === 'Development'))).slots[(cellOf(ov, 'Solo') ? 'Solo' : 'Weird') + '.desktop'] !== undefined, true, 'saved');
    });
    test('Ctrl+Z / Ctrl+Shift+Z restore and redo the previous layout, positions included', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        const before = pos(ov), raw0 = ov.settings.get_string('custom-layout');
        let sub = null; ov._openMenu = it => { sub = it; };
        menuItems(ov, cellOf(ov, 'Git')); ov._newFolderFor(cellOf(ov, 'Git'));
        assert.ok(ov._prompt, 'the search field is now asking for a name');
        ov._entry.set_text('Tools'); ov._commitPrompt();
        assert.equal(ov._prompt, null);
        const edited = pos(ov);
        assert.ok(edited.has('f:Tools'));
        assert.equal(key(ov, K.KEY_z, CTRL), true);
        assert.deepEqual(pos(ov), before); assert.equal(ov.settings.get_string('custom-layout'), raw0);
        key(ov, K.KEY_Z, CTRL | SHIFT);
        assert.deepEqual(pos(ov), edited);
        key(ov, K.KEY_z, CTRL); key(ov, K.KEY_z, CTRL);
        assert.match(ov._hintInfo.text, /Nothing to undo/);
    });
    test('naming prompt: Esc cancels, typing is not a search, arrows edit text, the lattice stays frozen', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        const before = pos(ov), raw0 = ov.settings.get_string('custom-layout');
        ov._newFolderFor(cellOf(ov, 'Mail'));
        assert.match(ov._hintInfo.text, /Enter to confirm/);
        ov._entry.set_text('zzz'); assert.equal(ov._query, '', 'no search while naming');
        assert.equal(key(ov, K.KEY_Left), false, 'caret keys reach the text field');
        assert.equal(key(ov, K.KEY_z, CTRL), false, 'no undo while typing a name');
        assert.equal(key(ov, K.KEY_Escape), true);
        assert.equal(ov._prompt, null);
        assert.deepEqual(pos(ov), before); assert.equal(ov.settings.get_string('custom-layout'), raw0, 'nothing saved');
        assert.equal(ov.closed, 0, 'Esc cancelled the prompt, it did not close the Hive');
    });
    test('rename, delete (menu confirm) and remove-from-folder', () => {
        const ov = makeOverlay({'group-mode': 'categories'}); ov.settings.set_string('group-mode', 'custom');
        const dev = folderNamed(ov, 'Development');
        ov._renameFolderPrompt(dev); ov._entry.set_text('Dev stuff'); ov._commitPrompt();
        assert.ok(folderNamed(ov, 'Dev stuff'));
        ov._openFolder(folderNamed(ov, 'Dev stuff').entry.id);
        const git = cellOf(ov, 'Git'); assert.ok(git.group);
        menuItems(ov, git).find(i => i.label === 'Remove from folder').onClick();
        ov._leaveFolder();
        assert.ok(!cellOf(ov, 'Git').group, 'Git is a loose root tile now');
        assert.ok(visible(ov).includes(cellOf(ov, 'Git')));
        let confirm = null; ov._openMenu = it => { confirm = it; };
        const f = folderNamed(ov, 'Dev stuff');
        menuItems(ov, f).find(i => i.label === 'Delete folder…').onClick();
        confirm.find(i => i.label?.startsWith('Delete folder')).onClick();
        assert.equal(folderNamed(ov, 'Dev stuff'), undefined);
        for (const id of ['Code', 'Meld', 'Git']) assert.ok(visible(ov).includes(cellOf(ov, id)), `${id} still reachable`);
    });
    test('an empty folder stays and opens as just the centre tile', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        ov._askName('x', 'x', n => ov._editLayout((env, l) => LY.newEmptyFolder(env, l, n, 'kempty')));
        ov._entry.set_text('Empty'); ov._commitPrompt();
        const f = folderNamed(ov, 'Empty'); assert.ok(f); assert.equal(f.members.length, 0);
        ov._openFolder(f.entry.id);
        assert.equal(visible(ov).filter(c => c.kind !== 'logo').length, 0); assert.ok(finite(ov));
        ov._leaveFolder();
    });
    test('a new app appears at the tail, an uninstalled one is parked, nothing else moves; writes are lazy', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        const before = pos(ov);
        fixtures.apps = [...APPS(), mk('Zed', 'Development;')];
        ov._refresh(true);
        const after = pos(ov);
        for (const [k, v] of before) assert.equal(after.get(k), v, `${k} did not move`);
        assert.ok(after.has('Zed.desktop'));
        ov._flushLayout();
        assert.ok(stored(ov).fresh.includes('Zed.desktop'), 'flagged fresh and saved on flush');
        fixtures.apps = APPS().filter(a => a.name !== 'Mail');
        ov._refresh(true);
        assert.ok(!pos(ov).has('Mail.desktop'));
        ov._flushLayout();
        assert.ok(stored(ov).parked['Mail.desktop'], 'parked, remembered');
    });
    test('hiding parks the app (Packed: one tile fills the hole, no gap); unhiding brings it back; search still finds it', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        const before = pos(ov);
        ov.settings.set_strv('hidden-apps', ['Calc.desktop']);
        assert.ok(ov._hidden.has('Calc.desktop'), 'the setting was picked up');
        assert.ok(!pos(ov).has('Calc.desktop'), 'hidden: not shown');
        assert.equal(LY.levelOfApp(ov._layout, 'Calc.desktop'), null, 'parked: it owns no slot');
        const moved = [...pos(ov)].filter(([k, v]) => before.get(k) !== v);
        assert.ok(moved.length <= 1, `at most one tile jumped into the hole: ${moved.map(m => m[0])}`);
        const slotsNow = [...pos(ov).values()];
        assert.equal(new Set(slotsNow).size, slotsNow.length);
        ov._entry.set_text('calc');
        assert.ok(ov._results.some(c => c.entry.id === 'Calc.desktop'), 'a hidden app is still found by search');
        ov._entry.set_text('');
        ov.settings.set_strv('hidden-apps', []);
        assert.ok(pos(ov).has('Calc.desktop'), 'unhidden: back on the lattice');
        assert.equal(visible(ov).filter(c => c.kind === 'app').length, 10);
    });
    test('an outside edit of custom-layout (Preferences reset) re-snapshots; unreadable text is never overwritten by a rebuild', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        ov.settings.set_string('custom-layout', '');
        assert.ok(ov.settings.get_string('custom-layout').startsWith('{"version":1'));
        quiet(() => {
            ov.settings.set_string('custom-layout', '{oops');
            assert.equal(ov.settings.get_string('custom-layout'), '{oops', 'a rebuild leaves unreadable text alone');
            assert.equal(visible(ov).filter(c => c.kind === 'app').length, 10, 'every app is still shown');
            ov._flushLayout(); ov.close = () => {};
            assert.equal(ov.settings.get_string('custom-layout'), '{oops', 'even on close');
            menuItems(ov, cellOf(ov, 'Git'));
            ov._editLayout((env, l) => LY.newEmptyFolder(env, l, 'Fixed', 'kfix'));
            assert.ok(ov.settings.get_string('custom-layout').startsWith('{"version":1'), 'the first user edit replaces it');
        });
    });
    test('Return to the previous mode, and the centre menu offers undo only when there is something to undo', () => {
        const ov = makeOverlay({'group-mode': 'categories'}); ov.settings.set_string('group-mode', 'custom');
        let items = menuItems(ov, ov._cells[0]);
        assert.ok(!items.some(i => i.label?.startsWith('Undo')));
        assert.ok(items.some(i => i.label === 'Return to “By category (automatic)”'));
        ov._editLayout((env, l) => LY.newEmptyFolder(env, l, 'N', 'kn'));
        items = menuItems(ov, ov._cells[0]);
        assert.ok(items.some(i => i.label?.startsWith('Undo')));
        items.find(i => i.label?.startsWith('Return to')).onClick();
        assert.equal(ov.settings.get_string('group-mode'), 'categories');
        assert.equal(ov._custom, false);
        assert.ok(ov.settings.get_string('custom-layout').length > 0, 'the custom layout is kept for next time');
    });
    test('Free policy: holes stay empty tiles (decor) and the frame loop is healthy', () => {
        const ov = makeOverlay({'group-mode': 'custom', 'custom-policy': 'free'});
        ov._editLayout((env, l) => LY.moveToSlot(env, l, LY.ROOT, 'Git.desktop', LY.slotAt(env, 40)));
        assert.ok(finite(ov)); for (let i = 0; i < 3; i++) ov._tick();
        const v = visible(ov); assert.equal(slots(visible(ov)), v.length);
    });
    test('custom mode with an empty library and 150 apps', () => {
        quiet(() => {
            const none = makeOverlay({'group-mode': 'custom'}, []); key(none, K.KEY_Down); none._tick();
            const many = Array.from({length: 150}, (_, i) => mk(`App${String(i).padStart(3, '0')}`, ''));
            const big = makeOverlay({'group-mode': 'custom'}, many);
            assert.equal(visible(big).length, 151); assert.equal(slots(visible(big)), 151); assert.ok(finite(big)); big._tick();
        });
    });
}

// ============================================================================ Edit Hive: edit mode, drag & drop, keyboard carry (M2-M5)
console.log('edit hive');
{
    const LY = await import('../layout.js');
    const pos = ov => new Map(visible(ov).map(c => [c.kind === 'folder' ? `f:${c.entry.name}` : c.kind === 'app' ? c.entry.id : c.kind, `${c.tx.toFixed(1)},${c.ty.toFixed(1)}`]));
    const cellOf = (ov, id) => ov._cells.find(c => c.kind === 'app' && c.entry.id === `${id}.desktop`);
    const folderNamed = (ov, name) => [...ov._folderCells.values()].find(c => c.entry.name === name);
    const settle = ov => { for (const c of ov._cells) { c.lx = c.tx; c.ly = c.ty; c.vis = c.tvis; } ov._pan.x = ov._panT.x; ov._pan.y = ov._panT.y; ov._appear = 1; ov._appearT = 1; for (let i = 0; i < 3; i++) ov._tick(); };
    const editing = (values = {}, apps) => { const ov = makeOverlay({'group-mode': 'custom', ...values}, apps); ov._enterEdit(); settle(ov); return ov; };
    const mev = (ov, x, y, state = 0, button = 1) => ({get_button: () => button, get_coords: () => [x + ov._mon.x, y + ov._mon.y], get_state: () => state});
    // a complete pointer gesture: press on `from`, move in steps to (tx, ty), optionally wait out the dwell, release
    const gesture = (ov, from, [tx, ty], {shift = false, dwell = false, steps = 5} = {}) => {
        const [fx, fy] = [from.sx, from.sy];
        ov._onPress(mev(ov, fx, fy));
        for (let i = 1; i <= steps; i++) ov._onMotion(mev(ov, fx + (tx - fx) * i / steps, fy + (ty - fy) * i / steps, shift ? SHIFT : 0));
        if (dwell) ov._dwell.since -= 1000;
        ov._onRelease(mev(ov, tx, ty, shift ? SHIFT : 0));
        settle(ov);
    };
    const at = c => [c.sx, c.sy];
    const unchangedExcept = (before, after, ids) => { for (const [k, v] of before) if (!ids.includes(k)) assert.equal(after.get(k), v, `${k} must not move`); };

    test('F4 enters edit mode from a plain flat Hive (snapshot + switch to custom) and F4 / Done leave it', () => {
        const ov = makeOverlay();
        const before = pos(ov);
        assert.equal(key(ov, K.KEY_F4), true);
        assert.equal(ov.settings.get_string('group-mode'), 'custom');
        assert.equal(ov._edit.active, true);
        assert.equal(ov._donePill.visible, true, 'the Done pill is shown');
        assert.match(ov._hintInfo.text, /Editing layout/);
        assert.deepEqual(pos(ov), before, 'entering edit mode moved nothing');
        key(ov, K.KEY_F4);
        assert.equal(ov._edit.active, false); assert.equal(ov._donePill.visible, false);
        ov._enterEdit(); ov._donePill.emit?.('clicked'); ov._leaveEdit();
        assert.equal(ov._edit.active, false);
    });
    test('Esc order: cancel prompt, cancel carried tile, leave edit mode, leave folder, close', () => {
        const ov = editing();
        ov._focusCell(cellOf(ov, 'Git')); key(ov, K.KEY_space);
        assert.equal(ov._edit.grabbed, cellOf(ov, 'Git'));
        ov._askName('t', 'x', () => {});
        key(ov, K.KEY_Escape); assert.equal(ov._prompt, null); assert.ok(ov._edit.grabbed, 'first Esc only cancelled the prompt');
        key(ov, K.KEY_Escape); assert.equal(ov._edit.grabbed, null); assert.equal(ov._edit.active, true);
        key(ov, K.KEY_Escape); assert.equal(ov._edit.active, false); assert.equal(ov.closed, 0);
        key(ov, K.KEY_Escape); assert.equal(ov.closed, 1, 'finally the Hive closes');
    });
    test('editing never launches: Enter on an app only explains, a click does nothing, a folder click opens it', () => {
        const ov = editing({'group-mode': 'categories'}); ov._enterEdit(); settle(ov);
        ov._focusCell(cellOf(ov, 'Solo') ?? cellOf(ov, 'Weird'));
        key(ov, K.KEY_Return); ov._activateCell(ov._focused());
        gesture(ov, ov._focused(), at(ov._focused()));
        assert.deepEqual(fixtures.launched, []);
        assert.match(ov._hintInfo.text, /Editing/);
        const f = [...ov._folderCells.values()][0];
        gesture(ov, f, at(f));
        assert.equal(ov._folder, f.entry.id, 'a click on a folder steps inside');
        assert.equal(ov._cells[0].backGlyph.visible, true, 'the centre tile shows a back arrow inside a folder');
        ov._leaveFolder(); assert.equal(ov._cells[0].backGlyph.visible, false);
    });
    test('keyboard: Space picks up, arrows choose, Enter swaps exactly two tiles; Ctrl+Z undoes', () => {
        const ov = editing();
        const before = pos(ov), raw0 = ov.settings.get_string('custom-layout');
        ov._focusCell(cellOf(ov, 'Git'));
        key(ov, K.KEY_space);
        assert.match(ov._hintInfo.text, /Carrying Git/);
        ov._focusCell(cellOf(ov, 'Steam'));
        key(ov, K.KEY_Return);
        const after = pos(ov);
        assert.equal(after.get('Git.desktop'), before.get('Steam.desktop')); assert.equal(after.get('Steam.desktop'), before.get('Git.desktop'));
        unchangedExcept(before, after, ['Git.desktop', 'Steam.desktop']);
        assert.equal(ov._edit.grabbed, null);
        key(ov, K.KEY_z, CTRL);
        assert.deepEqual(pos(ov), before); assert.equal(ov.settings.get_string('custom-layout'), raw0);
    });
    test('keyboard: Shift+Enter makes a folder and asks for its name; the name joins the same undo step', () => {
        const ov = editing();
        const before = pos(ov);
        ov._focusCell(cellOf(ov, 'Git')); key(ov, K.KEY_space); ov._focusCell(cellOf(ov, 'Mail')); key(ov, K.KEY_Return, SHIFT);
        assert.ok(ov._prompt, 'the name prompt is open');
        ov._entry.set_text('Comms'); ov._commitPrompt();
        const f = folderNamed(ov, 'Comms'); assert.ok(f);
        assert.deepEqual(f.members.map(m => m.entry.name).sort(), ['Git', 'Mail']);
        key(ov, K.KEY_z, CTRL);
        assert.equal(folderNamed(ov, 'Comms'), undefined, 'one Ctrl+Z removes the folder, name and all');
        assert.deepEqual(pos(ov), before);
    });
    test('keyboard: carrying onto a folder adds to it; Backspace while carrying inside a folder takes it out', () => {
        const ov = editing({'group-mode': 'categories'}); ov._enterEdit(); settle(ov);
        const dev = folderNamed(ov, 'Development'); const before = dev.members.length;
        ov._focusCell(cellOf(ov, 'Steam')); key(ov, K.KEY_space); ov._focusCell(dev); key(ov, K.KEY_Return);
        assert.equal(folderNamed(ov, 'Development').members.length, before + 1);
        ov._openFolder(folderNamed(ov, 'Development').entry.id); settle(ov);
        ov._focusCell(cellOf(ov, 'Steam')); key(ov, K.KEY_space); key(ov, K.KEY_BackSpace);
        assert.ok(!cellOf(ov, 'Steam').group, 'Steam is back on the root'); assert.equal(folderNamed(ov, 'Development').members.length, before);
    });
    test('keyboard: Ctrl+R renames and Delete asks before deleting the highlighted custom folder', () => {
        const ov = editing({'group-mode': 'categories'}); ov._enterEdit(); settle(ov);
        const dev = folderNamed(ov, 'Development'); ov._focusCell(dev);
        key(ov, K.KEY_r, CTRL); assert.ok(ov._prompt); ov._entry.set_text('Code'); ov._commitPrompt();
        assert.ok(folderNamed(ov, 'Code'));
        let menu = null; ov._openMenu = it => { menu = it; };
        ov._focusCell(folderNamed(ov, 'Code')); key(ov, K.KEY_Delete);
        assert.ok(folderNamed(ov, 'Code'), 'nothing is deleted yet'); assert.ok(menu.some(i => /Delete folder/.test(i.label)));
        menu.find(i => /Delete folder/.test(i.label)).onClick(); assert.equal(folderNamed(ov, 'Code'), undefined);
    });
    test('Space is a search letter unless editing with an empty field', () => {
        const ov = makeOverlay({'group-mode': 'custom'});
        assert.equal(key(ov, K.KEY_space), false, 'not editing: the key reaches the search field');
        ov._enterEdit(); ov._query = 'ab'; assert.equal(key(ov, K.KEY_space), false, 'editing with text: still a letter');
    });
    test('drag: dropping on another app swaps; everything else stays exactly where it was', () => {
        const ov = editing();
        const before = pos(ov), raw0 = ov.settings.get_string('custom-layout');
        gesture(ov, cellOf(ov, 'Code'), at(cellOf(ov, 'Weird')));
        const after = pos(ov);
        assert.equal(after.get('Code.desktop'), before.get('Weird.desktop')); assert.equal(after.get('Weird.desktop'), before.get('Code.desktop'));
        unchangedExcept(before, after, ['Code.desktop', 'Weird.desktop']);
        assert.notEqual(ov.settings.get_string('custom-layout'), raw0, 'saved');
        assert.equal(ov._edit.drag, null); assert.equal(ov._editLayer.visible, false);
    });
    test('ZEN REGRESSION (UI level): place A, then drag B around many times - A never moves, the view never re-centres', () => {
        const ov = editing();
        gesture(ov, cellOf(ov, 'Steam'), at(cellOf(ov, 'Calc')));   // "place Zen"
        const zen = pos(ov).get('Steam.desktop'); const panAt = {...ov._panT};
        for (const [a, b] of [['Mail', 'Text'], ['Text', 'Solo'], ['Weird', 'Meld'], ['Solo', 'Git']]) {
            gesture(ov, cellOf(ov, a), at(cellOf(ov, b)));
            assert.equal(pos(ov).get('Steam.desktop'), zen, `Steam stayed after moving ${a}`);
        }
        assert.deepEqual(ov._panT, panAt, 'no pan reset after a drop');
    });
    test('drag: hover (dwell) or Shift on an app makes a folder and opens the name prompt; dropping on a folder adds', () => {
        const ov = editing();
        gesture(ov, cellOf(ov, 'Code'), at(cellOf(ov, 'Meld')), {dwell: true});
        assert.ok(ov._prompt, 'prompt opens straight after the drop'); ov._entry.set_text('Dev'); ov._commitPrompt();
        assert.deepEqual(folderNamed(ov, 'Dev').members.map(m => m.entry.name).sort(), ['Code', 'Meld']);
        settle(ov);
        gesture(ov, cellOf(ov, 'Git'), at(folderNamed(ov, 'Dev')));
        assert.equal(folderNamed(ov, 'Dev').members.length, 3, 'dropping on a folder adds without any dwell');
        gesture(ov, cellOf(ov, 'Mail'), at(cellOf(ov, 'Text')), {shift: true});
        assert.ok(ov._prompt, 'Shift+drop also makes a folder'); ov._cancelPrompt();
        assert.equal(ov.settings.get_string('custom-layout').includes('"New folder"'), true, 'cancelling the prompt keeps the default name');
    });
    test('drag: a short hover only swaps (no accidental folder); a folder dropped on an app swaps (no nesting)', () => {
        const ov = editing({'group-mode': 'categories'}); ov._enterEdit(); settle(ov);
        const f = [...ov._folderCells.values()][0]; const fb = pos(ov).get(`f:${f.entry.name}`);
        const solo = cellOf(ov, 'Solo') ?? cellOf(ov, 'Weird'); const sb = pos(ov).get(solo.entry.id);
        gesture(ov, f, at(solo), {dwell: true, shift: true});
        assert.equal(ov._prompt, null, 'no folder inside a folder');
        assert.equal(pos(ov).get(`f:${f.entry.name}`), sb); assert.equal(pos(ov).get(solo.entry.id), fb);
    });
    test('drag: dropping on nothing cancels; Esc during a lift cancels and the rest of the gesture is ignored', () => {
        const ov = editing();
        const before = pos(ov), raw0 = ov.settings.get_string('custom-layout');
        gesture(ov, cellOf(ov, 'Code'), [ov._W - 3, ov._H - 3]);
        assert.deepEqual(pos(ov), before); assert.equal(ov.settings.get_string('custom-layout'), raw0);
        const c = cellOf(ov, 'Mail'); ov._onPress(mev(ov, c.sx, c.sy));
        ov._onMotion(mev(ov, c.sx + 30, c.sy)); assert.ok(ov._edit.drag, 'lifted');
        key(ov, K.KEY_Escape); assert.equal(ov._edit.drag, null); assert.equal(ov._edit.active, true, 'Esc cancelled only the lift');
        ov._onMotion(mev(ov, c.sx + 60, c.sy)); ov._onRelease(mev(ov, cellOf(ov, 'Text').sx, cellOf(ov, 'Text').sy));
        assert.deepEqual(pos(ov), before);
    });
    test('drag: a press without moving is a click, empty space still pans, a search blocks lifting', () => {
        const ov = editing();
        const c = cellOf(ov, 'Git'); const before = pos(ov);
        ov._onPress(mev(ov, c.sx, c.sy)); ov._onRelease(mev(ov, c.sx, c.sy));
        assert.equal(ov._edit.drag, null); assert.deepEqual(pos(ov), before);
        const pan0 = {...ov._panT}; ov._onPress(mev(ov, ov._W - 5, 5)); ov._onMotion(mev(ov, ov._W - 45, 25));
        assert.notDeepEqual(ov._panT, pan0, 'dragging empty space pans the lattice'); ov._onRelease(mev(ov, ov._W - 45, 25));
        ov._query = 'g'; ov._onPress(mev(ov, c.sx, c.sy)); ov._onMotion(mev(ov, c.sx + 40, c.sy)); assert.equal(ov._edit.drag, null);
        ov._onRelease(mev(ov, c.sx, c.sy));
    });
    test('drag: touch long-press lifts a tile without moving', () => {
        const ov = editing();
        const c = cellOf(ov, 'Git'); ov._onPress(mev(ov, c.sx, c.sy));
        const timer = ov._press.longTimer; assert.ok(timer, 'a long-press timer is armed');
        ov._startTileDrag(c, c.sx, c.sy); assert.ok(ov._edit.drag);
        ov._onRelease(mev(ov, c.sx, c.sy)); settle(ov); assert.equal(ov._edit.drag, null);
    });
    test('drag near the screen edge auto-pans the Hive, and the lifted tile follows the pointer', () => {
        const ov = editing(); const c = cellOf(ov, 'Git');
        ov._onPress(mev(ov, c.sx, c.sy)); ov._onMotion(mev(ov, c.sx + 30, c.sy));
        ov._onMotion(mev(ov, ov._W - 10, ov._H / 2));
        assert.ok(ov._edit.drag.pan.x > 0, 'pan velocity towards the right edge');
        const px = ov._panT.x; ov._last = 0; ov._tick(); ov._tick();
        assert.ok(ov._panT.x >= px, 'panning'); assert.equal(c.sx, ov._W - 10, 'the tile is under the pointer');
        key(ov, K.KEY_Escape); ov._onRelease(mev(ov, 0, 0));
    });
    test('inside a folder: dropping on the centre tile or beyond the ring takes the app out; apps still swap', () => {
        const ov = editing({'group-mode': 'categories'}); ov._enterEdit(); settle(ov);
        ov._openFolder(folderNamed(ov, 'Development').entry.id); settle(ov);
        const members = ov._cells.filter(c => c.kind === 'app' && c.tvis >= 0.5);
        const a = members[0], b = members[1]; const pa = a.tx, pb = b.tx;
        gesture(ov, a, at(b)); assert.equal(cellOf(ov, a.entry.name).tx, pb); assert.equal(cellOf(ov, b.entry.name).tx, pa);
        settle(ov);
        const n = folderNamed(ov, 'Development').members.length;
        gesture(ov, ov._cells.find(c => c.kind === 'app' && c.tvis >= 0.5), at(ov._cells[0]));
        assert.equal(folderNamed(ov, 'Development').members.length, n - 1, 'dropped on the centre tile: out');
        settle(ov);
        gesture(ov, ov._cells.find(c => c.kind === 'app' && c.tvis >= 0.5), [ov._W - 2, ov._H - 2]);
        assert.equal(folderNamed(ov, 'Development').members.length, n - 2, 'dropped far outside the lattice: out');
        ov._leaveFolder();
    });
    test('Free policy: drop on an empty slot moves just that tile; the old slot stays empty; Tidy closes gaps; undo restores policy', () => {
        const ov = editing({'custom-policy': 'free'});
        const empties = ov._cells.filter(c => c.kind === 'empty' && c.slot && c.tvis >= 0.5);
        assert.ok(empties.length > 12, `free slots + outer rings are shown while editing (${empties.length})`);
        const before = pos(ov); const far = empties[empties.length - 1];
        gesture(ov, cellOf(ov, 'Code'), at(far));
        const after = pos(ov);
        assert.notEqual(after.get('Code.desktop'), before.get('Code.desktop'));
        unchangedExcept(before, after, ['Code.desktop']);
        assert.ok(LY.slotIndex(ov._customEnv(), ov._layout.root['Code.desktop']) > 11);
        ov._editLayout((env, l) => LY.tidy(env, l)); const t = pos(ov);
        assert.notDeepEqual(t, after, 'tidy closed the gap');
        ov._undoLayout(-1); assert.deepEqual(pos(ov), after);
    });
    test('Packed <-> Free from the menu: Free changes nothing visible, Packed tidies once, one Ctrl+Z goes back (policy too)', () => {
        const ov = editing();
        const before = pos(ov);
        ov._setPolicy('free'); assert.equal(ov.settings.get_string('custom-policy'), 'free'); assert.deepEqual(pos(ov), before); settle(ov);
        const far = ov._cells.filter(c => c.kind === 'empty' && c.slot && c.tvis >= 0.5).pop();
        assert.ok(far, 'Free + editing shows empty slots');
        gesture(ov, cellOf(ov, 'Code'), at(far)); const gapped = pos(ov);
        ov._setPolicy('packed'); assert.equal(ov.settings.get_string('custom-policy'), 'packed');
        assert.notDeepEqual(pos(ov), gapped, 'tidied');
        ov._undoLayout(-1);
        assert.equal(ov.settings.get_string('custom-policy'), 'free', 'undo restored the policy'); assert.deepEqual(pos(ov), gapped);
    });
    test('centre menu offers Edit/Done, Arrangement, Tidy (Free only), Reset (confirmed) and Return', () => {
        const ov = editing();
        let items = null; ov._openMenu = it => { items = it; };
        ov._showCellMenu(ov._cells[0], 5, 5);
        const labels = () => items.map(i => i.label ?? '');
        assert.ok(labels().includes('Done editing (F4)')); assert.ok(labels().some(l => l.startsWith('Arrangement: Packed')));
        assert.ok(!labels().some(l => l.startsWith('Tidy up')), 'no Tidy in Packed');
        ov._setPolicy('free'); settle(ov); ov._showCellMenu(ov._cells[0], 5, 5); assert.ok(labels().some(l => l.startsWith('Tidy up')));
        const before = pos(ov);
        // the Free policy above left a layout we can distinguish from the plain order: move something first
        gesture(ov, cellOf(ov, 'Code'), at(cellOf(ov, 'Weird'))); settle(ov);
        const moved = pos(ov); assert.notDeepEqual(moved, before, 'the swap really happened');
        let confirm = null; ov._openMenu = it => { confirm = it; };
        ov._showCellMenu(ov._cells[0], 5, 5); items.find(i => i.label === 'Reset layout…').onClick();
        assert.deepEqual(pos(ov), moved, 'asks first: nothing changed yet');
        confirm.find(i => i.label?.startsWith('Reset to')).onClick();
        assert.notDeepEqual(pos(ov), moved, 'reset to the plain order');
        ov._undoLayout(-1); assert.deepEqual(pos(ov), moved, 'and Ctrl+Z undoes the reset');
    });
    test('edit-request: openEditing() starts editing, also from a closed Hive', () => {
        const ov = makeOverlay({'group-mode': 'categories'});
        ov.openEditing(); assert.equal(ov._edit.active, true); assert.equal(ov._custom, true);
    });
    test('new apps carry a "new" dot until they are moved or launched', () => {
        const ov = editing();
        fixtures.apps = [...APPS(), mk('Zed', 'Development;')]; ov._refresh(true); settle(ov);
        assert.ok(cellOf(ov, 'Zed').freshDot, 'dot on the new app');
        assert.ok(!cellOf(ov, 'Git').freshDot);
        gesture(ov, cellOf(ov, 'Zed'), at(cellOf(ov, 'Git')));
        assert.ok(!cellOf(ov, 'Zed').freshDot, 'moving it clears the dot');
        fixtures.apps = [...APPS(), mk('Yak', 'Development;')]; ov._refresh(true);
        ov._noteRecent('Yak.desktop'); ov._refresh(true);
        assert.ok(!cellOf(ov, 'Yak').freshDot, 'launching clears it too');
    });
    test('wobble runs only while editing (and animations are on); frame loop healthy during a lift; 150 apps in Free', () => {
        const ov = editing(); ov._animate = true;
        for (let i = 0; i < 4; i++) ov._tick();
        assert.ok(ov._cells.some(c => c.kind === 'app' && c.rot !== 0), 'tiles wobble in edit mode');
        ov._leaveEdit(); for (let i = 0; i < 4; i++) ov._tick();
        const many = Array.from({length: 150}, (_, i) => mk(`App${String(i).padStart(3, '0')}`, ''));
        const big = editing({'custom-policy': 'free'}, many);
        const c = cellOf(big, 'App010'); big._onPress(mev(big, c.sx, c.sy)); big._onMotion(mev(big, c.sx + 25, c.sy));
        for (let i = 0; i < 3; i++) big._tick();
        assert.ok(finite(big)); assert.ok(big._edit.drag); key(big, K.KEY_Escape); big._onRelease(mev(big, 0, 0));
    });
}

// ============================================================================ tuning settings, empty-tile rules, presets, performance log
console.log('tuning + perf');
{
    const LY = await import('../layout.js');
    const OPT = await import('../options.js');
    const pos = ov => new Map(visible(ov).map(c => [c.kind === 'folder' ? `f:${c.entry.name}` : c.kind === 'app' ? c.entry.id : c.kind, `${c.tx.toFixed(1)},${c.ty.toFixed(1)}`]));
    const cellOf = (ov, id) => ov._cells.find(c => c.kind === 'app' && c.entry.id === `${id}.desktop`);
    const settle = ov => { for (const c of ov._cells) { c.lx = c.tx; c.ly = c.ty; c.vis = c.tvis; } ov._pan.x = ov._panT.x; ov._pan.y = ov._panT.y; ov._appear = 1; ov._appearT = 1; for (let i = 0; i < 3; i++) ov._tick(); };
    const mev = (ov, x, y, state = 0) => ({get_button: () => 1, get_coords: () => [x + ov._mon.x, y + ov._mon.y], get_state: () => state});
    const gesture = (ov, from, [tx, ty], {dwell = false} = {}) => {
        ov._onPress(mev(ov, from.sx, from.sy));
        for (let i = 1; i <= 5; i++) ov._onMotion(mev(ov, from.sx + (tx - from.sx) * i / 5, from.sy + (ty - from.sy) * i / 5));
        if (dwell) ov._dwell.since -= 1000;
        ov._onRelease(mev(ov, tx, ty)); settle(ov);
    };
    const emptiesShown = ov => ov._cells.filter(c => c.kind === 'empty' && c.tvis >= 0.5).length;

    test('presets: Liquid Glass (Light) is gone, Squircle is just "Squircle", Terminal and Blueprint use their own colours', () => {
        assert.equal(OPT.PRESETS['liquid-light'], undefined);
        assert.ok(OPT.PRESETS.liquid && OPT.PRESETS.blueprint && OPT.PRESETS.terminal);
        assert.equal(OPT.SHAPES.find(s => s[0] === 'squircle')[1], 'Squircle');
        assert.equal(OPT.PRESETS.blueprint.values['border-style'], 'solid', 'no dashed outlines over icons');
        assert.match(OPT.PRESETS.blueprint.values['backdrop-color'], /^#[0-9a-f]{6}$/i); assert.match(OPT.PRESETS.terminal.values['backdrop-color'], /^#[0-9a-f]{6}$/i);
        assert.equal(Object.keys(OPT.PRESETS).length, 9);
    });
    test('empty tiles: outside edit mode a custom layout shows none by default (even with Show empty on); Keep empty tiles brings back a compact flower', () => {
        const ov = makeOverlay({'group-mode': 'custom', 'custom-policy': 'free', 'show-empty': true}); settle(ov);
        assert.equal(emptiesShown(ov), 0, 'no extra grid after editing');
        ov._enterEdit(); settle(ov);
        const editing = emptiesShown(ov); assert.ok(editing > 12, `Free edit mode shows the free slots (${editing})`);
        ov._leaveEdit(); settle(ov); assert.equal(emptiesShown(ov), 0, 'and they disappear again when editing ends');
        const keep = makeOverlay({'group-mode': 'custom', 'custom-policy': 'free', 'show-empty': true, 'edit-keep-empty': true}); settle(keep);
        const kept = emptiesShown(keep); assert.ok(kept > 0 && kept < editing, `a compact flower stays (${kept} < ${editing})`);
        const off = makeOverlay({'group-mode': 'custom', 'show-empty': false, 'edit-keep-empty': true}); settle(off); assert.equal(emptiesShown(off), 0, 'Show empty tiles off wins');
    });
    test('empty tiles stay compact even when tiles were scattered far out in Free', () => {
        const ov = makeOverlay({'group-mode': 'custom', 'custom-policy': 'free', 'show-empty': true, 'edit-keep-empty': true}); ov._enterEdit(); settle(ov);
        const far = ov._cells.filter(c => c.kind === 'empty' && c.slot && c.tvis >= 0.5).pop();
        gesture(ov, cellOf(ov, 'Code'), [far.sx, far.sy]); ov._leaveEdit(); settle(ov);
        assert.ok(emptiesShown(ov) < 40, `still compact (${emptiesShown(ov)})`);
    });
    test('Free-rings setting widens / narrows the empty slots shown while editing', () => {
        const count = rings => { const ov = makeOverlay({'group-mode': 'custom', 'custom-policy': 'free', 'edit-free-rings': rings}); ov._enterEdit(); settle(ov); return emptiesShown(ov); };
        assert.ok(count(0) < count(2) && count(2) < count(4), `${count(0)} < ${count(2)} < ${count(4)}`);
    });
    test('hold time: a short dwell makes a folder when configured, a long one needs longer', () => {
        const fast = makeOverlay({'group-mode': 'custom', 'edit-dwell-ms': 150}); fast._enterEdit(); settle(fast);
        const a = cellOf(fast, 'Code'), b = cellOf(fast, 'Meld');
        fast._onPress(mev(fast, a.sx, a.sy)); for (let i = 1; i <= 4; i++) fast._onMotion(mev(fast, a.sx + (b.sx - a.sx) * i / 4, a.sy + (b.sy - a.sy) * i / 4));
        fast._dwell.since -= 200; fast._updateTileDrag(b.sx, b.sy);
        assert.equal(fast._edit.drag.target.kind, 'folder', '200 ms >= 150 ms'); fast._onRelease(mev(fast, b.sx, b.sy)); fast._cancelPrompt();
        const slow = makeOverlay({'group-mode': 'custom', 'edit-dwell-ms': 1200}); slow._enterEdit(); settle(slow);
        const c = cellOf(slow, 'Code'), d = cellOf(slow, 'Meld');
        slow._onPress(mev(slow, c.sx, c.sy)); for (let i = 1; i <= 4; i++) slow._onMotion(mev(slow, c.sx + (d.sx - c.sx) * i / 4, c.sy + (d.sy - c.sy) * i / 4));
        slow._dwell.since -= 600; slow._updateTileDrag(d.sx, d.sy);
        assert.equal(slow._edit.drag.target.kind, 'swap', '600 ms < 1200 ms'); key(slow, K.KEY_Escape); slow._onRelease(mev(slow, 0, 0));
    });
    test('wobble intensity: 0 turns it off, bigger = larger angle, speed setting is read', () => {
        const maxRot = values => { const ov = makeOverlay({'group-mode': 'custom', ...values}); ov._animate = true; ov._enterEdit(); settle(ov); let m = 0; for (let i = 0; i < 40; i++) { ov._tick(); for (const c of ov._cells) if (c.kind === 'app') m = Math.max(m, Math.abs(c.rot)); } return m; };
        assert.equal(maxRot({'edit-wobble': 0}), 0); assert.ok(maxRot({'edit-wobble': 3}) > maxRot({'edit-wobble': 1}));
        assert.equal(makeOverlay({'edit-wobble-speed': 2})._opts.edit.wobbleSpeed, 2);
    });
    test('ask-for-name off: a drop that makes a folder keeps "New folder" without a prompt', () => {
        const ov = makeOverlay({'group-mode': 'custom', 'edit-ask-name': false}); ov._enterEdit(); settle(ov);
        gesture(ov, cellOf(ov, 'Code'), [cellOf(ov, 'Meld').sx, cellOf(ov, 'Meld').sy], {dwell: true});
        assert.equal(ov._prompt, null); assert.ok([...ov._folderCells.values()].some(f => f.entry.name === 'New folder'));
    });
    test('lift distance, hit radius, long-press time, auto-pan, lift look: all read from settings and clamped', () => {
        const o = makeOverlay({'edit-lift-distance': 18, 'edit-hit-radius': 0.9, 'edit-long-press-ms': 700, 'edit-autopan': 0, 'edit-lift-scale': 1.3, 'edit-lift-opacity': 0.5})._opts.edit;
        assert.deepEqual([o.liftDistance, o.hit, o.longPressMs, o.autopan, o.liftScale, o.liftOpacity], [18, 0.9, 700, 0, 1.3, 0.5]);
        const bad = makeOverlay({'edit-lift-distance': 9999, 'edit-hit-radius': -4, 'edit-dwell-ms': 1, 'edit-free-rings': 50})._opts.edit;
        assert.deepEqual([bad.liftDistance, bad.hit, bad.dwellMs, bad.freeRings], [30, 0.3, 150, 4]);
        const ov = makeOverlay({'group-mode': 'custom', 'edit-lift-distance': 18}); ov._enterEdit(); settle(ov);
        const c = cellOf(ov, 'Git'); ov._onPress(mev(ov, c.sx, c.sy)); ov._onMotion(mev(ov, c.sx + 12, c.sy));
        assert.equal(ov._edit.drag, null, '12 px < 18 px: not lifted yet'); ov._onMotion(mev(ov, c.sx + 25, c.sy)); assert.ok(ov._edit.drag, '25 px: lifted');
        key(ov, K.KEY_Escape); ov._onRelease(mev(ov, 0, 0));
        const ap = makeOverlay({'group-mode': 'custom', 'edit-autopan': 0}); ap._enterEdit(); settle(ap);
        const g = cellOf(ap, 'Git'); ap._onPress(mev(ap, g.sx, g.sy)); ap._onMotion(mev(ap, g.sx + 30, g.sy)); ap._onMotion(mev(ap, ap._W - 5, ap._H / 2));
        assert.equal(ap._edit.drag.pan.x, 0, 'auto-pan off'); key(ap, K.KEY_Escape); ap._onRelease(mev(ap, 0, 0));
    });

    // ---- performance log
    const withPerf = (values = {}, apps) => { const ov = makeOverlay({'perf-log': true, ...values}, apps); ov.reports = []; ov._perfWrite = t => { ov.reports.push(t); return '/tmp/perf.log'; }; return ov; };
    test('perf log off: nothing is recorded and no report is written', () => {
        const ov = makeOverlay(); ov.reports = []; ov._perfWrite = t => ov.reports.push(t);
        ov._perfBegin(); assert.equal(ov._perf, null); for (let i = 0; i < 5; i++) ov._tick(); ov._perfEnd(); assert.deepEqual(ov.reports, []);
    });
    test('perf log on: a session records frames, phases and the scene, and ends in a readable report', () => {
        const ov = withPerf({'group-mode': 'custom'}); ov._perfBegin(); ov._perfDescribe(); assert.ok(ov._perf.active);
        ov._rebuild(); ov._refresh(true); ov._enterEdit(); settle(ov);
        for (let i = 0; i < 30; i++) ov._tick();
        const a = cellOf(ov, 'Code'), b = cellOf(ov, 'Meld'); gesture(ov, a, [b.sx, b.sy]);
        ov._perfEnd();
        assert.equal(ov.reports.length, 1); const t = ov.reports[0];
        for (const re of [/=== Hive perf session #1/, /env: .*monitor=/, /settings: shape=hexagon/, /scene: apps=10 folders=0 custom=true edit=true layout=honeycomb max cells=\d+/,
            /frames: \d+ total/, /interval ms/, /callback ms/, /tile paints/, /by state/, /phases \(ms\):/, /rebuild +n=/, /applyLayout +n=/, /afterLayoutChange +n=/, /counters: .*layoutEdits=1/, /events:\n.*lift app/, /hints:/])
            assert.match(t, re);
        assert.equal(ov._perf.active, false, 'the session is closed after the report');
    });
    test('perf log: cell paints and queued repaints are counted per frame; a second open is session #2', () => {
        const ov = withPerf(); ov._perfBegin(); ov._pf.draws = 7; ov._pf.drawMs = 3.5; ov._pf.repaints = 9; ov._tick();
        assert.equal(ov._perf.session.draws.stats().max, 7); assert.equal(ov._perf.session.repaints.stats().max, 9); assert.equal(ov._pf.repaints, 0, 'counters reset every frame');
        ov._perfEnd(); ov._perfBegin(); assert.equal(ov._perf.session.no, 2); ov._perfEnd(); assert.equal(ov.reports.length, 2);
    });
    test('perf log: a failing writer never breaks closing; destroy() flushes an open session', () => {
        const ov = withPerf(); ov._perfWrite = () => { throw new Error('disk full'); };
        const w = console.warn; console.warn = () => {}; try { ov._perfBegin(); ov._perfEnd(); } finally { console.warn = w; }
        const ov2 = withPerf(); ov2._perfBegin(); ov2.destroy(); assert.equal(ov2.reports.length, 1);
    });
}

// ============================================================================ 1.10: retained scene, empties, tiers, look details
console.log('1.10 retained scene + governor + look');
{
    const {G} = await import('../shapes.js');
    const cellOf = (ov, id) => ov._cells.find(c => c.kind === 'app' && c.entry.id === `${id}.desktop`);
    const settle = ov => { for (const c of ov._cells) { c.lx = c.tx; c.ly = c.ty; c.vis = c.tvis; } ov._pan.x = ov._panT.x; ov._pan.y = ov._panT.y; ov._appear = 1; ov._appearT = 1; for (let i = 0; i < 3; i++) ov._tick(); };
    const withPerf = (values = {}) => { const ov = makeOverlay({'perf-log': true, ...values}); ov.reports = []; ov._perfWrite = t => { ov.reports.push(t); return '/tmp/perf.log'; }; return ov; };
    const calm = {psi: {cpu: {some: {avg10: 0}}, io: {some: {avg10: 0}}, mem: {some: {avg10: 0}}}, cpu: 0, io: 0, mem: 0, load: 0, gpu: -1, loadAvg: {l1: 0}};
    const busy = {...calm, psi: {...calm.psi, cpu: {some: {avg10: 60}}}, cpu: 60};

    test('retained scene: with nothing changed, options / rebuild / theme are all skipped', () => {
        const ov = makeOverlay();
        assert.equal(ov._applyOptions(), false, 'second applyOptions finds no dirty flag');
        assert.equal(ov._rebuild(), false);
        assert.equal(ov._applyTheme(), false, 'theme signature unchanged');
        const before = ov._cells.slice();
        ov._applyOptions(); ov._rebuild(); ov._applyTheme();
        assert.deepEqual(ov._cells, before, 'the very same cells are kept');
    });
    test('a dirty flag with identical options still does no downstream work; a real change repaints and re-themes', () => {
        const ov = makeOverlay();
        ov._optsDirty = true;
        assert.equal(ov._applyOptions(), false, 'identical options: nothing to redo');
        ov.settings._set('perf-log', true);
        assert.equal(ov._optsDirty, false, 'perf-log is not a rendering setting');
        ov.settings._set('tile-opacity', 0.4); // open + changed -> _refresh (forces a rebuild: new cells paint themselves)
        assert.equal(ov._opts.tileOpacity, 0.4);
        const painted = []; for (const c of ov._cells) if (c.area) c.area.queue_repaint = () => painted.push(c);
        ov._cellsStale = true; ov._refresh(false); // options flagged stale without a rebuild: surviving tiles must be repainted
        assert.ok(painted.length > 0 && ov._cellsStale === false, 'existing tiles are repainted for the new look');
        ov.settings._set('backdrop-opacity', 0.9);
        assert.equal(ov._themeSig.includes('0.9'), true);
    });
    test('decorative empty tiles are shared-texture icons: no cairo area of their own', () => {
        const ov = makeOverlay();
        const empties = ov._cells.filter(c => c.kind === 'empty');
        assert.ok(empties.length > 0);
        assert.ok(empties.every(c => c.area === null && c.emptyIcon), 'plain icons');
        assert.ok(ov._cells.filter(c => c.kind === 'app').every(c => c.area), 'real tiles still have their drawing area');
        ov._rp(empties[0].area, 'x'); // must not throw
    });
    test('custom layout, Packed: no empty-tile actors at all; Free + editing builds them; leaving removes them; tiles do not move', () => {
        const ov = makeOverlay({'group-mode': 'custom'}); settle(ov);
        const n0 = ov._cells.length;
        assert.equal(ov._cells.filter(c => c.kind === 'empty').length, 0, 'packed: none');
        ov.settings._set('custom-policy', 'free'); settle(ov);
        const pos = id => { const c = cellOf(ov, id); return [c.tx, c.ty]; };
        const before = ['Code', 'Meld', 'Git'].map(pos);
        assert.equal(ov._cells.filter(c => c.kind === 'empty').length, 0, 'free but not editing: none');
        ov._enterEdit(); settle(ov);
        assert.ok(ov._cells.filter(c => c.kind === 'empty').length > 5, 'editing in Free shows the empty slots');
        assert.deepEqual(['Code', 'Meld', 'Git'].map(pos), before, 'entering edit mode moves nothing');
        ov._leaveEdit(); settle(ov);
        assert.equal(ov._cells.filter(c => c.kind === 'empty').length, 0);
        assert.ok(ov._cells.length <= n0 + 1);
        assert.deepEqual(['Code', 'Meld', 'Git'].map(pos), before);
    });
    test('quality tiers: manual lite / balanced strip animation, ambient, refraction; full restores; the user settings are untouched', () => {
        const ov = makeOverlay({'perf-tier': 'lite', 'ambient-animation': 'float', 'open-animation': 'spin', 'glass-refraction': true, animations: true});
        assert.equal(ov._chooseTier(), true); assert.equal(ov._tier, 'lite');
        assert.equal(ov._applyOptions(), true);
        assert.equal(ov._opts.animations, false); assert.equal(ov._animate, false); assert.equal(ov._opts.ambient, 'none'); assert.equal(ov._opts.tierWidgets, false);
        assert.equal(ov.settings._get('ambient-animation'), 'float', 'settings never rewritten');
        ov.settings._set('perf-tier', 'balanced'); ov._chooseTier(); ov._applyOptions();
        assert.equal(ov._opts.animations, true); assert.equal(ov._opts.ambient, 'none'); assert.equal(ov._opts.openAnim, 'pop'); assert.equal(ov._opts.refraction, false);
        ov.settings._set('perf-tier', 'full'); ov._chooseTier(); ov._applyOptions();
        assert.equal(ov._opts.ambient, 'float'); assert.equal(ov._opts.openAnim, 'spin'); assert.equal(ov._opts.refraction, true);
    });
    test('auto tier follows the measured pressure and relaxes again; a failing reader never throws', () => {
        const ov = makeOverlay({'perf-tier': 'auto'});
        ov._pressureSample = () => calm; ov._chooseTier(); assert.equal(ov._tier, 'full');
        ov._pressureSample = () => busy; assert.equal(ov._chooseTier(), true); assert.equal(ov._tier, 'lite'); assert.match(ov._tierReason, /cpu pressure 60%/);
        ov._applyOptions(); assert.equal(ov._opts.tier, 'lite');
        ov._pressureSample = () => calm; ov._chooseTier(); assert.equal(ov._tier, 'full', 'pressure gone: back to full');
        const ov2 = makeOverlay({'perf-tier': 'auto'}); assert.doesNotThrow(() => ov2._chooseTier());
    });
    test('first-frame times feed the governor; slow opens push the tier down', () => {
        const ov = makeOverlay({'perf-tier': 'auto'}); ov._pressureSample = () => calm;
        for (let i = 0; i < 4; i++) ov._openHist.push(900);
        ov._chooseTier(); assert.equal(ov._tier, 'lite'); assert.match(ov._tierReason, /recent opens/);
        ov._firstFramePending = true; ov._openT0 = 1e6 - 5000; ov._tick(); assert.equal(ov._firstFramePending, false); assert.equal(ov._openHist.size, 5);
    });
    test('live check pauses ambient motion under load and resumes; manual tiers never pause', () => {
        const ov = makeOverlay({'perf-tier': 'auto', 'ambient-animation': 'float'});
        ov._pressureSample = () => busy; ov._liveCheck(); assert.equal(ov._ambientPaused, true);
        ov._pressureSample = () => calm; ov._liveCheck(); assert.equal(ov._ambientPaused, false);
        const m = makeOverlay({'perf-tier': 'lite'}); m._pressureSample = () => busy; m._liveCheck(); assert.equal(m._ambientPaused, false);
    });
    test('prewarm builds the scene while closed, never while open, and obeys its switch', () => {
        const ov = makeOverlay(); ov._open = false; ov._root.visible = false;
        ov._sig = ''; assert.equal(ov.prewarm(), true); assert.ok(ov._cells.length > 10 && ov._prewarmed);
        ov._open = true; assert.equal(ov.prewarm(), false, 'open: hands off');
        const off = makeOverlay({'prewarm-scene': false}); off._open = false; off._root.visible = false; assert.equal(off.prewarm(), false);
        ov._open = false; ov._schedulePrewarm(); assert.ok(ov._prewarmSource, 'a debounced background build is queued');
        ov.destroy();
    });
    test('look options: pattern keeps the vignette area alive, label case + font, centre style, search style reach the right places', () => {
        const ov = makeOverlay({'backdrop-pattern': 'grid-paper', 'show-vignette': false, 'label-case': 'upper', 'label-font': 'monospace', 'label-glow': 0.5, 'center-style': 'outline', 'search-style': 'square', 'search-prompt': 'chevron', 'pattern-opacity': 0.2, 'pattern-spacing': 24});
        assert.equal(ov._vignette.visible, true, 'pattern without vignette still paints');
        assert.equal(G.PATTERN, 'grid-paper'); assert.equal(G.LABEL_UPPER, true); assert.equal(G.CENTER_STYLE, 'outline');
        assert.match(ov._labelStyle(), /font-family: monospace/); assert.match(ov._labelStyle(), /text-shadow/);
        assert.doesNotMatch(ov._labelStyle(undefined, false), /text-shadow/);
        assert.equal(ov._entryShape(), 'border-radius: 3px; ');
        const plain = makeOverlay(); assert.equal(plain._entryShape(), ''); assert.equal(G.PATTERN, 'none'); assert.equal(G.LABEL_UPPER, false);
    });
    test('changing icon tint / label case rebuilds the cells (they are built with it); an unrelated setting does not', () => {
        const ov = makeOverlay(); const sig = ov._geomSig;
        ov.settings._set('icon-tint', 'accent'); assert.notEqual(ov._geomSig, sig);
        const sig2 = ov._geomSig; ov.settings._set('label-case', 'upper'); assert.notEqual(ov._geomSig, sig2);
        const sig3 = ov._geomSig; ov.settings._set('hover-scale', 1.2); assert.equal(ov._geomSig, sig3);
    });
    test('inverse-video hover flips the caption colour and back', () => {
        const ov = makeOverlay({'hover-effect': 'invert'}); const c = cellOf(ov, 'Code'); const styles = [];
        c.label = {set_style: s => styles.push(s)}; ov._setHover(c); ov._setHover(null);
        assert.equal(styles.length, 2); assert.notEqual(styles[0], styles[1]);
    });
    test('perf log: system facts, pressure samples and the tier land in the report', () => {
        const ov = withPerf({'perf-tier': 'auto'}); ov._pressureSample = () => ({...busy, load: 3.2}); ov._chooseTier();
        ov._perfBegin(); ov._perfDescribe(); ov._perf.reason('theme', 3); ov._perfEnd();
        const t = ov.reports[0];
        assert.match(t, /system: cpu=/); assert.match(t, /tier=lite/); assert.match(t, /pressure \(PSI/); assert.match(t, /Quality tier: "lite"/);
        assert.match(t, /tint=original/); assert.match(t, /pattern=none/);
    });
}
console.log(`\nsmoke: ${passed} checks passed`);
