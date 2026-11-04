// Pure tests for dragdrop.js:  node dev/test_dragdrop.mjs
import assert from 'node:assert/strict';
import {dropTarget, onTile, onSlot, Dwell, dwellProgress, DWELL_MS, HIT} from '../dragdrop.js';

const T = (key, kind, x, y, r = 40) => ({key, kind, x, y, r});
const tiles = [T('logo', 'logo', 0, 0), T('a', 'app', 100, 0), T('b', 'app', 200, 0), T('f:k', 'folder', 100, 100), T('c', 'app', 300, 0, 10)];
const slots = [{slot: [3, 0], x: 400, y: 0, r: 40}];
const app = {key: 'x', kind: 'app'};
const fold = {key: 'f:z', kind: 'folder'};
const at = (x, y, d = app, st = {}) => dropTarget(tiles, slots, {x, y}, d, st);
let n = 0;
const test = (name, fn) => { fn(); n++; };

test('dropping on an app swaps; dwell or Shift turns it into a folder', () => {
    assert.deepEqual(at(100, 0), {kind: 'swap', key: 'a'});
    assert.deepEqual(at(100, 0, app, {dwellMs: DWELL_MS - 1}), {kind: 'swap', key: 'a'});
    assert.deepEqual(at(100, 0, app, {dwellMs: DWELL_MS}), {kind: 'folder', key: 'a'});
    assert.deepEqual(at(100, 0, app, {shift: true}), {kind: 'folder', key: 'a'});
});
test('an app dropped on a folder is always added to it, no dwell needed', () => {
    assert.deepEqual(at(100, 100), {kind: 'into', key: 'f:k'});
    assert.deepEqual(at(100, 100, app, {shift: true}), {kind: 'into', key: 'f:k'});
});
test('a folder never nests: folder on app and folder on folder both swap', () => {
    assert.deepEqual(at(100, 0, fold, {shift: true, dwellMs: 9999}), {kind: 'swap', key: 'a'});
    assert.deepEqual(at(100, 100, fold), {kind: 'swap', key: 'f:k'});
});
test('no folder can be made inside a folder level', () => {
    assert.deepEqual(at(100, 0, app, {inFolder: true, shift: true, dwellMs: 9999}), {kind: 'swap', key: 'a'});
});
test('the centre tile is "out" inside a folder and nothing at the root; beyond the ring is "out" too', () => {
    assert.deepEqual(at(0, 0, app, {inFolder: true}), {kind: 'out'});
    assert.deepEqual(at(0, 0), {kind: 'none'});
    assert.deepEqual(at(900, 900, app, {inFolder: true, beyond: true}), {kind: 'out'});
    assert.deepEqual(at(900, 900, app, {beyond: true}), {kind: 'none'});
});
test('empty slots are targets only in policy free', () => {
    assert.deepEqual(at(400, 0), {kind: 'none'});
    assert.deepEqual(at(400, 0, app, {policy: 'packed'}), {kind: 'none'});
    assert.deepEqual(at(400, 0, app, {policy: 'free'}), {kind: 'move', slot: [3, 0]});
    assert.deepEqual(at(400 + HIT * 40 + 1, 0, app, {policy: 'free'}), {kind: 'none'});
    assert.deepEqual(onSlot(null, {policy: 'free'}), {kind: 'none'});
});
test('hit radius scales with the fisheye: a small outer tile needs a precise pointer', () => {
    assert.deepEqual(at(300 + 4, 0), {kind: 'swap', key: 'c'});
    assert.deepEqual(at(300 + 12, 0), {kind: 'none'});
    assert.deepEqual(at(200 + HIT * 40 - 0.01, 0), {kind: 'swap', key: 'b'});
    assert.deepEqual(at(200 + HIT * 40 + 0.01, 0), {kind: 'none'});
});
test('the dragged tile is never its own target; the nearest of overlapping tiles wins', () => {
    assert.deepEqual(at(100, 0, {key: 'a', kind: 'app'}), {kind: 'none'});
    const crowd = [T('p', 'app', 100, 0), T('q', 'app', 110, 0)];
    assert.deepEqual(dropTarget(crowd, [], {x: 108, y: 0}, app), {kind: 'swap', key: 'q'});
});
test('onTile is what the keyboard-carry path uses', () => {
    assert.deepEqual(onTile(app, T('a', 'app', 0, 0), {shift: true}), {kind: 'folder', key: 'a'});
    assert.deepEqual(onTile(app, T('a', 'app', 0, 0)), {kind: 'swap', key: 'a'});
    assert.deepEqual(onTile(fold, T('a', 'app', 0, 0), {shift: true}), {kind: 'swap', key: 'a'});
});
test('Dwell restarts when the target changes and reports 0 over nothing', () => {
    const d = new Dwell();
    assert.equal(d.update('a', 1000), 0);
    assert.equal(d.update('a', 1250), 250);
    assert.equal(d.update('b', 1300), 0);
    assert.equal(d.update('b', 1750), 450);
    assert.equal(d.update(null, 1800), 0);
    assert.equal(d.update('b', 1900), 0, 'coming back starts over');
    assert.equal(dwellProgress(DWELL_MS / 2), 0.5);
    assert.equal(dwellProgress(-5), 0);
    assert.equal(dwellProgress(99999), 1);
});
test('the dwell time and the hit radius are configurable', () => {
    assert.deepEqual(at(100, 0, app, {dwellMs: 200, dwellNeeded: 150}), {kind: 'folder', key: 'a'});
    assert.deepEqual(at(100, 0, app, {dwellMs: 600, dwellNeeded: 900}), {kind: 'swap', key: 'a'});
    assert.deepEqual(at(100 + 30, 0, app, {hit: 0.9}), {kind: 'swap', key: 'a'});
    assert.deepEqual(at(100 + 30, 0, app, {hit: 0.5}), {kind: 'none'});
    assert.equal(dwellProgress(300, 600), 0.5);
});
console.log(`dragdrop: all ${n} tests passed`);
