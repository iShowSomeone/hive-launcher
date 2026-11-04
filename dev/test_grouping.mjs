import assert from 'node:assert/strict';
import {mainCategory, groupByCategory, groupByDefinitions, groupOf, splitCategories} from '../grouping.js';

const e = (id, categories, hidden = false) => ({id, name: id, categories, hidden});
assert.equal(mainCategory('GNOME;GTK;Utility;TextEditor;'), 'Utility');
assert.equal(mainCategory('Utility;TextEditor;Development;'), 'Development', 'specific beats generic');
assert.equal(mainCategory('Network;WebBrowser;'), 'Network');
assert.equal(mainCategory('GTK;'), null);
assert.equal(mainCategory(''), null);
assert.equal(mainCategory(undefined), null);
assert.deepEqual(splitCategories('A;B;;'), ['A', 'B']);

// ---- categories
const entries = [
    e('firefox', 'Network;WebBrowser;'), e('code', 'Development;IDE;'), e('gedit', 'Utility;TextEditor;'),
    e('calc', 'Utility;Calculator;'), e('mpv', 'AudioVideo;Player;'), e('weird', 'X-Foo;'),
    e('vim', 'Utility;Development;TextEditor;'), e('hid1', 'AudioVideo;', true),
];
let f = groupByCategory(entries);
const names = f.map(x => x.name);
assert.deepEqual(names, ['Development', 'Utilities'], `got ${names}`); // Network: 1 app, AudioVideo: 1 visible → loose
assert.deepEqual(f[0].ids, ['code', 'vim']);
assert.deepEqual(f[1].ids, ['gedit', 'calc']);
const go = groupOf(f);
assert.equal(go.get('vim'), 'cat:Development'); assert.equal(go.get('firefox'), undefined);
// folders are ranked by the best-ranked member (entries are sorted by the user's sort mode)
f = groupByCategory([entries[2], entries[3], entries[1], entries[6]]);
assert.deepEqual(f.map(x => x.name), ['Utilities', 'Development']);
assert.deepEqual(groupByCategory([]), []);

// ---- GNOME app folders
const defs = [
    {id: 'Utilities', name: 'Utilities', apps: ['gedit'], categories: [], excluded: []},
    {id: 'Dev', name: 'Dev', apps: [], categories: ['Development'], excluded: ['vim']},
    {id: 'Empty', name: 'Empty', apps: ['nothing-installed'], categories: [], excluded: []},
    {id: 'Media', name: 'Media', apps: [], categories: ['AudioVideo'], excluded: []},
];
f = groupByDefinitions(entries, defs);
assert.deepEqual(f.map(x => x.id), ['gnome:Dev', 'gnome:Utilities', 'gnome:Media'], 'ranked by best member');
const byName = Object.fromEntries(f.map(x => [x.name, x.ids]));
assert.deepEqual(byName.Utilities, ['gedit']);
assert.deepEqual(byName.Dev, ['code'], 'excluded app is not matched by category');
assert.ok(!('Empty' in byName), 'folders with no installed apps are dropped');
assert.deepEqual(byName.Media, ['mpv', 'hid1'], 'hidden apps are members but do not count as visible');
// explicit membership beats an earlier folder's category claim
f = groupByDefinitions(entries, [
    {id: 'A', name: 'A', apps: [], categories: ['Utility'], excluded: []},
    {id: 'B', name: 'B', apps: ['gedit'], categories: [], excluded: []},
]);
assert.deepEqual(Object.fromEntries(f.map(x => [x.name, x.ids])), {B: ['gedit'], A: ['calc', 'vim']});
// a folder whose only app is hidden is dropped
assert.deepEqual(groupByDefinitions([e('h', 'Game;', true)], [{id: 'G', name: 'G', apps: ['h']}]), []);
console.log('grouping: all tests passed');
