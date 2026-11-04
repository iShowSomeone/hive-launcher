import assert from 'node:assert/strict';
import {nearestTo, stepFrom, leapFrom, cycle} from '../keynav.js';

const SQ3 = Math.sqrt(3), S = 100;
// same formulas as shapes.js lat()
const hex = (q, r) => ({q, r, tx: S * 1.5 * q, ty: S * SQ3 * (r + q / 2)});
const grid = (q, r) => ({q, r, tx: S * q, ty: S * r});
const build = (f, K) => { const o = []; for (let q = -K; q <= K; q++) for (let r = -K; r <= K; r++) if (f === hex ? Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) <= K : true) o.push(f(q, r)); return o; };
const at = (cells, q, r) => cells.find(c => c.q === q && c.r === r);

// ---- honeycomb (flat-top: Up/Down are straight, Left/Right zig-zag)
{
    const cells = build(hex, 3), o = at(cells, 0, 0);
    assert.equal(stepFrom(cells, o, 0, 1), at(cells, 0, 1), 'down');
    assert.equal(stepFrom(cells, o, 0, -1), at(cells, 0, -1), 'up');
    const right = stepFrom(cells, o, 1, 0);
    assert.ok(right.tx > 0 && Math.abs(right.ty) < S * SQ3, 'right lands on a diagonal neighbour');
    // walking right ten times must never get stuck inside the lattice and always moves right
    let c = at(cells, -3, 0), seen = 0;
    while ((c = stepFrom(cells, c, 1, 0))) { seen++; assert.ok(seen < 20); }
    assert.ok(seen >= 3, `walked ${seen} steps`);
    // edge: nothing above the top
    const top = cells.reduce((a, b) => (b.ty < a.ty ? b : a));
    assert.equal(stepFrom(cells, top, 0, -1), null, 'null at the edge');
    // left then right comes back to a cell on the same row (±1 hex row)
    const l = stepFrom(cells, o, -1, 0), back = stepFrom(cells, l, 1, 0);
    assert.ok(Math.abs(back.ty - o.ty) <= S * SQ3 + 1e-6);
}
// ---- square grid
{
    const cells = build(grid, 3), o = at(cells, 0, 0);
    assert.equal(stepFrom(cells, o, 1, 0), at(cells, 1, 0));
    assert.equal(stepFrom(cells, o, -1, 0), at(cells, -1, 0));
    assert.equal(stepFrom(cells, o, 0, 1), at(cells, 0, 1));
    assert.equal(leapFrom(cells, o, 1, 0, 2), at(cells, 2, 0), 'leap 2');
    assert.equal(leapFrom(cells, o, 1, 0, 10), at(cells, 3, 0), 'leap stops at edge');
    assert.equal(leapFrom(cells, at(cells, 3, 0), 1, 0, 4), null, 'leap at edge = no move');
    assert.equal(nearestTo(cells, 120, 20), at(cells, 1, 0));
    assert.equal(nearestTo([], 0, 0), null);
    // sparse lattice (search results): skips the hole and finds the next cell on the line
    const sparse = cells.filter(c => !(c.q === 1 && c.r === 0));
    const skip = stepFrom(sparse, o, 1, 0);
    assert.ok(skip.tx > 0 && skip !== at(cells, 1, 0), 'steps over the hole to the next cell on the right');
}
// ---- cycle
{
    const l = ['a', 'b', 'c'];
    assert.equal(cycle(l, 'a', 1), 'b'); assert.equal(cycle(l, 'c', 1), 'a');
    assert.equal(cycle(l, 'a', -1), 'c'); assert.equal(cycle(l, 'x', 1), 'a');
    assert.equal(cycle(l, 'x', -1), 'c'); assert.equal(cycle([], 'x', 1), null);
}
// ---- reachability: from the centre every cell can be reached with arrow keys alone
{
    for (const [f, name] of [[hex, 'hex'], [grid, 'grid']]) {
        const cells = build(f, 4), start = at(cells, 0, 0);
        const seen = new Set([start]), q = [start];
        while (q.length) { const c = q.pop(); for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const n = stepFrom(cells, c, dx, dy); if (n && !seen.has(n)) { seen.add(n); q.push(n); } } }
        assert.equal(seen.size, cells.length, `${name}: ${seen.size}/${cells.length} reachable`);
    }
}
console.log('keynav: all tests passed');
