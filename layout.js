// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Custom layout" engine (Edit Hive): FIXED-SLOT storage + the operations on it. Pure functions with no
// imports, so they are unit-tested in plain Node (dev/test_layout.mjs). Every operation is immutable: it returns a
// NEW layout object (undo = keep the previous one) and never moves a tile it was not asked to move.
//
// Vocabulary
//   slot   [q, r]: an integer pair in the lattice's own axial coordinates. [0,0] is the centre / logo, never assignable.
//   level  'root' or a folder id. Every level has its own private lattice (a folder's centre tile is its back button).
//   key    what a tile is called inside a level: a desktop id for an app, `f:<id>` for a folder tile (root only).
//   env    makeEnv(spiral, policy, lattice): the spiral is buildSpiral(layout, MAX_RINGS) from shapes.js, injected so
//          this file needs no gi imports. Policy 'packed' = no holes; 'free' = holes allowed.
//
// Layout JSON (version 1):
//   {version, lattice?, policy?, root: {key: [q,r]}, folders: [{id, name, slots: {appId: [q,r]}}], fresh: [appId],
//    parked: {appId: {where: 'root'|folderId, slot: [q,r]}}}

export const LAYOUT_VERSION = 1;
export const ROOT = 'root';
export const FOLDER_PREFIX = 'f:';
export const MAX_FOLDERS = 200;
export const MAX_APPS = 1000;
export const MAX_TEXT = 256 * 1024;
export const MAX_NAME = 40;
export const DEFAULT_FOLDER_NAME = 'Folder';
export const UNDO_CAP = 50;

export const folderKey = id => `${FOLDER_PREFIX}${id}`;
export const isFolderKey = k => typeof k === 'string' && k.startsWith(FOLDER_PREFIX);
export const folderIdOf = k => k.slice(FOLDER_PREFIX.length);

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeKey = k => typeof k === 'string' && k.length > 0 && k.length <= 256 && !BAD_KEYS.has(k);
const isInt = n => Number.isInteger(n) && Math.abs(n) < 1000;
const isSlot = s => Array.isArray(s) && s.length === 2 && isInt(s[0]) && isInt(s[1]);

// ------------------------------------------------------------------ environment / slot helpers
export function makeEnv(spiral, policy = 'packed', lattice = 'honeycomb') {
    const index = new Map();
    spiral.forEach(([q, r], i) => index.set(`${q},${r}`, i));
    return {spiral, index, policy: policy === 'free' ? 'free' : 'packed', lattice};
}

/** Spiral position of a slot (0 = centre), or -1 when it is not on the lattice. */
export const slotIndex = (env, slot) => (isSlot(slot) ? (env.index.get(`${slot[0]},${slot[1]}`) ?? -1) : -1);
/** The slot at a spiral position (a fresh array), or null past the end. */
export const slotAt = (env, i) => (i >= 0 && i < env.spiral.length ? [...env.spiral[i]] : null);
/** How many tiles a level can hold. */
export const capacity = env => env.spiral.length - 1;

export function normName(name) {
    const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
    return s || DEFAULT_FOLDER_NAME;
}

/** A short random-looking folder id that is not in `taken`. `rnd` (0..1) is injectable for tests. */
export function newFolderId(taken, rnd = Math.random) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (;;) {
        let id = 'k';
        for (let i = 0; i < 5; i++)
            id += chars[Math.floor(rnd() * chars.length) % chars.length];
        if (!taken.has(id))
            return id;
    }
}

// ------------------------------------------------------------------ constructing / copying
export function emptyLayout(lattice, policy) {
    const l = {version: LAYOUT_VERSION, root: {}, folders: [], fresh: [], parked: {}};
    if (lattice)
        l.lattice = lattice;
    if (policy)
        l.policy = policy;
    return l;
}

export function cloneLayout(l) {
    const out = {
        version: l.version, root: {...mapCopy(l.root)}, folders: l.folders.map(f => ({id: f.id, name: f.name, slots: mapCopy(f.slots)})),
        fresh: [...l.fresh], parked: {},
    };
    if (l.lattice)
        out.lattice = l.lattice;
    if (l.policy)
        out.policy = l.policy;
    for (const k of Object.keys(l.parked))
        out.parked[k] = {where: l.parked[k].where, slot: [...l.parked[k].slot]};
    return out;
}

function mapCopy(m) {
    const o = {};
    for (const k of Object.keys(m))
        o[k] = [m[k][0], m[k][1]];
    return o;
}

export const isEmptyLayout = l => Object.keys(l.root).length === 0 && l.folders.length === 0;

// ------------------------------------------------------------------ queries
export function levelMap(layout, level) {
    if (level === ROOT)
        return layout.root;
    return layout.folders.find(f => f.id === level)?.slots ?? null;
}

export const findFolder = (layout, id) => layout.folders.find(f => f.id === id) ?? null;

/** 'root' / folder id of the level that holds app `key`, or null. */
export function levelOfApp(layout, key) {
    if (Object.hasOwn(layout.root, key))
        return ROOT;
    for (const f of layout.folders) {
        if (Object.hasOwn(f.slots, key))
            return f.id;
    }
    return null;
}

/** Keys of a level ordered by spiral position (the order they appear in reading order). */
export function orderedKeys(env, layout, level) {
    const m = levelMap(layout, level);
    if (!m)
        return [];
    return Object.keys(m).sort((a, b) => slotIndex(env, m[a]) - slotIndex(env, m[b]));
}

export function allAppKeys(layout) {
    const out = Object.keys(layout.root).filter(k => !isFolderKey(k));
    for (const f of layout.folders)
        out.push(...Object.keys(f.slots));
    return out;
}

/** The highest ring-index of any occupied slot (spiral index, 0 when empty). Used to size the lattice. */
export function highestIndex(env, layout) {
    let hi = 0;
    for (const m of [layout.root, ...layout.folders.map(f => f.slots)]) {
        for (const k of Object.keys(m))
            hi = Math.max(hi, slotIndex(env, m[k]));
    }
    return hi;
}

/** Map: key -> "q,r" for every tile of every level. Used by tests and by diffPositions(). */
export function positions(layout) {
    const out = new Map();
    for (const k of Object.keys(layout.root))
        out.set(`root/${k}`, layout.root[k].join(','));
    for (const f of layout.folders) {
        out.set(`folder/${f.id}`, 'exists');
        for (const k of Object.keys(f.slots))
            out.set(`${f.id}/${k}`, f.slots[k].join(','));
    }
    return out;
}

/** Which tiles changed position (or appeared / disappeared) between two layouts. */
export function diffPositions(a, b) {
    const pa = positions(a);
    const pb = positions(b);
    const changed = [];
    for (const [k, v] of pb) {
        if (pa.get(k) !== v && !k.startsWith('folder/'))
            changed.push(k);
    }
    for (const k of pa.keys()) {
        if (!pb.has(k) && !k.startsWith('folder/'))
            changed.push(k);
    }
    return changed;
}

// ------------------------------------------------------------------ slot allocation
/** First free slot after the highest occupied position; falls back to the lowest free slot. null = level is full. */
export function tailSlot(env, map) {
    const used = new Set(Object.keys(map).map(k => slotIndex(env, map[k])));
    used.add(0);
    let hi = 0;
    for (const i of used)
        hi = Math.max(hi, i);
    for (let i = hi + 1; i < env.spiral.length; i++) {
        if (!used.has(i))
            return slotAt(env, i);
    }
    for (let i = 1; i < env.spiral.length; i++) {
        if (!used.has(i))
            return slotAt(env, i);
    }
    return null;
}

/** Packed policy: a hole appeared at spiral position h. The LAST tile jumps into it (the "one-tile rule"). */
function closeHole(env, map, h) {
    if (env.policy !== 'packed')
        return;
    let last = null;
    let hi = 0;
    for (const k of Object.keys(map)) {
        const i = slotIndex(env, map[k]);
        if (i > hi) {
            hi = i;
            last = k;
        }
    }
    if (last !== null && h > 0 && h < hi)
        map[last] = slotAt(env, h);
}

/** Packed: close every hole (lowest first) with the one-tile rule. */
function closeAllHoles(env, map) {
    if (env.policy !== 'packed')
        return;
    for (let guard = 0; guard < 5000; guard++) {
        const used = new Set(Object.keys(map).map(k => slotIndex(env, map[k])));
        let hi = 0;
        for (const i of used)
            hi = Math.max(hi, i);
        let hole = -1;
        for (let i = 1; i < hi; i++) {
            if (!used.has(i)) {
                hole = i;
                break;
            }
        }
        if (hole < 0)
            return;
        closeHole(env, map, hole);
    }
}

function removeFresh(layout, ...keys) {
    if (layout.fresh.length)
        layout.fresh = layout.fresh.filter(k => !keys.includes(k));
}

const ok = layout => ({layout, error: null});
const refuse = (layout, error) => ({layout, error});

// ------------------------------------------------------------------ operations
/** Forget the `fresh` flag of an app (it was launched or moved). Returns the same object when there was nothing to clear. */
export function clearFresh(layout, key) {
    if (!layout.fresh.includes(key))
        return layout;
    const out = cloneLayout(layout);
    removeFresh(out, key);
    return out;
}

/** Exchange the slots of two tiles of one level. Nothing else moves. */
export function swap(env, layout, level, a, b) {
    const m = levelMap(layout, level);
    if (!m || !Object.hasOwn(m, a) || !Object.hasOwn(m, b) || a === b)
        return refuse(layout, 'missing');
    const out = cloneLayout(layout);
    const om = levelMap(out, level);
    [om[a], om[b]] = [om[b], om[a]];
    removeFresh(out, a, b);
    return ok(out);
}

/** Move a tile into an EMPTY slot (policy 'free' only). */
export function moveToSlot(env, layout, level, key, slot) {
    const m = levelMap(layout, level);
    if (env.policy !== 'free')
        return refuse(layout, 'policy');
    if (!m || !Object.hasOwn(m, key))
        return refuse(layout, 'missing');
    const idx = slotIndex(env, slot);
    if (idx <= 0)
        return refuse(layout, 'invalid-slot');
    if (Object.keys(m).some(k => k !== key && slotIndex(env, m[k]) === idx))
        return refuse(layout, 'occupied');
    const out = cloneLayout(layout);
    levelMap(out, level)[key] = slotAt(env, idx);
    removeFresh(out, key);
    return ok(out);
}

/** Take `key` out of `level` (it must exist) and close the hole per policy. Returns the removed slot index. */
function detach(env, layout, level, key) {
    const m = levelMap(layout, level);
    const h = slotIndex(env, m[key]);
    delete m[key];
    closeHole(env, m, h);
}

/** Add an app at the tail of a level. Returns false when the level is full. */
function attachTail(env, layout, level, key) {
    const m = levelMap(layout, level);
    const s = tailSlot(env, m);
    if (!s)
        return false;
    m[key] = s;
    return true;
}

/** A new empty folder at the root tail. */
export function newEmptyFolder(env, layout, name, id) {
    if (layout.folders.length >= MAX_FOLDERS)
        return refuse(layout, 'too-many');
    const out = cloneLayout(layout);
    const fid = id ?? newFolderId(new Set(out.folders.map(f => f.id)));
    if (out.folders.some(f => f.id === fid))
        return refuse(layout, 'duplicate-id');
    const s = tailSlot(env, out.root);
    if (!s)
        return refuse(layout, 'full');
    out.folders.push({id: fid, name: normName(name), slots: {}});
    out.root[folderKey(fid)] = s;
    return {layout: out, error: null, folderId: fid};
}

/** A new folder that takes the slot of app `appKey` (root level) and contains just that app. */
export function newFolder(env, layout, appKey, name, id) {
    if (!Object.hasOwn(layout.root, appKey) || isFolderKey(appKey))
        return refuse(layout, 'missing');
    if (layout.folders.length >= MAX_FOLDERS)
        return refuse(layout, 'too-many');
    const out = cloneLayout(layout);
    const fid = id ?? newFolderId(new Set(out.folders.map(f => f.id)));
    if (out.folders.some(f => f.id === fid))
        return refuse(layout, 'duplicate-id');
    const slot = out.root[appKey];
    delete out.root[appKey];
    out.root[folderKey(fid)] = slot;
    out.folders.push({id: fid, name: normName(name), slots: {[appKey]: slotAt(env, 1)}});
    removeFresh(out, appKey);
    return {layout: out, error: null, folderId: fid};
}

/** App `dragKey` dropped on app `targetKey` (both root level): a new folder takes the TARGET's slot. */
export function makeFolder(env, layout, level, dragKey, targetKey, name, id) {
    if (level !== ROOT || dragKey === targetKey)
        return refuse(layout, 'invalid');
    for (const k of [dragKey, targetKey]) {
        if (!Object.hasOwn(layout.root, k) || isFolderKey(k))
            return refuse(layout, 'missing');
    }
    if (layout.folders.length >= MAX_FOLDERS)
        return refuse(layout, 'too-many');
    const out = cloneLayout(layout);
    const fid = id ?? newFolderId(new Set(out.folders.map(f => f.id)));
    if (out.folders.some(f => f.id === fid))
        return refuse(layout, 'duplicate-id');
    const slot = out.root[targetKey];
    const h = slotIndex(env, out.root[dragKey]);
    delete out.root[targetKey];
    delete out.root[dragKey];
    out.root[folderKey(fid)] = slot;
    out.folders.push({id: fid, name: normName(name), slots: {[targetKey]: slotAt(env, 1), [dragKey]: slotAt(env, 2)}});
    closeHole(env, out.root, h);
    removeFresh(out, dragKey, targetKey);
    return {layout: out, error: null, folderId: fid};
}

/** Move an app (from the root or from another folder) into an existing folder: appended at that folder's tail. */
export function addToFolder(env, layout, appKey, folderId) {
    const src = levelOfApp(layout, appKey);
    if (src === null || !findFolder(layout, folderId))
        return refuse(layout, 'missing');
    if (src === folderId)
        return refuse(layout, 'same');
    const out = cloneLayout(layout);
    const dest = levelMap(out, folderId);
    const s = tailSlot(env, dest);
    if (!s)
        return refuse(layout, 'full');
    detach(env, out, src, appKey);
    dest[appKey] = s;
    removeFresh(out, appKey);
    return ok(out);
}

/** Take an app out of its folder: it goes to the root tail (both policies). */
export function removeFromFolder(env, layout, folderId, appKey) {
    const f = findFolder(layout, folderId);
    if (!f || !Object.hasOwn(f.slots, appKey))
        return refuse(layout, 'missing');
    const out = cloneLayout(layout);
    const s = tailSlot(env, out.root);
    if (!s)
        return refuse(layout, 'full');
    detach(env, out, folderId, appKey);
    out.root[appKey] = s;
    removeFresh(out, appKey);
    return ok(out);
}

/** Delete a folder: its first app takes the folder's slot, the rest go to the root tail. */
export function deleteFolder(env, layout, folderId) {
    const f = findFolder(layout, folderId);
    if (!f)
        return refuse(layout, 'missing');
    const out = cloneLayout(layout);
    const members = orderedKeys(env, out, folderId);
    const fk = folderKey(folderId);
    const slot = out.root[fk];
    const h = slotIndex(env, slot);
    delete out.root[fk];
    out.folders = out.folders.filter(x => x.id !== folderId);
    for (const id of Object.keys(out.parked)) { // apps parked inside this folder go back to the root queue
        if (out.parked[id].where === folderId)
            out.parked[id] = {where: ROOT, slot: [...out.parked[id].slot]};
    }
    if (members.length === 0) {
        closeHole(env, out.root, h);
        return ok(out);
    }
    out.root[members[0]] = slot;
    for (const k of members.slice(1)) {
        const s = tailSlot(env, out.root);
        if (!s)
            return refuse(layout, 'full');
        out.root[k] = s;
    }
    return ok(out);
}

export function renameFolder(env, layout, folderId, name) {
    const f = findFolder(layout, folderId);
    if (!f)
        return refuse(layout, 'missing');
    const out = cloneLayout(layout);
    findFolder(out, folderId).name = normName(name);
    return ok(out);
}

/** Stable compaction of a level (or of every level) to spiral positions 1..n. One undo step. */
export function tidy(env, layout, level = 'all') {
    const out = cloneLayout(layout);
    const levels = level === 'all' ? [ROOT, ...out.folders.map(f => f.id)] : [level];
    for (const lv of levels) {
        const m = levelMap(out, lv);
        if (!m)
            continue;
        orderedKeys(env, out, lv).forEach((k, i) => {
            m[k] = slotAt(env, i + 1);
        });
    }
    return ok(out);
}

/** Switch policy. Packed means "no holes", so entering it tidies once. */
export function setPolicy(env, layout, policy) {
    return policy === 'packed' ? tidy(env, layout) : ok(cloneLayout(layout));
}

// ------------------------------------------------------------------ snapshot of the arrangement on screen
/**
 * The layout that reproduces exactly what is on screen now.
 *   rootKeys : the root level in reading order (folders as `f:<id>`, then loose apps; hidden apps last)
 *   folders  : [{id, name, ids: [member ids in reading order, hidden last]}]
 * Reading order = spiral order, so tile i lands on spiral position i + 1: no tile moves when the mode switches.
 */
export function snapshotCurrent(env, rootKeys, folders, freshIds = []) {
    const out = emptyLayout(env.lattice, env.policy);
    const seen = new Set();
    const fids = new Set();
    for (const f of folders) {
        if (!safeKey(f.id) || fids.has(f.id))
            continue;
        fids.add(f.id);
        const slots = {};
        let n = 0;
        for (const id of f.ids) {
            if (!safeKey(id) || seen.has(id) || isFolderKey(id) || n + 1 >= env.spiral.length)
                continue;
            seen.add(id);
            slots[id] = slotAt(env, ++n);
        }
        out.folders.push({id: f.id, name: normName(f.name), slots});
    }
    let n = 0;
    for (const k of rootKeys) {
        if (!safeKey(k) || n + 1 >= env.spiral.length)
            continue;
        if (isFolderKey(k)) {
            if (!fids.has(folderIdOf(k)) || Object.hasOwn(out.root, k))
                continue;
        } else if (seen.has(k) || Object.hasOwn(out.root, k)) {
            continue;
        }
        if (!isFolderKey(k))
            seen.add(k);
        out.root[k] = slotAt(env, ++n);
    }
    for (const f of out.folders) { // a folder the caller forgot to list still needs its tile
        if (!Object.hasOwn(out.root, folderKey(f.id))) {
            const s = tailSlot(env, out.root);
            if (s)
                out.root[folderKey(f.id)] = s;
        }
    }
    out.fresh = freshIds.filter(id => Object.hasOwn(out.root, id));
    return out;
}

// ------------------------------------------------------------------ reconcile with the installed apps
/**
 * Bring a layout in line with reality (pure; run in memory on every load / rebuild, persisted with the next edit):
 *  1. uninstalled apps are parked (their slot is released); reinstalled apps return to their parked slot when it is free
 *  2. installed apps that have no place are appended at the tail of the root and flagged `fresh`
 *  3. a layout from another lattice shape, or with slots that do not exist any more, relocates what it must
 *  4. Packed closes holes with the one-tile rule (or re-compacts stably when the lattice shape changed)
 * `installed` is an iterable of desktop ids. Returns {layout, changed, notes}.
 */
export function reconcile(env, layout, installed) {
    const inst = new Set([...installed].filter(safeKey));
    const out = cloneLayout(layout);
    let changed = false;
    const notes = [];
    // another lattice shape, or a switch from Free to Packed made while the Hive was not looking: compact stably (below)
    const shapeChanged = (!!out.lattice && out.lattice !== env.lattice) || (out.policy === 'free' && env.policy === 'packed');
    if (out.lattice !== env.lattice || out.policy !== env.policy) {
        out.lattice = env.lattice;
        out.policy = env.policy;
        changed = true;
    }

    // drop folder tiles whose folder record is gone, and folder records that no tile points at
    for (const k of Object.keys(out.root)) {
        if (isFolderKey(k) && !findFolder(out, folderIdOf(k))) {
            delete out.root[k];
            changed = true;
        }
    }
    for (const f of out.folders) {
        if (!Object.hasOwn(out.root, folderKey(f.id))) {
            const s = tailSlot(env, out.root);
            if (s) {
                out.root[folderKey(f.id)] = s;
                changed = true;
            }
        }
    }

    // 1a. uninstalled -> parked
    const parkOne = (where, map, k) => {
        out.parked[k] = {where, slot: [...map[k]]};
        delete map[k];
        changed = true;
    };
    for (const k of Object.keys(out.root)) {
        if (!isFolderKey(k) && !inst.has(k))
            parkOne(ROOT, out.root, k);
    }
    for (const f of out.folders) {
        for (const k of Object.keys(f.slots)) {
            if (!inst.has(k))
                parkOne(f.id, f.slots, k);
        }
    }
    const fresh0 = out.fresh.length;
    out.fresh = out.fresh.filter(k => inst.has(k) && Object.hasOwn(out.root, k));
    if (out.fresh.length !== fresh0)
        changed = true;

    // 1b. an app that is both placed and parked: the placement wins
    for (const k of Object.keys(out.parked)) {
        if (levelOfApp(out, k) !== null) {
            delete out.parked[k];
            changed = true;
        }
    }

    // 3. slots that are not on this lattice (shape switch / smaller spiral): free them, they are re-placed below
    const orphans = [];
    for (const lv of [ROOT, ...out.folders.map(f => f.id)]) {
        const m = levelMap(out, lv);
        const taken = new Set();
        for (const k of orderedKeys(env, out, lv)) {
            const i = slotIndex(env, m[k]);
            if (i <= 0 || taken.has(i)) {
                orphans.push([lv, k]);
                delete m[k];
                changed = true;
            } else {
                taken.add(i);
            }
        }
    }
    for (const [lv, k] of orphans) {
        const s = tailSlot(env, levelMap(out, lv));
        if (s)
            levelMap(out, lv)[k] = s;
        else
            notes.push('full'); // cannot happen in practice: the level had room for this tile before
    }

    // 1c. reinstalled apps go home when their old slot is free, otherwise they are appended like new apps
    const placed = new Set(allAppKeys(out));
    const toAppend = [];
    for (const k of inst) {
        if (placed.has(k))
            continue;
        const p = out.parked[k];
        if (p) {
            const m = levelMap(out, p.where);
            const i = slotIndex(env, p.slot);
            if (m && i > 0 && !Object.keys(m).some(x => slotIndex(env, m[x]) === i)) {
                m[k] = slotAt(env, i);
                delete out.parked[k];
                placed.add(k);
                changed = true;
                continue;
            }
            delete out.parked[k];
        }
        toAppend.push(k);
    }
    // 2. new apps: the tail of the root, flagged fresh (callers pass `installed` in the order they want)
    for (const k of toAppend) {
        if (allAppKeys(out).length >= MAX_APPS)
            break;
        const s = tailSlot(env, out.root);
        if (!s) {
            notes.push('full');
            break;
        }
        out.root[k] = s;
        out.fresh.push(k);
        changed = true;
    }

    // 4. packed: no holes
    if (env.policy === 'packed') {
        for (const lv of [ROOT, ...out.folders.map(f => f.id)]) {
            const m = levelMap(out, lv);
            const before = JSON.stringify(m);
            if (shapeChanged) {
                orderedKeys(env, out, lv).forEach((k, i) => {
                    m[k] = slotAt(env, i + 1);
                });
            } else {
                closeAllHoles(env, m);
            }
            if (JSON.stringify(m) !== before)
                changed = true;
        }
    }
    return {layout: out, changed, notes};
}

// ------------------------------------------------------------------ persistence
/** Parse stored JSON. Never throws. {layout, warnings, invalid}: `invalid` = unreadable / too new (do not overwrite the raw text). */
export function parseLayout(text, lattice) {
    const warnings = [];
    const bad = why => ({layout: emptyLayout(lattice), warnings: [why], invalid: true, blank: false});
    if (text === undefined || text === null || String(text).trim() === '')
        return {layout: emptyLayout(lattice), warnings, invalid: false, blank: true};
    if (typeof text !== 'string' || text.length > MAX_TEXT)
        return bad('custom layout is too large');
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return bad(`custom layout is not valid JSON (${e.message})`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return bad('custom layout has the wrong shape');
    if (data.version !== LAYOUT_VERSION)
        return bad(`custom layout version ${data.version} is not supported`);

    const out = emptyLayout(typeof data.lattice === 'string' ? data.lattice : undefined,
        data.policy === 'packed' || data.policy === 'free' ? data.policy : undefined);
    const readMap = (src, into, what, allowFolders) => {
        if (!src || typeof src !== 'object' || Array.isArray(src)) {
            if (src !== undefined)
                warnings.push(`${what}: not an object, ignored`);
            return;
        }
        const used = new Set();
        for (const k of Object.keys(src)) {
            const s = src[k];
            if (!safeKey(k) || !isSlot(s) || (s[0] === 0 && s[1] === 0) || used.has(`${s[0]},${s[1]}`) || (!allowFolders && isFolderKey(k))) {
                warnings.push(`${what}: dropped "${String(k).slice(0, 40)}"`);
                continue;
            }
            used.add(`${s[0]},${s[1]}`);
            into[k] = [s[0], s[1]];
        }
    };
    readMap(data.root, out.root, 'root', true);
    const ids = new Set();
    const seenApps = new Set(Object.keys(out.root).filter(k => !isFolderKey(k)));
    if (Array.isArray(data.folders)) {
        for (const f of data.folders.slice(0, MAX_FOLDERS)) {
            if (!f || typeof f !== 'object' || !safeKey(f.id) || ids.has(f.id)) {
                warnings.push('folders: dropped a malformed folder');
                continue;
            }
            ids.add(f.id);
            const slots = {};
            readMap(f.slots, slots, `folder ${f.id}`, false);
            for (const k of Object.keys(slots)) {
                if (seenApps.has(k))
                    delete slots[k]; // an app lives in one place only
                else
                    seenApps.add(k);
            }
            out.folders.push({id: f.id, name: normName(f.name), slots});
        }
    }
    // every folder tile must have a folder and vice versa (reconcile re-adds missing tiles)
    for (const k of Object.keys(out.root)) {
        if (isFolderKey(k) && !ids.has(folderIdOf(k)))
            delete out.root[k];
    }
    if (Array.isArray(data.fresh))
        out.fresh = [...new Set(data.fresh.filter(k => safeKey(k) && Object.hasOwn(out.root, k)))];
    if (data.parked && typeof data.parked === 'object' && !Array.isArray(data.parked)) {
        for (const k of Object.keys(data.parked)) {
            const p = data.parked[k];
            if (safeKey(k) && p && typeof p === 'object' && (p.where === ROOT || ids.has(p.where)) && isSlot(p.slot))
                out.parked[k] = {where: p.where, slot: [p.slot[0], p.slot[1]]};
        }
    }
    if (allAppKeys(out).length > MAX_APPS)
        return bad('custom layout has too many apps');
    return {layout: out, warnings, invalid: false, blank: false};
}

export function serializeLayout(layout) {
    return JSON.stringify(layout);
}

// ------------------------------------------------------------------ undo / redo
export class UndoStack {
    constructor(cap = UNDO_CAP) {
        this._cap = cap;
        this._undo = [];
        this._redo = [];
    }

    get canUndo() { return this._undo.length > 0; }
    get canRedo() { return this._redo.length > 0; }

    /** Call with the layout that is about to be replaced by a user action. */
    push(prev) {
        this._undo.push(prev);
        if (this._undo.length > this._cap)
            this._undo.shift();
        this._redo.length = 0;
    }

    /** `current` goes to the redo list; returns the layout to show now (null when there is nothing to undo). */
    undo(current) {
        const prev = this._undo.pop() ?? null;
        if (prev)
            this._redo.push(current);
        return prev;
    }

    redo(current) {
        const next = this._redo.pop() ?? null;
        if (next)
            this._undo.push(current);
        return next;
    }

    clear() {
        this._undo.length = 0;
        this._redo.length = 0;
    }
}
