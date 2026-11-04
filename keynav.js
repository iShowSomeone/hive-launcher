// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Keyboard navigation over the lattice. Pure functions on "cells" that have lattice positions `tx`/`ty`
// (no imports on purpose, so they can be unit-tested outside GNOME Shell: see dev/test_keynav.mjs).

/** Steps taken by Ctrl/Shift + arrow. */
export const LEAP_STEPS = 4;
/** Steps taken by PageUp / PageDown. */
export const PAGE_STEPS = 6;

/** The cell closest to the lattice point (x, y), or null. */
export function nearestTo(cells, x, y) {
    let best = null;
    let bd = Infinity;
    for (const c of cells) {
        const d = (c.tx - x) ** 2 + (c.ty - y) ** 2;
        if (d < bd) {
            bd = d;
            best = c;
        }
    }
    return best;
}

/**
 * The neighbour of `cur` in direction (dx, dy) (each -1, 0 or 1), or null at the edge of the lattice.
 * Cells must lie ahead of `cur` along the direction; the ones that stay close to the line win, which is
 * what makes Up/Down on a honeycomb (and Left/Right zig-zagging across it) feel natural.
 */
export function stepFrom(cells, cur, dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    let best = null;
    let bc = Infinity;
    for (const c of cells) {
        if (c === cur)
            continue;
        const vx = c.tx - cur.tx;
        const vy = c.ty - cur.ty;
        const along = vx * ux + vy * uy;
        if (along <= 1)
            continue;
        const cost = along + 1.5 * Math.abs(vx * uy - vy * ux); // prefer staying on the line
        if (cost < bc) {
            bc = cost;
            best = c;
        }
    }
    return best;
}

/** Repeat stepFrom() up to `steps` times; stops early at the edge. Returns the last cell reached or null. */
export function leapFrom(cells, cur, dx, dy, steps) {
    let at = cur;
    let moved = null;
    for (let i = 0; i < steps; i++) {
        const next = stepFrom(cells, at, dx, dy);
        if (!next)
            break;
        at = next;
        moved = next;
    }
    return moved;
}

/** Next (dir = 1) or previous (dir = -1) entry of `list`, wrapping around. With no current item: first / last. */
export function cycle(list, cur, dir) {
    const n = list.length;
    if (n === 0)
        return null;
    const i = list.indexOf(cur);
    if (i < 0)
        return dir >= 0 ? list[0] : list[n - 1];
    return list[(i + dir + n) % n];
}
