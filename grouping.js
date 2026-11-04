// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which apps go into which folder tile. Pure functions (no imports) so they can be unit-tested outside GNOME
// Shell (dev/test_grouping.mjs). An "entry" is {id, name, hidden, categories} as built by hive.js; the
// functions return folders as {id, name, icon, ids: [entry ids in the entries' order]}.

/** Automatic folders need at least this many visible apps, otherwise the apps stay loose on the lattice. */
export const MIN_CATEGORY_FOLDER = 2;

// [freedesktop main category, folder name]. Order = priority when an app lists several (specific first, the
// catch-all categories last), e.g. "Utility;TextEditor;Development;" belongs in Development.
export const MAIN_CATEGORIES = [
    ['Game', 'Games'],
    ['Development', 'Development'],
    ['Graphics', 'Graphics'],
    ['AudioVideo', 'Sound & Video'],
    ['Office', 'Office'],
    ['Education', 'Education'],
    ['Science', 'Science'],
    ['Network', 'Internet'],
    ['Settings', 'Settings'],
    ['System', 'System'],
    ['Utility', 'Utilities'],
];

export function splitCategories(str) {
    return (str ?? '').split(';').map(s => s.trim()).filter(Boolean);
}

/** The main category an app belongs to (or null). `cats` is the Categories= value or an array. */
export function mainCategory(cats) {
    const have = new Set(Array.isArray(cats) ? cats : splitCategories(cats));
    for (const [id] of MAIN_CATEGORIES) {
        if (have.has(id))
            return id;
    }
    return null;
}

const visibleCount = (ids, byId) => ids.filter(id => !byId.get(id)?.hidden).length;

/** Order folders by the best-ranked app they contain, so the most-used folders sit nearest the centre. */
function rankFolders(folders, entries) {
    const rank = new Map(entries.map((e, i) => [e.id, i]));
    const first = f => Math.min(...f.ids.map(id => rank.get(id) ?? Infinity));
    return folders.map((f, i) => ({f, i, r: first(f)}))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(x => x.f);
}

/** Automatic folders from the apps' freedesktop categories. */
export function groupByCategory(entries) {
    const buckets = new Map();
    for (const e of entries) {
        const cat = mainCategory(e.categories);
        if (!cat)
            continue;
        if (!buckets.has(cat))
            buckets.set(cat, []);
        buckets.get(cat).push(e.id);
    }
    const byId = new Map(entries.map(e => [e.id, e]));
    const folders = [];
    for (const [cat, name] of MAIN_CATEGORIES) {
        const ids = buckets.get(cat);
        if (ids && visibleCount(ids, byId) >= MIN_CATEGORY_FOLDER)
            folders.push({id: `cat:${cat}`, name, ids});
    }
    return rankFolders(folders, entries);
}

/**
 * GNOME's own app folders (org.gnome.desktop.app-folders). `defs` = [{id, name, apps, categories, excluded}].
 * Explicitly listed apps win over category matches; an app lives in the first folder that claims it.
 * Folders without any visible app are dropped.
 */
export function groupByDefinitions(entries, defs) {
    const claimed = new Set();
    const members = new Map(defs.map(d => [d.id, []]));
    const byId = new Map(entries.map(e => [e.id, e]));

    for (const d of defs) {
        const apps = new Set(d.apps ?? []);
        for (const e of entries) {
            if (!claimed.has(e.id) && apps.has(e.id)) {
                claimed.add(e.id);
                members.get(d.id).push(e.id);
            }
        }
    }
    for (const d of defs) {
        const cats = new Set(d.categories ?? []);
        const excluded = new Set(d.excluded ?? []);
        if (cats.size === 0)
            continue;
        for (const e of entries) {
            if (claimed.has(e.id) || excluded.has(e.id))
                continue;
            if (splitCategories(e.categories).some(c => cats.has(c))) {
                claimed.add(e.id);
                members.get(d.id).push(e.id);
            }
        }
    }
    const folders = [];
    for (const d of defs) {
        const ids = members.get(d.id);
        // keep the entries' order inside the folder
        ids.sort((a, b) => entries.indexOf(byId.get(a)) - entries.indexOf(byId.get(b)));
        if (visibleCount(ids, byId) > 0)
            folders.push({id: `gnome:${d.id}`, name: d.name, ids});
    }
    return rankFolders(folders, entries);
}

/** Map of app id → folder id for a folder list. */
export function groupOf(folders) {
    const m = new Map();
    for (const f of folders) {
        for (const id of f.ids)
            m.set(id, f.id);
    }
    return m;
}
