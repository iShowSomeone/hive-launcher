import assert from 'node:assert/strict';
import {buildProfile, parseProfile, coerceValue, isProfileKey, PROFILE_FORMAT} from '../profile.js';

assert.equal(isProfileKey('shape', false), true);
assert.equal(isProfileKey('hidden-apps', false), false);
assert.equal(isProfileKey('hidden-apps', true), true);
assert.equal(isProfileKey('preview-request', true), false);

const text = buildProfile({shape: 'circle', 'tile-gap': 8, snap: true, 'toggle-hive': ['<Super>a']}, '1.8.0', new Date(0));
const p = parseProfile(text);
assert.deepEqual(p.settings, {shape: 'circle', 'tile-gap': 8, snap: true, 'toggle-hive': ['<Super>a']});
assert.equal(p.extension, '1.8.0');
assert.equal(JSON.parse(text).exported, '1970-01-01T00:00:00.000Z');

for (const [bad, msg] of [
    ['{nope', /valid JSON/], ['null', /not a Hive/], ['{"format":"other","settings":{}}', /not a Hive/],
    [`{"format":"${PROFILE_FORMAT}","version":99,"settings":{}}`, /newer/],
    [`{"format":"${PROFILE_FORMAT}","version":1}`, /no settings/],
    [`{"format":"${PROFILE_FORMAT}","version":1,"settings":[1]}`, /no settings/],
]) assert.throws(() => parseProfile(bad), msg, bad);

const ok = (t, v) => coerceValue(t, v).ok;
assert.ok(ok('b', true) && !ok('b', 1) && !ok('b', 'true'));
assert.ok(ok('d', 1.5) && ok('d', 3) && !ok('d', NaN) && !ok('d', Infinity) && !ok('d', '1'));
assert.ok(ok('s', '') && !ok('s', null) && !ok('s', 5));
assert.ok(ok('u', 0) && !ok('u', -1) && !ok('u', 1.5) && !ok('u', 2 ** 32));
assert.ok(ok('i', -5) && !ok('i', 2 ** 31));
assert.ok(ok('as', []) && ok('as', ['a']) && !ok('as', [1]) && !ok('as', 'a'));
assert.ok(!ok('a{sv}', {}));
const arr = ['x']; assert.notEqual(coerceValue('as', arr).value, arr, 'arrays are copied');
assert.ok(ok('s', 'x'.repeat(256 * 1024)) && !ok('s', 'x'.repeat(256 * 1024 + 1)), 'strings (the custom layout) are capped at 256 KB');
console.log('profile: all tests passed');
