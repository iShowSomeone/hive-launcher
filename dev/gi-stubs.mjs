// Stand-ins for the GNOME Shell libraries, just enough to load and exercise hive.js under plain Node.
// Anything not given an explicit override is a "universal stub": a callable / constructible proxy whose
// properties are more stubs (stable per name, so `Clutter.KEY_Escape === Clutter.KEY_Escape`).

export function makeStub(path, overrides = {}) {
    const children = new Map();
    const store = {...overrides};
    return new Proxy(function () {}, {
        get(_t, prop) {
            if (prop in store)
                return store[prop];
            if (typeof prop === 'symbol' || prop === 'then')
                return undefined;
            if (prop === 'toString' || prop === 'toJSON')
                return () => `[stub ${path}]`;
            if (!children.has(prop))
                children.set(prop, makeStub(`${path}.${prop}`));
            return children.get(prop);
        },
        set(_t, prop, value) {
            store[prop] = value;
            return true;
        },
        has: () => true,
        apply: () => makeStub(`${path}()`),
        construct: () => makeStub(`${path}#new`),
    });
}

// ------------------------------------------------------------------ fixtures the tests mutate
export const fixtures = {
    apps: [],            // {id, name, cats, state?}
    launched: [], newWindows: [],
    handlers: {},        // signal name → callback registered on Shell.AppSystem
    gnomeFolders: [],    // [{id, name, translate?, apps, categories, excluded}]
    log: [],
    connects: {},        // signal name → handlers registered on any St.Widget (e.g. the root's captured-event)
    timers: [],          // GLib.timeout_add callbacks (never run automatically)
};

const appObj = a => ({
    get_id: () => a.id, get_name: () => a.name, get_icon: () => ({icon: a.id}),
    get_state: () => a.state ?? 0, can_open_new_window: () => true,
    open_new_window: () => fixtures.newWindows.push(a.id), activate: () => fixtures.launched.push(a.id),
    get_windows: () => [], state: a.state ?? 0,
});
const appSystem = {
    get_installed: () => fixtures.apps.map(a => ({should_show: () => true, get_id: () => a.id, get_categories: () => a.cats ?? ''})),
    lookup_app: id => { const a = fixtures.apps.find(x => x.id === id); return a ? appObj(a) : null; },
    connect: (sig, fn) => { fixtures.handlers[sig] = fn; return 1; },
    disconnect: () => {},
};

export const Shell = makeStub('Shell', {
    AppSystem: {
        get_default: () => appSystem,
        search: q => [fixtures.apps.filter(a => a.name.toLowerCase().includes(q.toLowerCase())).map(a => a.id)],
    },
    AppUsage: {get_default: () => ({compare: () => 0})},
    AppState: {STOPPED: 0, STARTING: 1, RUNNING: 2},
    util_get_translated_folder_name: n => `${n.replace(/^X-GNOME-/, '').replace(/\.directory$/, '')}~tr`,
});

export const Clutter = makeStub('Clutter', {
    EVENT_STOP: true, EVENT_PROPAGATE: false,
    ModifierType: {CONTROL_MASK: 4, SHIFT_MASK: 1, MOD1_MASK: 8},
});

export const GLib = makeStub('GLib', {
    get_monotonic_time: () => 1e6, timeout_add: (_p, _ms, fn) => fixtures.timers.push(fn), timeout_add_seconds: () => 1, idle_add: () => 1,
    source_remove: id => { fixtures.timers[id - 1] = null; return true; }, SOURCE_REMOVE: false, SOURCE_CONTINUE: true, PRIORITY_DEFAULT: 0, PRIORITY_LOW: 300,
    get_user_cache_dir: () => '/tmp/hive-smoke-cache', build_filenamev: p => p.join('/'),
    mkdir_with_parents: () => 0, compute_checksum_for_string: () => 'abcdef0123456789', ChecksumType: {MD5: 0},
});

export const Gio = makeStub('Gio', {
    Settings: class {
        constructor(o) {
            const folder = fixtures.gnomeFolders.find(f => o.path?.includes(`/folders/${f.id}/`));
            if (o.schema_id === 'org.gnome.desktop.app-folders') {
                return {get_strv: k => (k === 'folder-children' ? fixtures.gnomeFolders.map(f => f.id) : [])};
            }
            return {
                get_string: () => folder.name, get_boolean: () => !!folder.translate,
                get_strv: k => ({apps: folder.apps, categories: folder.categories, 'excluded-apps': folder.excluded}[k] ?? []),
            };
        }
    },
    SettingsSchemaSource: {get_default: () => ({lookup: () => ({})})},
    AppInfo: {get_all: () => []},
});

export const St = makeStub('St', {
    Widget: class {
        constructor() {
            return makeStub('St.Widget#new', {
                connect: (sig, fn) => { (fixtures.connects[sig] ??= []).push(fn); return 1; },
            });
        }
    },
});

export const Main = makeStub('Main', {sessionMode: {isLocked: false}});
export const AppFavorites = {
    getAppFavorites: () => ({isFavorite: () => false, getFavorites: () => [], addFavorite() {}, removeFavorite() {}}),
};

export const gi = {Clutter, GLib, Gio, Shell};
globalThis.global = makeStub('global');

/** An in-memory stand-in for the extension's Gio.Settings. */
export class FakeSettings {
    constructor(values = {}) {
        this.values = new Map(Object.entries(values));
        this.handlers = [];
        this.settings_schema = {has_key: k => this.values.has(k)};
        this.writes = [];
    }
    _get(k) { return this.values.get(k); }
    get_boolean(k) { return this._get(k); }
    get_string(k) { return this._get(k); }
    get_double(k) { return this._get(k); }
    get_int(k) { return this._get(k); }
    get_strv(k) { return [...(this._get(k) ?? [])]; }
    set_string(k, v) { this._set(k, v); }
    set_strv(k, v) { this._set(k, [...v]); }
    _set(k, v) { this.values.set(k, v); this.writes.push(k); for (const h of this.handlers) h(this, k); }
    connect(sig, fn) { if (sig === 'changed') this.handlers.push(fn); return this.handlers.length; }
    disconnect() {}
}
