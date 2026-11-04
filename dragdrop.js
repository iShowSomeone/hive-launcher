// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drop-target resolution for editing the custom layout (pure; no imports; tested in dev/test_dragdrop.mjs).
// Everything is in SCREEN space because the fisheye lens scales tiles: a tile's radius is `r` = hexRadius * its screen scale.
//
//   tile      {key, kind: 'app'|'folder'|'logo', x, y, r}     (the dragged tile itself is skipped by key)
//   freeSlot  {slot: [q, r], x, y, r}                         (empty slots; only offered in policy 'free')
//   dragged   {key, kind: 'app'|'folder'}
//   state     {policy, inFolder, shift, dwellMs, dwellNeeded, hit, beyond}
//             `beyond` = pointer is past the folder's outer ring; `dwellNeeded` / `hit` override DWELL_MS / HIT (user settings)
//
// Result kinds: 'swap' {key} | 'folder' {key} (make a folder with that app) | 'into' {key} (add to that folder) |
//               'move' {slot} (free policy) | 'out' (take the app out of the open folder) | 'none' (drop cancels).

export const HIT = 0.55;       // pointer within this fraction of a tile's screen radius = it is the target
export const DWELL_MS = 400;   // hovering this long over an app turns "swap" into "make a folder"

/** Tracks how long the pointer has stayed on the same target. */
export class Dwell {
    constructor() {
        this.key = null;
        this.since = 0;
    }

    /** Feed the key currently targeted (null = nothing); returns milliseconds spent on it. */
    update(key, nowMs) {
        if (key !== this.key) {
            this.key = key;
            this.since = nowMs;
        }
        return key === null ? 0 : nowMs - this.since;
    }

    reset() {
        this.key = null;
    }
}

/** 0..1 progress of the dwell ring (`needed` = the configured dwell time). */
export const dwellProgress = (ms, needed = DWELL_MS) => Math.max(0, Math.min(1, ms / Math.max(1, needed)));

function under(items, p, skipKey, hit = HIT) {
    let best = null;
    let bd = Infinity;
    for (const it of items) {
        if (skipKey !== null && it.key === skipKey)
            continue;
        const d = Math.hypot(p.x - it.x, p.y - it.y);
        if (d <= hit * it.r && d < bd) {
            best = it;
            bd = d;
        }
    }
    return best;
}

/** What dropping `dragged` onto `target` (a tile) means. Shared by the pointer and the keyboard-carry paths. */
export function onTile(dragged, target, st = {}) {
    if (target.kind === 'logo')
        return st.inFolder ? {kind: 'out'} : {kind: 'none'};
    if (target.kind === 'folder')
        return dragged.kind === 'folder' ? {kind: 'swap', key: target.key} : {kind: 'into', key: target.key};
    if (dragged.kind === 'folder')
        return {kind: 'swap', key: target.key}; // a folder dropped on an app swaps places: folders never nest
    const makeFolder = !st.inFolder && (st.shift || (st.dwellMs ?? 0) >= (st.dwellNeeded ?? DWELL_MS));
    return {kind: makeFolder ? 'folder' : 'swap', key: target.key};
}

/** What dropping on an EMPTY slot means. */
export function onSlot(slot, st = {}) {
    return (st.policy ?? 'packed') === 'free' && slot ? {kind: 'move', slot} : {kind: 'none'};
}

export function dropTarget(tiles, freeSlots, pointer, dragged, st = {}) {
    const hit = under(tiles, pointer, dragged.key, st.hit ?? HIT);
    if (hit)
        return onTile(dragged, hit, st);
    if ((st.policy ?? 'packed') === 'free') {
        const s = under(freeSlots.map(f => ({...f, key: null})), pointer, null, st.hit ?? HIT);
        if (s)
            return onSlot(s.slot, st);
    }
    if (st.inFolder && st.beyond)
        return {kind: 'out'};
    return {kind: 'none'};
}
