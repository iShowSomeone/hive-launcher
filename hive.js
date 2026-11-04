// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Hive overlay: lattice, fisheye, panning, search, keyboard, context menu and lifecycle management.
//
// Safety design (this overlay holds a modal grab while open, so a bug must never leave it stuck):
//   * every signal handler / frame callback is wrapped in `_safe()`; any exception closes the Hive
//     immediately (releasing the grab) instead of leaving the shell with an invisible modal actor
//   * a watchdog timeout finishes the close animation even if the frame clock stalls
//   * every connection, timeout and actor is tracked and released in destroy() (called from disable())

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {
    SHAPES, LAYOUTS, LOGO_STYLES, LABEL_MODES, THEMES, TILE_STYLES, HOVER_EFFECTS, BORDER_STYLES,
    BORDER_MODES, RUNNING_STYLES, OPEN_ANIMS, AMBIENT_ANIMS, SEARCH_POSITIONS, HOVER_STYLES, CHROME_STYLES,
    LIGHT_MODES, WIDGETS, FOLDER_MODES, ICON_TINTS, CENTER_STYLES, LABEL_FONTS, LABEL_CASES, BACKDROP_PATTERNS, SEARCH_STYLES,
    SEARCH_PROMPTS,
} from './options.js';
import {nearestTo, stepFrom, leapFrom, cycle, LEAP_STEPS, PAGE_STEPS} from './keynav.js';
import {groupByCategory, groupByDefinitions, groupOf} from './grouping.js';
import * as LY from './layout.js';
import {PerfLog, trimLog} from './perf.js';
import {parsePressure, parseLoadavg, parseCpuInfo, OpenHistory, decideTier, applyTier, livePause, LIVE_CHECK_MS} from './governor.js';
import {Dwell, dropTarget, onTile, onSlot, dwellProgress} from './dragdrop.js';
import {
    G, configure, buildSpiral, cellRing, lat, shapeHit, drawCell, drawVignette,
    clamp, clamp01, easeOutBack, rgba, hexToRgb, LABEL_H, MAX_RINGS, DEFAULT_LIGHT, lightAngleIndex,
    shapeShaderParams, mix,
} from './shapes.js';
import {GlassAtlas, EmptyTexture} from './glass.js';
import {createTintEffect} from './tint.js';
import {WidgetData} from './widgets.js';
import {createRefractEffect, refractionSupported, captureStage} from './refraction.js';

const LOG = '[hive-launcher]';
const BAR_OFFSET = 34;     // lattice centre sits this much below the screen centre
const BAR_MARGIN = 52;     // search bar distance from the top edge (clears the top panel)
const DRAG_THRESHOLD = 6;  // px before a press becomes a pan instead of a click
const EDGE_PAN = 80;       // px from the screen edge where dragging a tile starts to pan the Hive
const BTN_LEFT = 1;
const BTN_MIDDLE = 2;
const BTN_RIGHT = 3;
const DANGER = [0.97, 0.46, 0.56];
const RECENT_MAX = 64;      // apps remembered for the "Recently opened" order
const KBD_SLACK = 8;        // px the pointer must travel before it takes the highlight back from the keyboard
const HINT_SHORT = 'Drag or arrow keys to pan  ·  Right-click or Menu key for options  ·  Type to search  ·  F1 keys  ·  F3 folders  ·  Esc to close';
const HINT_EDIT = 'Editing layout  ·  drag a tile to swap  ·  hold or Shift+drop = folder  ·  Space picks up (keyboard)  ·  right-click: options  ·  Ctrl+Z undo  ·  Esc done';
const HINT_CUSTOM = 'Right-click a tile: move to a folder, rename, delete  ·  Ctrl+Z undo  ·  Type to search  ·  F1 keys  ·  F3 folders  ·  Esc to close';
const HINT_KEYS = [
    'Arrows move  ·  Ctrl+Arrows leap  ·  PgUp/PgDn page  ·  Home/End first/last  ·  Tab next',
    'Enter open  ·  Shift+Enter new window  ·  Ctrl+Enter or Menu key: app menu  ·  Alt+Enter details',
    'F2 centre widget  ·  F3 folders on/off  ·  Backspace or Esc leave a folder  ·  Ctrl+Z / Ctrl+Shift+Z undo / redo (custom layout)',
    'F4 edit layout  ·  Space pick up a tile  ·  Enter swap / Shift+Enter make folder  ·  Ctrl+R rename folder  ·  Delete folder  ·  Backspace take out of folder',
    'F1 close this help',
].join('\n');

/** Elastic ease-out (springy overshoot), used by the 'spring' opening animation. */
const easeOutElastic = t => {
    if (t <= 0)
        return 0;
    if (t >= 1)
        return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
};

// ============================================================================ frame driver
/**
 * Calls `callback` once per frame while running. The callback returns true to keep going and false
 * to stop (it can be restarted with start()). Uses a Clutter.Timeline (vsync-aligned); if that cannot
 * be created on this Shell version it degrades to a ~60 Hz GLib timeout.
 */
class FrameDriver {
    constructor(actor, callback) {
        this._cb = callback;
        this._running = false;
        this._inCallback = false;
        this._source = 0;
        this._timeline = null;
        this._timelineId = 0;
        try {
            this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
            this._timelineId = this._timeline.connect('new-frame', () => this._step());
        } catch (e) {
            console.warn(`${LOG} Clutter.Timeline unavailable, using timeout fallback: ${e}`);
            this._timeline = null;
        }
    }

    get running() {
        return this._running;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        if (this._timeline) {
            this._timeline.start();
        } else if (!this._source) {
            this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (!this._running) {
                    this._source = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._step();
                if (!this._running) {
                    this._source = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        if (this._timeline)
            this._timeline.stop();
        // the fallback source removes itself on its next fire
    }

    _step() {
        let again = false;
        this._inCallback = true;
        try {
            again = this._cb();
        } catch (e) {
            console.error(`${LOG} frame callback failed: ${e}\n${e.stack ?? ''}`);
        }
        this._inCallback = false;
        if (!again)
            this.stop();
    }

    destroy() {
        this._running = false;
        if (this._timeline) {
            try {
                this._timeline.stop();
                if (this._timelineId)
                    this._timeline.disconnect(this._timelineId);
            } catch (_e) { /* already gone */ }
            this._timeline = null;
            this._timelineId = 0;
        }
        // If we are inside the fallback callback it removes itself (running === false).
        if (this._source && !this._inCallback) {
            GLib.source_remove(this._source);
            this._source = 0;
        }
        this._cb = () => false;
    }
}

// ============================================================================ the Hive overlay
export class HiveOverlay {
    /** @param {Gio.Settings|null} settings */
    constructor(settings) {
        this._settings = settings;
        this._destroyed = false;

        // connection bookkeeping: `_conns` live as long as the overlay, `_openConns` only while shown
        this._conns = [];
        this._openConns = [];

        // lattice state
        this._cells = [];
        this._appCells = [];
        this._tiles = [];            // app + folder tiles (everything that carries an icon and a caption)
        this._byId = new Map();
        this._spiral = [];
        this._KD = 1;
        this._sig = '';
        this._entries = [];

        // view state
        this._query = '';
        this._results = [];
        this._pan = {x: 0, y: 0};
        this._panT = {x: 0, y: 0};
        this._dragging = false;
        this._press = null;
        this._appear = 0;
        this._appearT = 0;
        this._open = false;
        this._closing = false;
        this._hovered = null;
        this._order = [];            // visible tiles in reading order (Home / End / Tab)
        this._folder = null;         // id of the open folder tile, if any
        this._folderCells = new Map();
        this._grouped = false;       // folder tiles in use (positions are then assigned dynamically)
        this._help = false;          // F1 key cheat-sheet showing
        this._flashText = '';        // short status message shown in the footer (e.g. "Folders: By category")
        this._flashSource = 0;
        this._kbdLock = null;        // keeps a resting pointer from stealing the keyboard highlight
        this._mouse = null;          // last real pointer position (overlay coordinates)
        this._idle = 0;
        this._last = 0;
        this._R0 = 330;
        this._maxPan = 1;
        this._W = 1;
        this._H = 1;
        this._mon = null;
        this._grab = null;
        this._suppressText = false;
        this._hidden = new Set();

        // custom layout (group-mode 'custom'): fixed slots, see layout.js
        this._custom = false;        // the lattice currently shows the user's own arrangement
        this._layout = null;         // the working layout object (immutable; replaced on every edit)
        this._layoutRaw = null;      // the JSON text it was loaded from / last written as
        this._layoutDirty = false;   // reconcile changed it in memory; written with the next edit (or on close)
        this._layoutProtect = false; // the stored text was unreadable / too new: never overwrite it until the user edits
        this._undo = new LY.UndoStack();
        this._selfWrite = 0;         // > 0 while WE write custom-layout (the settings handler must not rebuild for it)
        this._envCache = null;
        this._autoMode = 'none';     // the last non-custom folder mode (what a first snapshot copies)
        this._prompt = null;         // {title, onCommit}: the search field is asking for a folder name
        this._edit = {active: false, grabbed: null, drag: null}; // Edit Hive: edit mode flag, keyboard-carried tile, mouse drag
        this._dwell = new Dwell();   // how long the dragged tile has hovered over the same app
        this._selfPolicy = 0;        // > 0 while WE write custom-policy
        this._pendingEdit = false;   // open() was asked to start in edit mode (Preferences -> Edit layout)
        this._perf = null;           // PerfLog while the "perf-log" setting is on and the Hive is open (see perf.js)
        // retained scene: the cells stay built while the Hive is closed, and work is skipped unless something changed
        this._optsDirty = true;      // a setting changed since the options were last applied
        this._optsSig = '';          // JSON of the options last applied (identical options = nothing to redo)
        this._cellsStale = false;    // options changed in a way that needs the existing cell drawings repainted
        this._themeSig = '';         // what the chrome (backdrop, search bar, hint, pattern) was last styled for
        this._prewarmSource = 0;     // pending background build (GLib source id)
        this._prewarmed = false;
        // load governor
        this._tier = 'full';
        this._tierReason = '';
        this._openHist = new OpenHistory();
        this._gpuPath = undefined;   // sysfs gpu_busy_percent file (undefined = not probed yet, null = none)
        this._threads = 0;
        this._cpuModel = '';
        this._ambientPaused = false; // pressure while open: ambient motion and the widget timer are paused
        this._liveSource = 0;
        this._openT0 = 0;
        this._firstFramePending = false;
        this._pf = {draws: 0, drawMs: 0, repaints: 0, procTimer: 0};
        this.envInfo = {};           // filled in by extension.js (shell version ...), only used in the perf report

        // timeouts
        this._snapSource = 0;
        this._closeWatchdog = 0;

        // menu + backdrop blur
        this._menuCard = null;
        this._blur = null;

        // options (re-read every time the Hive opens)
        this._opts = null;
        this._optsSig = '';
        this._animate = true;
        this._launchCell = null;
        this._barShift = BAR_OFFSET;
        this._canvasScale = 1;
        this._menuItems = [];
        this._menuPress = null;
        this._ptr = null;          // pointer position in overlay coordinates (tilt / glass lighting)
        this._pressedCell = null;

        // liquid glass: cached glass images, and the desktop snapshot used for refraction
        this._atlas = new GlassAtlas();
        this._empties = new EmptyTexture();
        this._widgets = new WidgetData();   // centre-tile widget data
        this._widgetTimer = 0;
        this._clock24 = true;
        this._lensApplied = 1;              // current lens strength factor (the 'materialize' opening animates it)
        this._refractOk = null;      // shader support, probed lazily
        this._useRefraction = false;
        this._snapContent = null;
        this._opening = false;       // waiting for the desktop snapshot
        this._openToken = 0;
        this._captureTimer = 0;

        this._buildActors();
        this._loadHidden();
        const mode0 = this._getString('group-mode', 'none');
        this._autoMode = mode0 === 'custom' ? 'none' : mode0;

        if (this._settings)
            this._connect(this._conns, this._settings, 'changed', this._safe((_s, key) => this._onSettingsChanged(key)));
        // the app list is tracked all the time (not only while the Hive is open): the scene is rebuilt in the background,
        // so the next open has nothing to do
        try {
            this._connect(this._conns, Shell.AppSystem.get_default(), 'installed-changed', this._safe(() => this._onInstalledChanged()));
        } catch (e) {
            console.warn(`${LOG} cannot track installed apps: ${e}`);
        }
        // anything started anywhere in the session counts as "recently opened"
        try {
            this._connect(this._conns, Shell.AppSystem.get_default(), 'app-state-changed', this._safe((_s, app) => {
                if (app.state === Shell.AppState.STARTING)
                    this._noteRecent(app.get_id());
            }));
        } catch (e) {
            console.warn(`${LOG} cannot track started apps: ${e}`);
        }
    }

    // ------------------------------------------------------------------ small helpers
    _connect(list, obj, signal, fn) {
        list.push([obj, obj.connect(signal, fn)]);
    }

    _disconnectAll(list) {
        for (const [obj, id] of list.splice(0)) {
            try {
                obj.disconnect(id);
            } catch (_e) { /* object already destroyed */ }
        }
    }

    /**
     * Wrap a handler so an exception can never leave the shell stuck behind a modal grab:
     * the error is logged and the Hive is closed on the spot.
     */
    _safe(fn, fallback = Clutter.EVENT_PROPAGATE) {
        return (...args) => {
            if (this._destroyed)
                return fallback;
            try {
                return fn(...args);
            } catch (e) {
                console.error(`${LOG} handler failed: ${e}\n${e.stack ?? ''}`);
                this._emergencyClose();
                return fallback;
            }
        };
    }

    _emergencyClose() {
        try {
            this.close(true);
        } catch (e) {
            console.error(`${LOG} emergency close failed: ${e}`);
        }
    }

    _hasKey(key) {
        try {
            return !!this._settings?.settings_schema?.has_key(key);
        } catch (_e) {
            return false;
        }
    }

    _getBool(key, fb) {
        return this._hasKey(key) ? this._settings.get_boolean(key) : fb;
    }

    _getString(key, fb) {
        return this._hasKey(key) ? this._settings.get_string(key) : fb;
    }

    _getDouble(key, fb) {
        return this._hasKey(key) ? this._settings.get_double(key) : fb;
    }

    // ------------------------------------------------------------------ performance log (see perf.js)
    /** Queue a repaint of a tile's drawing area (counted for the perf log). */
    _rp(area, why = 'other') {
        if (!area)
            return;
        area.queue_repaint();
        if (this._perf) {
            this._pf.repaints++;
            this._perf.reason(why);
        }
    }

    /** Run `fn`, adding its duration to the perf log under `name` (a plain call when the log is off). */
    _timed(name, fn) {
        const p = this._perf;
        if (!p)
            return fn();
        const t = GLib.get_monotonic_time();
        try {
            return fn();
        } finally {
            p.phase(name, (GLib.get_monotonic_time() - t) / 1000);
        }
    }

    _procSample() {
        try {
            const dec = new TextDecoder();
            const statm = dec.decode(GLib.file_get_contents('/proc/self/statm')[1]).split(' ');
            const stat = dec.decode(GLib.file_get_contents('/proc/self/stat')[1]);
            const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            return {rssKb: Number(statm[1]) * 4, cpuMs: (Number(rest[11]) + Number(rest[12])) * 10};
        } catch (_e) {
            return null; // not Linux / no /proc: the report simply has no process line
        }
    }

    _perfSample() {
        const sample = this._procSample();
        if (sample)
            this._perf?.proc(sample);
    }

    _perfBegin() {
        this._perfEnd(); // a previous session that never closed cleanly
        if (!this._getBool('perf-log', false)) {
            this._perf = null;
            return;
        }
        this._perf ??= new PerfLog(() => GLib.get_monotonic_time() / 1000);
        let when = '';
        try {
            const w = GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M:%S');
            when = typeof w === 'string' ? w : '';
        } catch (_e) { /* cosmetic */ }
        let scale = 1;
        try {
            const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            scale = typeof sf === 'number' ? sf : 1;
        } catch (_e) { /* cosmetic */ }
        const sess = GLib.getenv('XDG_SESSION_TYPE');
        this._perf.begin({
            when, hive: this.envInfo.version ?? '?', shell: this.envInfo.shellVersion ?? '?', session: typeof sess === 'string' ? sess : '?',
            monitor: `${this._W}x${this._H}@${scale}x`,
        }, {});
        this._perfOpenT0 = this._openT0 || GLib.get_monotonic_time(); // open() started before the session could be created
        this._perfSample();
        this._pf = {draws: 0, drawMs: 0, repaints: 0, procTimer: 0};
        this._pf.procTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._perfSample();
            return this._perf ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    /** Fill in the settings summary once the options of this open are known (they are applied after the session starts). */
    _perfDescribe() {
        const p = this._perf;
        if (!p?.active || !this._opts)
            return;
        const o = this._opts;
        p.describe({
            shape: o.shape, layout: o.layout, style: o.tileStyle, chrome: o.chromeStyle, refraction: o.refraction, blur: this._getBool('blur', true),
            blurPx: this._getDouble('blur-strength', 30), anim: !!this._animate, open: o.openAnim, ambient: o.ambient, labels: o.labels, empty: o.decor,
            groups: this._getString('group-mode', 'none'), sort: this._getString('sort-mode', 'frequency'), widget: G.WIDGET, size: o.tileSize, shadow: o.tileShadow,
            tint: o.iconTint, pattern: o.pattern, centre: o.centerStyle, tier: o.tier ?? this._tier, prewarm: this._getBool('prewarm-scene', true),
        });
        if (!this._cpuModel) {
            try {
                const info = parseCpuInfo(new TextDecoder().decode(GLib.file_get_contents('/proc/cpuinfo')[1]));
                this._cpuModel = info.model;
                this._threads = info.threads || this._threads;
            } catch (_e) { /* no /proc/cpuinfo */ }
        }
        p.sys({cpu: this._cpuModel || '?', threads: this._threads || '?', tier: this._tier, tierReason: this._tierReason, prewarmed: this._prewarmed});
        p.pressure(this._pressureSample(), 'open');
    }

    /** Describe the scene (called after every rebuild): how much there is to draw. */
    _perfScene() {
        const p = this._perf;
        if (!p)
            return;
        let actors = 0;
        try {
            const n = this._canvas.get_n_children();
            actors = typeof n === 'number' ? n : 0;
        } catch (_e) { /* cosmetic */ }
        p.scene({apps: this._appCells.length, folders: this._folderCells.size, custom: this._custom, edit: this._edit.active, layout: G.LAYOUT});
        p.gauge('cells', this._cells.length);
        p.gauge('canvasChildren', actors);
        p.gauge('emptyCells', this._cells.filter(c => c.kind === 'empty').length);
    }

    /** Where the report goes (overridable in tests). */
    _perfWrite(text) {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'hive-launcher']);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, 'perf.log']);
        let old = '';
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (ok)
                old = new TextDecoder().decode(bytes);
        } catch (_e) { /* first report */ }
        GLib.file_set_contents(path, trimLog(old + text));
        return path;
    }

    _perfEnd() {
        const p = this._perf;
        if (!p || !p.active)
            return;
        if (this._pf.procTimer) {
            GLib.source_remove(this._pf.procTimer);
            this._pf.procTimer = 0;
        }
        this._perfSample();
        const text = p.end();
        if (!text)
            return;
        try {
            const path = this._perfWrite(text);
            console.log(`${LOG} performance report appended to ${path}`);
        } catch (e) {
            console.warn(`${LOG} could not write the performance log: ${e}`);
        }
    }

    // ------------------------------------------------------------------ load governor (see governor.js)
    _readText(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(bytes) : '';
        } catch (_e) {
            return ''; // not Linux, no PSI in this kernel, no permission: the governor then simply sees "no pressure"
        }
    }

    /** GPU busy percentage (amdgpu exposes it; anything else = -1). The sysfs path is probed once. */
    _gpuBusy() {
        if (this._gpuPath === undefined) {
            this._gpuPath = null;
            for (let i = 0; i < 4 && !this._gpuPath; i++) {
                const path = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
                if (GLib.file_test(path, GLib.FileTest.EXISTS))
                    this._gpuPath = path;
            }
        }
        if (!this._gpuPath)
            return -1;
        const v = Number(this._readText(this._gpuPath).trim());
        return Number.isFinite(v) ? v : -1;
    }

    /** One reading of everything the governor and the perf log need (all procfs / sysfs: memory-backed, no disk). */
    _pressureSample() {
        const cpu = parsePressure(this._readText('/proc/pressure/cpu'));
        const io = parsePressure(this._readText('/proc/pressure/io'));
        const mem = parsePressure(this._readText('/proc/pressure/memory'));
        const load = parseLoadavg(this._readText('/proc/loadavg'));
        return {cpu: cpu.some.avg10, io: io.some.avg10, mem: mem.some.avg10, load: load.l1, gpu: this._gpuBusy(), psi: {cpu, io, mem}, loadAvg: load};
    }

    /** Pick the quality tier for this open. Returns true when it differs from the last one. */
    _chooseTier() {
        const prev = this._tier;
        const mode = this._getString('perf-tier', 'auto');
        let r;
        if (mode !== 'auto') {
            r = decideTier({mode});
        } else {
            const t0 = GLib.get_monotonic_time();
            const smp = this._pressureSample();
            this._perf?.phase('pressureSample', (GLib.get_monotonic_time() - t0) / 1000);
            if (!this._threads)
                this._threads = GLib.get_num_processors();
            r = decideTier({mode, psi: smp.psi, gpuBusy: smp.gpu, load: smp.loadAvg, threads: this._threads, history: this._openHist, prev});
        }
        this._tier = r.tier;
        this._tierReason = r.reason;
        if (r.tier !== prev) {
            this._optsDirty = true; // the tier is part of the applied options
            this._perf?.count('tierChanges');
        }
        return r.tier !== prev;
    }

    /** While open (auto tier): pause ambient motion and the widget timer when the machine gets busy; resume when it calms down. */
    _liveCheck() {
        if (!this._open || this._getString('perf-tier', 'auto') !== 'auto')
            return GLib.SOURCE_CONTINUE;
        const smp = this._pressureSample();
        this._perf?.pressure(smp, 'live');
        const pause = livePause(smp.psi, smp.gpu);
        if (pause !== this._ambientPaused) {
            this._ambientPaused = pause;
            this._perf?.note(pause ? 'machine busy: ambient motion and widget timer paused' : 'machine calm again: ambient motion resumed');
            if (pause)
                this._stopWidgetTimer();
            else
                this._startWidgetTimer();
            this._wake();
        }
        return GLib.SOURCE_CONTINUE;
    }

    // ------------------------------------------------------------------ retained scene: background build
    _onInstalledChanged() {
        if (this._open)
            this._refresh(false);
        else
            this._schedulePrewarm();
    }

    /** Build (or rebuild) the scene in the background so that the next open() only has to show it. Debounced. */
    _schedulePrewarm(delayMs = 1200) {
        if (this._destroyed || !this._getBool('prewarm-scene', true))
            return;
        if (this._prewarmSource)
            GLib.source_remove(this._prewarmSource);
        this._prewarmSource = GLib.timeout_add(GLib.PRIORITY_LOW, delayMs, () => {
            this._prewarmSource = 0;
            this._safe(() => this.prewarm())();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Public: called once after enable (extension.js) and from the debounce above. Never runs while the Hive is on screen. */
    prewarm() {
        if (this._destroyed || this._open || this._opening || this._closing || this._root.visible)
            return false;
        if (!this._getBool('prewarm-scene', true))
            return false;
        const t0 = GLib.get_monotonic_time();
        this._loadHidden();
        const mon = Main.layoutManager.primaryMonitor;
        if (mon && !this._mon) { // sizes for code that runs before the first real open (the real monitor is taken at open)
            this._W = mon.width;
            this._H = mon.height;
        }
        if (this._chooseTier() || this._optsDirty)
            this._applyOptions();
        const rebuilt = this._rebuild();
        this._applyTheme();
        if (this._cellsStale) {
            this._repaintAll('options');
            this._cellsStale = false;
        }
        this._preloadIcons();
        this._prewarmed = true;
        return true;
    }

    /** Make the St.Icons resolve their textures now (hidden actors would otherwise do it at the first show). */
    _preloadIcons() {
        for (const c of this._tiles) {
            try {
                c.icon?.ensure_style?.();
            } catch (_e) { /* an icon that cannot be preloaded just loads at open like before */ }
        }
    }

    _repaintAll(why) {
        for (const c of this._cells)
            this._rp(c.area, why);
    }

    _getInt(key, fb) {
        return this._hasKey(key) ? this._settings.get_int(key) : fb;
    }

    _loadHidden() {
        this._hidden = new Set(this._hasKey('hidden-apps') ? this._settings.get_strv('hidden-apps') : this._hidden);
    }

    _saveHidden() {
        if (this._hasKey('hidden-apps'))
            this._settings.set_strv('hidden-apps', [...this._hidden]);
    }

    _onSettingsChanged(key) {
        if (key === 'recent-apps' || key === 'perf-log')
            return; // bookkeeping written by us on every launch / read at open: must not rebuild the Hive
        if ((key === 'custom-layout' && this._selfWrite > 0) || (key === 'custom-policy' && this._selfPolicy > 0))
            return; // our own write: the view already shows it
        if (key === 'group-mode') {
            const m = this._getString('group-mode', 'none');
            if (m !== 'custom')
                this._autoMode = m;
        }
        if (key === 'custom-layout') { // edited elsewhere (Preferences reset, profile import): load it afresh
            this._layout = null;
            this._undo.clear();
        }
        if (this._prompt && this._open)
            this._cancelPrompt();
        this._optsDirty = true;
        this._loadHidden();
        if (!this._open) {
            this._schedulePrewarm(); // rebuild in the background: the next open then finds everything ready
            return;
        }
        // the centre widget only changes what the centre tile shows: no rebuild (keeps pan and focus)
        this._refresh(key !== 'center-widget' && key !== 'clock-24h');
        if (key === 'group-mode')
            this._announceFolders();
    }

    /** Remember `id` as the most recently opened app. */
    _noteRecent(id) {
        if (!id || !this._hasKey('recent-apps'))
            return;
        if (this._custom && this._layout) { // a launched app is no longer "new"
            const n = LY.clearFresh(this._layout, id);
            if (n !== this._layout) {
                this._layout = n;
                this._layoutDirty = true;
            }
        }
        const cur = this._settings.get_strv('recent-apps');
        if (cur[0] === id)
            return;
        this._settings.set_strv('recent-apps', [id, ...cur.filter(x => x !== id)].slice(0, RECENT_MAX));
    }

    _setCursor(kind) {
        try {
            const C = Meta.Cursor;
            let v;
            if (kind === 'pointer')
                v = C.POINTING_HAND ?? C.POINTER;
            else if (kind === 'grab')
                v = C.DND_IN_DRAG ?? C.GRABBING;
            else
                v = C.DEFAULT;
            if (v !== undefined)
                global.display.set_cursor(v);
        } catch (_e) { /* cursor names differ between Mutter versions; purely cosmetic */ }
    }

    // ------------------------------------------------------------------ actors
    _buildActors() {
        // root: backdrop, one per extension, shown/hidden on demand
        this._root = new St.Widget({
            name: 'hive-root',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            visible: false,
        });

        // backdrop: its own actor so a blur effect can be attached without touching the children
        this._bg = new St.Widget({style_class: 'hive-backdrop', x_expand: true, y_expand: true, opacity: 0});

        // vignette / centre glow, drawn with cairo
        this._vignette = new St.DrawingArea({x_expand: true, y_expand: true, opacity: 0});
        this._vignette.connect('repaint', () => {
            try {
                drawVignette(this._vignette);
            } catch (e) {
                console.error(`${LOG} vignette failed: ${e}`);
            }
        });

        // canvas: lattice cells are positioned freely inside
        this._canvas = new St.Widget({
            style_class: 'hive-canvas',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        // search bar
        this._entry = new St.Entry({
            style_class: 'hive-search',
            hint_text: 'Search apps…',
            can_focus: true,
            track_hover: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'hive-search-icon',
        }));
        this._bar = new St.Bin({
            style_class: 'hive-search-wrap',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            child: this._entry,
        });
        this._bar.set_margin_top(BAR_MARGIN);
        this._bar.opacity = 0;

        // footer hint
        this._hint = new St.Label({
            text: HINT_SHORT,
            style_class: 'hive-hint',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            opacity: 0,
        });
        this._hint.set_margin_bottom(70);
        this._hint.clutter_text.set_line_alignment(Pango.Alignment.CENTER); // the F1 cheat-sheet has several lines

        // context-menu layer: transparent, covers everything; a click outside the card dismisses it
        this._menuLayer = new St.Widget({
            style_class: 'hive-menu-layer',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            visible: false,
            x_expand: true,
            y_expand: true,
        });

        this._root.add_child(this._bg);
        this._root.add_child(this._vignette);
        this._root.add_child(this._canvas);
        this._root.add_child(this._bar);

        // edit mode: a transparent overlay for drop rings / the ghost of a lifted tile, and the "Done" pill
        this._editLayer = new St.DrawingArea({reactive: false, visible: false, x_expand: true, y_expand: true});
        this._editLayer.connect('repaint', () => {
            try {
                this._paintEdit();
            } catch (e) {
                console.error(`${LOG} edit overlay failed: ${e}`);
            }
        });
        this._canvas.add_child(this._editLayer);
        this._donePill = new St.Button({
            label: 'Done', reactive: true, can_focus: false, visible: false,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true,
        });
        this._donePill.set_margin_top(BAR_MARGIN + 6);
        this._donePill.set_margin_right(28);
        this._donePill.connect('clicked', this._safe(() => this._leaveEdit()));
        this._root.add_child(this._donePill);
        this._root.add_child(this._hint);
        this._root.add_child(this._menuLayer);
        Main.layoutManager.modalDialogGroup.add_child(this._root);

        this._canvas.set_pivot_point(0.5, 0.5);
        this._driver = new FrameDriver(this._canvas, () => this._tick());

        // ---- input on the canvas (cells are non-reactive; hexagon-accurate hit testing is done by hand)
        this._connect(this._conns, this._canvas, 'button-press-event', this._safe((a, e) => this._onPress(e)));
        // motion + release live on the root so a drag always ends, wherever the pointer wanders
        this._connect(this._conns, this._root, 'button-release-event', this._safe((a, e) => this._onRelease(e)));
        this._connect(this._conns, this._root, 'motion-event', this._safe((a, e) => this._onMotion(e)));
        this._connect(this._conns, this._canvas, 'leave-event', this._safe(() => this._onLeave()));
        this._connect(this._conns, this._canvas, 'scroll-event', this._safe((a, e) => this._onScroll(e)));

        // ---- keyboard (events bubble from the focused actor up to the root)
        // The capture phase runs before the focused text field (and its built-in caret handling) sees the key,
        // so Left/Right/Home/End can be used for navigation. The bubble handler is only a fallback.
        this._connect(this._conns, this._root, 'captured-event', this._safe((a, e) =>
            e.type() === Clutter.EventType.KEY_PRESS ? this._onKey(e) : Clutter.EVENT_PROPAGATE));
        this._connect(this._conns, this._root, 'key-press-event', this._safe((a, e) => this._onKey(e)));

        // ---- search field focus ring (colours come from the active theme, so they are applied inline)
        this._connect(this._conns, this._entry.clutter_text, 'key-focus-in', this._safe(() => this._styleEntry(true)));
        this._connect(this._conns, this._entry.clutter_text, 'key-focus-out', this._safe(() => this._styleEntry(false)));

        // ---- search
        this._connect(this._conns, this._entry.clutter_text, 'text-changed', this._safe(() => {
            if (this._suppressText || this._prompt)
                return;
            this._query = this._entry.get_text().trim();
            this._applyLayout();
        }));
        this._connect(this._conns, this._entry.clutter_text, 'activate', this._safe(() => {
            if (this._menuCard)
                return;
            if (this._prompt) {
                this._commitPrompt();
                return;
            }
            const c = this._focused();
            if (c)
                this._activateCell(c);
        }));

        // ---- any press outside the open menu dismisses it. Handled in the capture phase on the root so it
        // does not depend on picking or on which actor Clutter reports as the event source.
        this._connect(this._conns, this._root, 'captured-event', this._safe((a, e) => this._onCaptured(e)));

        // ---- menu layer: clicks that land on the layer itself (not on the card) dismiss the menu
        this._connect(this._conns, this._menuLayer, 'button-press-event', this._safe((a, e) => {
            if (e.get_source() === this._menuLayer) {
                this._closeMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
    }

    // ------------------------------------------------------------------ options + theme
    _choice(key, list, fb) {
        const v = this._getString(key, fb);
        return list.some(([id]) => id === v) ? v : fb;
    }

    /** Name of GNOME's system accent colour ('blue', 'teal', …) or '' when unavailable (GNOME < 47). */
    _systemAccentName() {
        try {
            const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.gnome.desktop.interface', true);
            if (schema?.has_key('accent-color'))
                return new Gio.Settings({settings_schema: schema}).get_string('accent-color');
        } catch (_e) { /* not available */ }
        return '';
    }

    _readOptions() {
        const theme = this._getString('theme', 'tokyo');
        return {
            shape: this._choice('shape', SHAPES, 'hexagon'),
            layout: this._choice('layout', LAYOUTS, 'honeycomb'),
            logo: this._choice('logo-style', LOGO_STYLES, 'ring'),
            labels: this._choice('labels', LABEL_MODES, 'auto'),
            theme: THEMES[theme] ? theme : 'tokyo',
            accent: this._getString('accent-color', ''),
            systemAccent: this._getBool('use-system-accent', false) ? this._systemAccentName() : '',
            tileSize: clamp(this._getDouble('tile-size', 1), 0.6, 1.5),
            gap: clamp(this._getDouble('tile-gap', 5), 0, 20),
            iconScale: clamp(this._getDouble('icon-scale', 1), 0.6, 1.5),
            minScale: clamp(this._getDouble('min-scale', 0.3), 0.12, 1),
            zoom: clamp(this._getDouble('zoom', 1), 0.5, 1.8),
            decor: this._getBool('show-empty', true),
            edit: { // Edit Hive tuning (Preferences -> Layout editing)
                wobble: clamp(this._getDouble('edit-wobble', 1.3), 0, 3),
                wobbleSpeed: clamp(this._getDouble('edit-wobble-speed', 1), 0.4, 2.5),
                dwellMs: clamp(this._getInt('edit-dwell-ms', 400), 150, 1500),
                longPressMs: clamp(this._getInt('edit-long-press-ms', 350), 150, 1200),
                liftDistance: clamp(this._getDouble('edit-lift-distance', 6), 2, 30),
                hit: clamp(this._getDouble('edit-hit-radius', 0.55), 0.3, 1),
                autopan: clamp(this._getDouble('edit-autopan', 1), 0, 3),
                liftScale: clamp(this._getDouble('edit-lift-scale', 1.1), 1, 1.5),
                liftOpacity: clamp(this._getDouble('edit-lift-opacity', 0.88), 0.3, 1),
                freeRings: clamp(this._getInt('edit-free-rings', 2), 0, 4),
                keepEmpty: this._getBool('edit-keep-empty', false),
                askName: this._getBool('edit-ask-name', true),
            },
            hints: this._getBool('show-hints', true),
            backdropOpacity: clamp(this._getDouble('backdrop-opacity', 0.62), 0.2, 1),
            animations: this._getBool('animations', true),
            // tile look
            tileStyle: this._choice('tile-style', TILE_STYLES, 'gradient'),
            tileOpacity: clamp(this._getDouble('tile-opacity', 0.85), 0.05, 1),
            tileColor: this._getString('tile-color', ''),
            sheen: this._getBool('tile-sheen', true),
            hoverEffect: this._choice('hover-effect', HOVER_EFFECTS, 'glow'),
            hoverScale: clamp(this._getDouble('hover-scale', 1.16), 1, 1.4),
            corner: clamp(this._getDouble('corner-roundness', 0.42), 0.05, 1),
            runningStyle: this._choice('running-style', RUNNING_STYLES, 'both'),
            // border
            borderWidth: clamp(this._getDouble('border-width', 1.3), 0, 6),
            borderStyle: this._choice('border-style', BORDER_STYLES, 'solid'),
            borderMode: this._choice('border-mode', BORDER_MODES, 'accent'),
            borderColor: this._getString('border-color', ''),
            borderOpacity: clamp(this._getDouble('border-opacity', 0.28), 0, 1),
            labelSize: clamp(this._getDouble('label-size', 1), 0.7, 1.6),
            vignette: this._getBool('show-vignette', true),
            // animation
            openAnim: this._choice('open-animation', OPEN_ANIMS, 'pop'),
            ambient: this._choice('ambient-animation', AMBIENT_ANIMS, 'none'),
            launchAnim: this._getBool('launch-animation', true),
            menuAnim: this._getBool('menu-animation', true),
            // interaction + layout chrome
            inertia: clamp(this._getDouble('inertia', 1), 0, 2),
            scrollSpeed: clamp(this._getDouble('scroll-speed', 1), 0.3, 3),
            middleNew: this._getBool('middle-click-new-window', true),
            backdropColor: this._getString('backdrop-color', ''),
            searchWidth: clamp(this._getDouble('search-width', 380), 240, 640),
            searchPos: this._choice('search-position', SEARCH_POSITIONS, 'top'),
            // glass + motion
            hoverStyle: this._choice('hover-style', HOVER_STYLES, 'grow'),
            pressFeedback: this._getBool('press-feedback', true),
            tileShadow: clamp(this._getDouble('tile-shadow', 0), 0, 1),
            glassLight: this._choice('glass-light', LIGHT_MODES, 'fixed'),
            chromeStyle: this._choice('chrome-style', CHROME_STYLES, 'solid'),
            animSpeed: clamp(this._getDouble('animation-speed', 1), 0.4, 2.5),
            // liquid-glass refraction
            refraction: this._getBool('glass-refraction', false),
            refStrength: clamp(this._getDouble('refraction-strength', 12), 0, 30),
            refFrost: clamp(this._getDouble('refraction-frost', 3), 0, 12),
            refChroma: clamp(this._getDouble('refraction-chroma', 1.5), 0, 6),
            refVibrance: clamp(this._getDouble('refraction-vibrance', 1.2), 0.8, 1.8),
            refEdge: clamp(this._getDouble('refraction-edge', 0.5), 0.2, 0.8),
            glassRim: clamp(this._getDouble('glass-rim', 0.35), 0, 1),
            glassGloss: clamp(this._getDouble('glass-gloss', 0.3), 0, 1),
            glassDepth: clamp(this._getDouble('glass-depth', 0.4), 0, 1),
            glassAngle: clamp(this._getDouble('glass-angle', -124), -180, 180),
            widget: this._choice('center-widget', WIDGETS, 'logo'),
            clock24: this._getBool('clock-24h', true),
            // look details
            iconTint: this._choice('icon-tint', ICON_TINTS, 'original'),
            iconTintColor: this._getString('icon-tint-color', ''),
            iconTintStrength: clamp(this._getDouble('icon-tint-strength', 1), 0, 1),
            centerStyle: this._choice('center-style', CENTER_STYLES, 'filled'),
            labelFont: this._choice('label-font', LABEL_FONTS, 'default'),
            labelCase: this._choice('label-case', LABEL_CASES, 'normal'),
            labelGlow: clamp(this._getDouble('label-glow', 0), 0, 1),
            pattern: this._choice('backdrop-pattern', BACKDROP_PATTERNS, 'none'),
            patternOpacity: clamp(this._getDouble('pattern-opacity', 0.12), 0.02, 0.6),
            patternSpacing: clamp(this._getDouble('pattern-spacing', 24), 2, 80),
            searchStyle: this._choice('search-style', SEARCH_STYLES, 'pill'),
            searchPrompt: this._choice('search-prompt', SEARCH_PROMPTS, 'none'),
        };
    }

    /** The enable_animations switch of the desktop is read every time: it has no settings signal we listen to. */
    _syncAnimate() {
        let sysAnim = true;
        try {
            sysAnim = St.Settings.get().enable_animations;
        } catch (_e) { /* property missing: assume animations are fine */ }
        this._animate = !!this._opts?.animations && sysAnim;
    }

    /**
     * Read settings, push them into the shared geometry object and restyle the chrome. Skipped entirely when no setting changed since
     * the last time (dirty flag) and, when one did, everything downstream is skipped if the resulting options are identical.
     * Returns true when the options really changed.
     */
    _applyOptions(force = false) {
        return this._timed('applyOptions', () => this._applyOptionsInner(force));
    }

    _applyOptionsInner(force) {
        if (this._getBool('use-system-accent', false))
            this._optsDirty = true; // follows the desktop's accent colour: re-read every time
        if (!force && !this._optsDirty && this._opts) {
            this._syncAnimate();
            this._perf?.count('optionsSkipped');
            return false;
        }
        this._optsDirty = false;
        const o = applyTier(this._readOptions(), this._tier);
        const osig = JSON.stringify(o);
        if (!force && this._opts && osig === this._optsSig) {
            this._opts = o;
            this._syncAnimate();
            this._perf?.count('optionsUnchanged');
            return false;
        }
        this._optsSig = osig;
        this._cellsStale = true; // existing tile drawings may be out of date
        this._opts = o;
        configure(o);
        this._R0 = 330 * o.zoom * o.tileSize;
        this._clock24 = o.clock24;
        this._syncAnimate();
        // search bar + hint sit at the top or the bottom; the lattice shifts away from the bar
        const top = o.searchPos !== 'bottom';
        this._barShift = top ? BAR_OFFSET : -BAR_OFFSET;
        this._bar.set_y_align(top ? Clutter.ActorAlign.START : Clutter.ActorAlign.END);
        this._bar.set_margin_top(top ? BAR_MARGIN : 0);
        this._bar.set_margin_bottom(top ? 0 : 96);
        this._hint.set_y_align(top ? Clutter.ActorAlign.END : Clutter.ActorAlign.START);
        this._hint.set_margin_top(top ? 0 : 70);
        this._hint.set_margin_bottom(top ? 70 : 0);
        // liquid glass: pre-render the shared glass images, decide whether the refraction shader is in play
        this._useRefraction = G.REFRACT && G.TILE_STYLE === 'liquid' && this._refractSupported();
        if (G.TILE_STYLE === 'liquid')
            this._atlas.configure(this._useRefraction, G.LIGHT_FOLLOW);
        const emptiesChanged = this._empties.configure(); // one shared texture for every decorative empty tile
        this._geomSig = [o.shape, o.layout, o.tileSize, o.gap, o.iconScale, o.logo, o.labels, o.decor,
            G.TILE_STYLE === 'liquid' && this._atlas.usable, this._useRefraction, o.iconTint, o.iconTintColor, o.iconTintStrength,
            o.iconTint === 'accent' ? G.palette.accent.join(',') : '', o.labelCase, this._empties.usable].join('|');
        this._syncBlur();
        this._applyTheme();
        this._refreshGlassIcons();
        if (emptiesChanged)
            this._refreshEmptyIcons();
        this._updateRefractUniforms();
        if (this._open)
            this._startWidgetTimer();
        return true;
    }

    /** Point every empty tile at the (possibly regenerated) shared texture. */
    _refreshEmptyIcons() {
        for (const c of this._cells) {
            if (c.kind === 'empty' && c.emptyIcon && this._empties.icon)
                c.emptyIcon.gicon = this._empties.icon;
        }
    }

    _labelStyle(fg = G.palette.fg, glow = true) {
        const o = this._opts;
        let st = `color: ${rgba(fg, 1)}; font-size: ${Math.round(9 * o.tileSize * o.labelSize * 10) / 10}pt;`;
        if (o.labelFont === 'monospace')
            st += ' font-family: monospace;';
        if (glow && o.labelGlow > 0.01)
            st += ` text-shadow: 0px 0px ${Math.round(4 + 6 * o.labelGlow)}px ${rgba(G.palette.accent, 0.35 + 0.55 * o.labelGlow)};`;
        return st;
    }

    /** Square search bar: a small radius instead of the stylesheet's pill. */
    _entryShape() {
        return this._opts?.searchStyle === 'square' ? 'border-radius: 3px; ' : '';
    }

    _styleEntry(focused) {
        const P = G.palette;
        const width = Math.round(this._opts?.searchWidth ?? 380);
        if (this._opts?.chromeStyle === 'glass') {
            // frosted-glass capsule: vertical white gradient + bright rim (the backdrop is already blurred)
            this._entry.set_style(
                `background-gradient-direction: vertical; ` +
                `background-gradient-start: rgba(255, 255, 255, ${P.dark ? 0.26 : 0.9}); ` +
                `background-gradient-end: rgba(255, 255, 255, ${P.dark ? 0.1 : 0.62}); ` +
                `color: ${rgba(P.fg, 1)}; caret-color: ${rgba(P.accent, 1)}; width: ${width}px; ` +
                `border-color: rgba(255, 255, 255, ${focused ? 0.9 : 0.5}); ${this._entryShape()}` +
                `selection-background-color: ${rgba(P.accent, 0.45)}; selected-color: ${rgba(P.fg, 1)};`);
            return;
        }
        this._entry.set_style(
            `background-color: ${rgba(P.surface, 0.93)}; color: ${rgba(P.fg, 1)}; caret-color: ${rgba(P.accent, 1)}; ` +
            `border-color: ${rgba(P.accent, focused ? 0.95 : 0.4)}; width: ${width}px; ${this._entryShape()}` +
            `selection-background-color: ${rgba(P.accent, 0.45)}; selected-color: ${rgba(P.fg, 1)};`);
    }

    /** Everything the chrome (backdrop, search bar, hint, pattern, caption style) was styled from; equal = nothing to redo. */
    _themeSignature() {
        const o = this._opts;
        return [JSON.stringify(G.palette), o.backdropColor, o.backdropOpacity, !!this._blur, o.chromeStyle, o.searchWidth, o.searchStyle,
            o.searchPrompt, o.hints, this._help, o.vignette, o.pattern, o.patternOpacity, o.patternSpacing, this._labelStyle(), G.SHAPE].join('|');
    }

    /** Restyle the chrome. A no-op when nothing it depends on changed (unless `force`). Returns true when it did the work. */
    _applyTheme(force = false) {
        return this._timed('applyTheme', () => this._applyThemeInner(force));
    }

    _applyThemeInner(force) {
        const sig = this._themeSignature();
        if (!force && sig === this._themeSig) {
            this._perf?.count('themeSkipped');
            return false;
        }
        const first = this._themeSig === '';
        this._themeSig = sig;
        const P = G.palette;
        const o = this._opts;
        const alpha = this._blur ? o.backdropOpacity : Math.max(o.backdropOpacity, 0.93);
        this._bg.set_style(`background-color: ${rgba(hexToRgb(o.backdropColor) ?? P.backdrop, alpha)};`);
        if (o.searchPrompt !== this._promptKind) { // the entry's leading glyph: magnifier or a ">" prompt
            this._promptKind = o.searchPrompt;
            try {
                this._entry.set_primary_icon(o.searchPrompt === 'chevron'
                    ? new St.Label({text: '>', style_class: 'hive-search-icon', y_align: Clutter.ActorAlign.CENTER, style: 'font-weight: bold;'})
                    : new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'hive-search-icon'}));
            } catch (e) {
                console.warn(`${LOG} could not change the search prompt: ${e}`);
            }
        }
        this._styleEntry(this._entry.clutter_text.has_key_focus());
        try {
            this._entry.get_hint_actor()?.set_style(`color: ${rgba(P.fg, 0.5)};`);
            this._entry.get_primary_icon()?.set_style(`color: ${rgba(P.fg, o.searchPrompt === 'chevron' ? 0.9 : 0.6)};`);
        } catch (_e) { /* cosmetic only */ }
        this._hint.set_style(`color: ${rgba(P.fg, 0.42)};`);
        this._donePill.set_style(`background-color: ${rgba(P.accent, 0.92)}; color: ${rgba(P.dark ? [0.05, 0.06, 0.09] : [1, 1, 1], 1)}; ` +
            'border-radius: 999px; padding: 7px 20px; font-weight: bold;');
        this._hint.visible = o.hints || this._help;
        // the vignette area also carries the backdrop pattern; it is painted once here and keeps its texture afterwards
        this._vignette.visible = o.vignette || o.pattern !== 'none';
        const style = this._labelStyle();
        for (const c of this._tiles)
            c.label?.set_style(style);
        this._vignette.queue_repaint();
        this._perf?.reason('theme-vignette');
        if (!first)
            this._repaintAll('theme'); // colours changed: every drawn tile is out of date
        return true;
    }

    // ------------------------------------------------------------------ liquid glass: atlas + refraction
    _refractSupported() {
        if (this._refractOk === null)
            this._refractOk = refractionSupported();
        return this._refractOk;
    }

    /** Shader uniforms (texture-uv units) for the current options and theme. */
    _refractUniforms(lens = 1) {
        const sp = shapeShaderParams();
        const B = G.BOX;
        const o = this._opts;
        const tint = hexToRgb(o?.backdropColor ?? '') ?? G.palette.backdrop;
        return {
            hx: sp.hx, hy: sp.hy, nExp: sp.n, aaw: 1.5 / (sp.hx * B),
            strength: G.REF_STRENGTH * lens / B, frost: G.REF_FROST / B, chroma: G.REF_CHROMA * lens / B,
            vibrance: G.REF_VIBRANCE, edge: G.REF_EDGE, glow: 0.14 * G.GLASS_GLOSS,
            tintR: tint[0], tintG: tint[1], tintB: tint[2], tintA: clamp((o?.backdropOpacity ?? 0.6) * 0.75, 0, 0.8),
        };
    }

    _updateRefractUniforms() {
        if (!this._useRefraction)
            return;
        const u = this._refractUniforms();
        this._lensApplied = 1;
        for (const c of this._tiles)
            c.refrEffect?.setUniforms(u);
    }

    /** Scale the lens bending (0 = clear pane, 1 = full lens). Used by the 'materialize' opening animation. */
    _pushLens(lens) {
        const u = this._refractUniforms(lens);
        const part = {strength: u.strength, chroma: u.chroma};
        for (const c of this._tiles)
            c.refrEffect?.setUniforms(part);
    }

    /** Point every tile at the (possibly regenerated) glass image for its light direction. */
    _refreshGlassIcons() {
        for (const c of this._tiles) {
            if (!c.glass)
                continue;
            if (!G.LIGHT_FOLLOW) {
                c.ld[0] = DEFAULT_LIGHT[0];
                c.ld[1] = DEFAULT_LIGHT[1];
            }
            const g = this._atlas.iconFor(lightAngleIndex(c.ld[0], c.ld[1]));
            if (g) {
                c.glass.gicon = g.icon;
                c.glassIdx = g.index;
            }
        }
    }

    /** Capture the desktop (Hive hidden), then present. Falls back to plain glass if the capture fails. */
    _beginCapture() {
        this._opening = true;
        const token = ++this._openToken;
        const tCapture = GLib.get_monotonic_time();
        let done = false;
        const finish = content => {
            if (done)
                return;
            done = true;
            this._perf?.phase('desktopCapture', (GLib.get_monotonic_time() - tCapture) / 1000);
            if (!content)
                this._perf?.count('captureFailed');
            if (this._captureTimer) {
                GLib.source_remove(this._captureTimer);
                this._captureTimer = 0;
            }
            if (token !== this._openToken || this._destroyed)
                return;
            this._opening = false;
            this._snapContent = content;
            this._present();
        };
        this._captureTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._captureTimer = 0;
            console.warn(`${LOG} desktop capture timed out, using plain glass`);
            finish(null);
            return GLib.SOURCE_REMOVE;
        });
        captureStage().then(content => finish(content)).catch(e => {
            console.warn(`${LOG} desktop capture failed, using plain glass: ${e}`);
            finish(null);
        });
    }

    _applySnapshot() {
        const [sw, sh] = global.stage.get_size();
        for (const c of this._tiles) {
            if (!c.snap)
                continue;
            c.snap.set_size(sw, sh);
            c.snap.set_content(this._snapContent);
            c.refr.visible = false;
            c.refrOn = false;
            c.snapX = c.snapY = c.snapS = null;
        }
    }

    _releaseSnapshot() {
        this._snapContent = null;
        for (const c of this._tiles) {
            if (!c.snap)
                continue;
            c.snap.set_content(null);
            c.refr.visible = false;
            c.refrOn = false;
        }
    }

    /**
     * Keep the snapshot registered with the screen: the tile is scaled by `s` about its centre C, so the
     * snapshot child is scaled by 1/s and placed at BOX/2 − C/s — then desktop pixel t lands exactly at t.
     */
    _updateRefraction(c, total, xoff, yoff) {
        const on = !!this._snapContent && total >= 0.45;
        if (on !== c.refrOn) {
            c.refrOn = on;
            c.refr.visible = on;
        }
        if (!on)
            return;
        c.refrEffect?.ensure?.();
        const px = Math.round((G.BOX / 2 - (this._mon.x + c.sx + xoff) / total) * 4) / 4;
        const py = Math.round((G.BOX / 2 - (this._mon.y + c.sy + yoff) / total) * 4) / 4;
        const sc = Math.round(1000 / total) / 1000;
        if (px !== c.snapX || py !== c.snapY) {
            c.snapX = px;
            c.snapY = py;
            c.snap.set_position(px, py);
        }
        if (sc !== c.snapS) {
            c.snapS = sc;
            c.snap.set_scale(sc, sc);
        }
    }

    /** Blur whatever is behind the backdrop (falls back to a more opaque tint if unavailable). */
    _syncBlur() {
        const want = this._getBool('blur', true);
        if (want && !this._blur) {
            try {
                let effect;
                try {
                    effect = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, sigma: this._getDouble('blur-strength', 30), brightness: 0.8});
                } catch (_e) {
                    effect = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
                }
                this._bg.add_effect_with_name('hive-blur', effect);
                this._blur = effect;
            } catch (e) {
                console.warn(`${LOG} blur unavailable: ${e}`);
                this._blur = null;
            }
        } else if (!want && this._blur) {
            this._bg.remove_effect(this._blur);
            this._blur = null;
        }
        if (this._blur)
            this._bg.remove_style_class_name('no-blur');
        else
            this._bg.add_style_class_name('no-blur');
    }

    _setInteractive(on) {
        this._root.set_reactive(on);
        this._canvas.set_reactive(on);
        this._entry.set_reactive(on);
    }

    // ------------------------------------------------------------------ public API
    get isOpen() {
        return this._open;
    }

    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._open || this._opening || this._destroyed)
            return;
        if (Main.sessionMode.isLocked)
            return;

        const idx = global.display.get_current_monitor();
        const mon = Main.layoutManager.monitors[idx] ?? Main.layoutManager.primaryMonitor;
        if (!mon)
            return;

        // a previous close animation may still be running: finish it instantly
        if (this._closing)
            this._finishClose();

        this._mon = mon;
        this._W = mon.width;
        this._H = mon.height;
        this._root.set_position(mon.x, mon.y);
        this._root.set_size(mon.width, mon.height);

        this._openT0 = GLib.get_monotonic_time();
        this._firstFramePending = true;
        this._perfBegin(); // first: every phase of this open is then timed
        this._timed('loadHidden', () => this._loadHidden());
        this._timed('chooseTier', () => this._chooseTier());
        this._applyOptions(); // skipped (a flag check) unless a setting or the tier changed
        this._perfDescribe();
        const rebuilt = this._rebuild();
        this._perfScene();
        this._markRunning();
        this._applyTheme(); // skipped unless the palette / chrome settings changed
        if (this._cellsStale) { // existing tile drawings are out of date only when the look options changed; new cells paint themselves
            if (!rebuilt)
                this._repaintAll('options');
            this._cellsStale = false;
        }

        this._query = '';
        this._timed('resetEntry', () => {
            this._suppressText = true;
            this._entry.set_text('');
            this._suppressText = false;
        });
        this._folder = null;
        this._kbdLock = null;
        this._mouse = null;
        this._help = false;
        this._applyLayout();
        this._updateHint();
        this._pan.x = this._pan.y = 0;
        this._timed('cellReset', () => {
            for (const c of this._cells) {
                // a tile closed while hovered / pulsing was last drawn in that state: redraw only those
                if (c.area && (c.hover !== 0 || c.pulse !== 1 || c.shineT < 1))
                    this._rp(c.area, 'reopen');
                c.lx = c.tx;
                c.ly = c.ty;
                c.vis = c.tvis;
                c.hover = c.thover = 0;
                c.shineT = 1;
                c.pulse = 1;
                if (c.actor.opacity !== 255)
                    c.actor.opacity = 255;
            }
        });
        this._rp(this._cells[0]?.area, 'clock'); // the centre tile's clock / time-of-day glyph
        this._launchCell = null;
        this._appear = this._animate ? 0 : 1;
        this._appearT = 1;
        this._closing = false;
        this._press = null;
        this._dragging = false;
        this._hovered = null;
        this._ambientPaused = false;
        this._resetEdit();

        if (this._useRefraction && this._refractSupported()) {
            this._beginCapture(); // presents when the snapshot arrives
            return;
        }
        this._snapContent = null;
        this._present();
    }

    /** Second half of open(): runs once the optional desktop snapshot is ready. */
    _present() {
        this._timed('present', () => this._presentInner());
        if (this._perf && this._perfOpenT0)
            this._perf.phase('openToPresent', (GLib.get_monotonic_time() - this._perfOpenT0) / 1000);
    }

    _presentInner() {
        if (this._open || this._destroyed)
            return;
        this._timed('present:applySnapshot', () => this._applySnapshot());
        this._setInteractive(true);
        const startOpacity = this._animate ? 0 : 255;
        this._bg.opacity = startOpacity;
        this._vignette.opacity = startOpacity;
        this._bar.opacity = startOpacity;
        this._hint.opacity = startOpacity;
        this._timed('present:rootShow', () => this._root.show());

        // take the keyboard and pointer; if the shell refuses (e.g. another grab is active) give up cleanly
        let grab = null;
        this._timed('present:pushModal', () => {
            try {
                grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
            } catch (e) {
                console.error(`${LOG} pushModal failed: ${e}`);
            }
        });
        if (!grab) {
            this._pendingEdit = false;
            this._root.hide();
            return;
        }
        this._grab = grab;
        this._open = true;

        // things that must dismiss the Hive while it is open
        this._timed('present:connect', () => {
            const sys = Shell.AppSystem.get_default();
            this._connect(this._openConns, Main.layoutManager, 'monitors-changed', this._safe(() => this.close(true)));
            this._connect(this._openConns, Main.sessionMode, 'updated', this._safe(() => {
                if (Main.sessionMode.isLocked)
                    this.close(true);
            }));
            this._connect(this._openConns, Main.overview, 'showing', this._safe(() => this.close(true)));
            this._connect(this._openConns, sys, 'app-state-changed', this._safe(() => {
                this._markRunning();
                this._wake();
            }));
        });

        if (this._useRefraction && this._snapContent && G.OPEN_ANIM === 'materialize' && this._animate)
            this._lensApplied = -1; // forces the first frame to start from a clear pane
        this._timed('present:widgetTimer', () => this._startWidgetTimer());
        this._timed('present:focus', () => this._entry.grab_key_focus());
        if (this._pendingEdit) {
            this._pendingEdit = false;
            this._enterEdit();
        }
        if (this._getString('perf-tier', 'auto') === 'auto') { // keep an eye on the load while open (only ever lowers quality)
            this._liveSource = GLib.timeout_add(GLib.PRIORITY_LOW, LIVE_CHECK_MS, () => {
                if (!this._open) {
                    this._liveSource = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return this._safe(() => this._liveCheck(), GLib.SOURCE_CONTINUE)();
            });
        }
        this._wake();
    }

    /** Open the Hive straight into edit mode (Preferences -> Edit layout). */
    openEditing() {
        if (this._open)
            this._enterEdit();
        else {
            this._pendingEdit = true;
            this.open();
        }
    }

    /** Start closing (animated), or tear down synchronously when `immediate` is true. */
    close(immediate = false) {
        if (this._open) {
            this._flushLayout();
            this._cancelPrompt();
            this._resetEdit();
            this._open = false;
            this._closeMenu();
            this._releaseGrab();
            this._disconnectAll(this._openConns);
            this._stopWidgetTimer();
            this._stopLiveCheck();
            this._removeSnapTimer();
            this._press = null;
            this._pressCell(null);
            this._ptr = null;
            this._dragging = false;
            this._hovered = null;
            this._setCursor('default');
            this._setInteractive(false);

            if (!immediate && this._animate) {
                this._closing = true;
                this._appearT = 0;
                // watchdog: never leave a half-faded overlay on screen if the frame clock stalls
                this._closeWatchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(Math.max(700, 2200 / G.ANIM_SPEED)), () => {
                    this._closeWatchdog = 0;
                    this._finishClose();
                    return GLib.SOURCE_REMOVE;
                });
                this._wake();
                return;
            }
        }
        if (immediate && (this._closing || this._root.visible))
            this._finishClose();
    }

    _stopLiveCheck() {
        if (this._liveSource) {
            GLib.source_remove(this._liveSource);
            this._liveSource = 0;
        }
        this._ambientPaused = false;
    }

    _releaseGrab() {
        if (!this._grab)
            return;
        const grab = this._grab;
        this._grab = null;
        try {
            Main.popModal(grab);
        } catch (e) {
            console.error(`${LOG} popModal failed: ${e}`);
        }
    }

    _finishClose() {
        this._closing = false;
        if (this._closeWatchdog) {
            GLib.source_remove(this._closeWatchdog);
            this._closeWatchdog = 0;
        }
        this._driver.stop();
        this._root.hide();
        this._bg.opacity = 0;
        this._vignette.opacity = 0;
        this._bar.opacity = 0;
        this._hint.opacity = 0;
        this._launchCell = null;
        this._canvasScale = 1;
        this._canvas.set_scale(1, 1);
        this._releaseSnapshot(); // free the GPU copy of the desktop
        if (this._perf?.active)
            this._perf.pressure(this._pressureSample(), 'close');
        this._perfEnd();
    }

    destroy() {
        if (this._destroyed)
            return;
        try {
            this._flushLayout();
        } catch (_e) { /* settings may already be gone */ }
        this._emergencyClose();
        this._perfEnd();
        this._destroyed = true;
        this._openToken++; // abandon a pending desktop capture
        if (this._captureTimer) {
            GLib.source_remove(this._captureTimer);
            this._captureTimer = 0;
        }
        if (this._flashSource) {
            GLib.source_remove(this._flashSource);
            this._flashSource = 0;
        }
        this._atlas.destroy();
        this._empties.destroy();
        this._widgets.destroy();
        this._stopWidgetTimer();
        this._stopLiveCheck();
        if (this._prewarmSource) {
            GLib.source_remove(this._prewarmSource);
            this._prewarmSource = 0;
        }
        this._removeSnapTimer();
        if (this._closeWatchdog) {
            GLib.source_remove(this._closeWatchdog);
            this._closeWatchdog = 0;
        }
        this._disconnectAll(this._openConns);
        this._disconnectAll(this._conns);
        this._driver.destroy();
        this._root.destroy(); // destroys canvas, cells, bar, menu layer
        this._cells = [];
        this._appCells = [];
        this._tiles = [];
        this._folderCells.clear();
        this._byId.clear();
        this._results = [];
        this._hovered = null;
        this._menuCard = null;
        this._settings = null;
    }

    // ------------------------------------------------------------------ app model
    _buildEntries() {
        const sys = Shell.AppSystem.get_default();
        const usage = Shell.AppUsage.get_default();
        const sort = this._getString('sort-mode', 'frequency');

        let infos = [];
        try {
            infos = sys.get_installed();
        } catch (_e) {
            infos = Gio.AppInfo.get_all();
        }

        const seen = new Set();
        const list = [];
        for (const info of infos) {
            let id;
            try {
                if (!info.should_show())
                    continue;
                id = info.get_id();
            } catch (_e) {
                continue;
            }
            if (!id || seen.has(id))
                continue;
            const app = sys.lookup_app(id);
            if (!app)
                continue;
            seen.add(id);
            list.push({
                id, app, name: app.get_name() ?? id, hidden: this._hidden.has(id),
                categories: info.get_categories?.() ?? '',
            });
        }

        const byName = (a, b) => a.name.localeCompare(b.name);
        const byUsage = (a, b) => {
            try {
                return usage.compare(a.id, b.id);
            } catch (_e) {
                return 0;
            }
        };

        if (sort === 'name') {
            list.sort(byName);
        } else if (sort === 'favorites') {
            const favs = AppFavorites.getAppFavorites().getFavorites().map(a => a.get_id());
            const rank = id => {
                const i = favs.indexOf(id);
                return i < 0 ? Infinity : i;
            };
            list.sort((a, b) => {
                const ra = rank(a.id);
                const rb = rank(b.id);
                if (ra !== rb)
                    return ra < rb ? -1 : 1;
                return byUsage(a, b) || byName(a, b);
            });
        } else if (sort === 'recent') {
            const recent = this._hasKey('recent-apps') ? this._settings.get_strv('recent-apps') : [];
            const rank = id => {
                const i = recent.indexOf(id);
                return i < 0 ? Infinity : i;
            };
            list.sort((a, b) => {
                const ra = rank(a.id);
                const rb = rank(b.id);
                if (ra !== rb)
                    return ra < rb ? -1 : 1;
                return byUsage(a, b) || byName(a, b); // never-opened apps keep the "most used" order
            });
        } else {
            list.sort((a, b) => byUsage(a, b) || byName(a, b));
        }
        // hidden apps stay in the list (so search can find them) but sort behind the visible ones
        return [...list.filter(e => !e.hidden), ...list.filter(e => e.hidden)];
    }

    /** GNOME's own app folders (what the shell's app grid shows), as definitions for groupByDefinitions(). */
    _readGnomeFolders() {
        const defs = [];
        const src = Gio.SettingsSchemaSource.get_default();
        if (!src?.lookup('org.gnome.desktop.app-folders', true) ||
            !src.lookup('org.gnome.desktop.app-folders.folder', true))
            return defs;
        const root = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
        for (const id of root.get_strv('folder-children')) {
            try {
                const fs = new Gio.Settings({
                    schema_id: 'org.gnome.desktop.app-folders.folder',
                    path: `/org/gnome/desktop/app-folders/folders/${id}/`,
                });
                let name = fs.get_string('name');
                if (fs.get_boolean('translate') && typeof Shell.util_get_translated_folder_name === 'function')
                    name = Shell.util_get_translated_folder_name(name) ?? name;
                name = name.replace(/^X-GNOME-/, '').replace(/\.directory$/, '');
                defs.push({
                    id, name: name || id,
                    apps: fs.get_strv('apps'),
                    categories: fs.get_strv('categories'),
                    excluded: fs.get_strv('excluded-apps'),
                });
            } catch (e) {
                console.warn(`${LOG} app folder ${id} unreadable: ${e}`);
            }
        }
        return defs;
    }

    /** Folders for the current "group apps" mode: [{id, name, ids}] (empty = flat lattice). */
    _computeFolders(entries, mode = this._getString('group-mode', 'none')) {
        try {
            if (mode === 'categories')
                return groupByCategory(entries);
            if (mode === 'gnome')
                return groupByDefinitions(entries, this._readGnomeFolders());
        } catch (e) {
            console.warn(`${LOG} grouping failed, showing a flat lattice: ${e}`);
        }
        return [];
    }

    /** (Re)build the lattice if the app list / hide list / sort order changed. Returns true when rebuilt. */
    /** Rebuild the cells when the app list / options changed. Returns true when it did. */
    _rebuild() {
        const rebuilt = this._timed('rebuild', () => this._rebuildInner());
        if (rebuilt && this._perf) {
            this._perf.count('rebuilds');
            this._perfScene();
        }
        return rebuilt;
    }

    _rebuildInner() {
        let entries = this._buildEntries();
        const custom = this._getString('group-mode', 'none') === 'custom' && this._hasKey('custom-layout');
        this._custom = custom;
        let folderDefs;
        if (custom) {
            // the layout decides everything: which apps exist on the lattice, which folders, in what order
            folderDefs = this._customState(entries);
            // hidden apps have no slot (they are parked) but stay in the list so that search can still find them
            entries = entries.filter(e => e.hidden || LY.levelOfApp(this._layout, e.id) !== null);
        } else {
            folderDefs = this._computeFolders(entries);
            if (this._edit.active)
                this._edit.active = false; // edit mode only exists on a custom layout
        }
        // a custom layout only needs empty-tile actors while they can be seen (Free policy while editing, or when the user keeps them)
        const wantEmpties = custom && ((this._edit.active && this._getString('custom-policy', 'packed') === 'free') || (this._opts.decor && this._opts.edit.keepEmpty));
        const folderSig = folderDefs.map(f => `${f.id}=${f.name}:${f.ids.join(',')}`).join(';');
        const sig = `${entries.map(e => e.id + (e.hidden ? '!' : '')).join('|')}#${this._getString('sort-mode', 'frequency')}#${this._geomSig}#${custom ? `custom:${this._getString('custom-policy', 'packed')}:${wantEmpties}:${this._layout.fresh.join(',')}:` : ''}${folderSig}`;
        if (sig === this._sig)
            return false;
        this._sig = sig;

        for (const c of this._cells)
            c.actor.destroy();
        this._cells = [];
        this._byId = new Map();
        this._folderCells = new Map();
        this._hovered = null;

        // smallest radius K that fits every app and folder tile, plus one decorative outer ring
        let K = 1;
        while (K < MAX_RINGS - 1 && buildSpiral(G.LAYOUT, K).length < entries.length + folderDefs.length + 1)
            K++;
        if (custom) // slots may sit on outer rings (Free policy): the lattice must reach the furthest one, plus the edit-mode rings
            K = Math.max(K, this._customReach() + (wantEmpties ? Math.max(2, this._opts.edit.freeRings) : 0));
        this._KD = Math.min(K + 1, MAX_RINGS);
        this._spiral = buildSpiral(G.LAYOUT, this._KD);
        // cap (only hit with ~270+ apps)
        if (!custom)
            entries = entries.slice(0, Math.max(0, this._spiral.length - 1 - folderDefs.length));
        this._entries = entries;

        const entryById = new Map(entries.map(e => [e.id, e]));
        const folderEntries = folderDefs.map(f => ({
            id: f.id, name: f.name, folder: true,
            members: f.ids.map(id => entryById.get(id)).filter(Boolean),
        })).filter(f => custom || f.members.length > 0); // custom folders may be empty
        const folderOf = groupOf(folderDefs);
        const F = folderEntries.length;
        this._grouped = F > 0;
        if (this._folder && !folderEntries.some(f => f.id === this._folder))
            this._folder = null;

        const visibleApps = entries.filter(e => !e.hidden);
        const hiddenApps = entries.filter(e => e.hidden);
        const total = this._spiral.length;
        const extraEmpty = wantEmpties ? this._customEmptyNeed(total - 1 - F - entries.length) : 0;
        this._spiral.forEach(([q, r], i) => {
            let kind = 'empty';
            let entry = null;
            if (i === 0) {
                kind = 'logo';
            } else if (i - 1 < F) {
                kind = 'folder';
                entry = folderEntries[i - 1];
            } else if (i - 1 - F < visibleApps.length) {
                kind = 'app';
                entry = visibleApps[i - 1 - F];
            } else if (i >= total - hiddenApps.length) {
                kind = 'app';
                entry = hiddenApps[i - (total - hiddenApps.length)];
            }
            if (kind === 'empty' && custom && !wantEmpties)
                return; // never shown in this state: no actor at all
            const cell = this._makeCell(kind, q, r, entry);
            this._canvas.add_child(cell.actor);
            this._cells.push(cell);
            if (kind === 'app') {
                this._byId.set(cell.entry.id, cell);
                cell.group = folderOf.get(entry.id) ?? null;
            } else if (kind === 'folder') {
                this._folderCells.set(entry.id, cell);
            }
        });
        for (let i = 0; i < extraEmpty; i++) { // custom layouts can have more free slots than the flat lattice has spare cells
            const [q, r] = this._spiral[1 + (i % Math.max(1, total - 1))];
            const cell = this._makeCell('empty', q, r, null);
            this._canvas.add_child(cell.actor);
            this._cells.push(cell);
        }
        this._canvas.set_child_above_sibling(this._editLayer, null);
        this._appCells = this._cells.filter(c => c.kind === 'app');
        this._tiles = this._cells.filter(c => c.kind === 'app' || c.kind === 'folder');
        for (const f of this._folderCells.values())
            f.members = f.entry.members.map(m => this._byId.get(m.id)).filter(Boolean);
        this._maxPan = Math.max(1, this._KD) * G.STEP * 0.92;
        return true;
    }

    _makeCell(kind, q, r, entry) {
        const BOX = G.BOX;
        const actor = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: BOX,
            height: BOX,
            reactive: false, // pointer events are handled (shape-accurately) by the canvas
            visible: false,
        });
        actor.set_pivot_point(0.5, 0.5);

        // decorative empty tiles are NOT drawn per tile: every one shows the same shared texture (no cairo, no per-actor texture)
        let area = null;
        let emptyIcon = null;
        if (kind === 'empty' && this._empties.usable) {
            emptyIcon = new St.Icon({gicon: this._empties.icon, icon_size: BOX, style_class: 'hive-glass'});
            actor.add_child(emptyIcon);
        } else {
            area = new St.DrawingArea({style_class: `hive-tile hive-tile-${kind}`, width: BOX, height: BOX});
            actor.add_child(area);
        }

        const [px, py] = lat(G.LAYOUT, q, r);
        const cell = {
            kind, q, r, entry, actor, area, emptyIcon,
            hiddenApp: !!entry?.hidden,                           // hidden apps only appear in search results
            group: null,                                          // id of the folder tile this app lives in
            members: [],                                          // (folder tiles) the app cells inside
            icon: null,
            label: null,
            labelBin: null,
            labelAlpha: -1,
            hue: ((Math.atan2(py, px) / (2 * Math.PI) + 1) % 1),  // for the rainbow border
            pulse: 1,                                             // 0..1 breathing of running tiles
            alpha: -1,                                            // last applied opening-animation alpha
            rot: 0,                                               // last applied Z rotation
            rotX: 0, rotY: 0,                                     // last applied 3D rotation (tilt / flip)
            tiltX: 0, tiltY: 0,                                   // eased tilt towards the pointer
            hvel: 0,                                              // hover spring velocity ('bounce')
            press: 0, tpress: 0,                                  // press feedback (eased)
            shineT: 1,                                            // glint sweep progress (1 = idle)
            ld: [...DEFAULT_LIGHT],                               // liquid-glass light direction
            ang01: (Math.atan2(py, px) / (2 * Math.PI) + 0.5),    // 0..1 angle for the cascade sweep
            glass: null, glassIdx: 0,                             // shared pre-rendered glass image
            refr: null, snap: null, refrEffect: null, refrOn: false, // refraction container / snapshot child
            snapX: null, snapY: null, snapS: null,
            running: false,
            ring: cellRing(G.LAYOUT, q, r),
            lx: px, ly: py, tx: px, ty: py,   // current / target lattice position
            vis: 1, tvis: 1,                  // current / target visibility (search filtering)
            hover: 0, thover: 0,
            sx: 0, sy: 0, stot: 0,            // screen position and total scale (hit testing)
            shown: false,
        };
        area?.connect('repaint', () => {
            const t0 = this._perf ? GLib.get_monotonic_time() : 0;
            try {
                drawCell(cell, area);
            } catch (e) {
                console.error(`${LOG} paint failed: ${e}`);
            }
            if (t0) { // perf log: cost of the cairo tile drawing (everything else in a frame is compositing)
                this._pf.draws++;
                this._pf.drawMs += (GLib.get_monotonic_time() - t0) / 1000;
            }
        });

        if ((kind === 'app' || kind === 'folder') && G.TILE_STYLE === 'liquid' && this._atlas.usable) {
            const g = this._atlas.iconFor(lightAngleIndex(cell.ld[0], cell.ld[1]));
            if (g) {
                cell.glass = new St.Icon({gicon: g.icon, icon_size: BOX, style_class: 'hive-glass'});
                cell.glassIdx = g.index;
                actor.insert_child_below(cell.glass, area);
                if (this._useRefraction) {
                    try {
                        // plain Clutter actors on purpose: St.Widget overrides painting and may skip `content`
                        const refr = new Clutter.Actor({
                            layout_manager: new Clutter.FixedLayout(),
                            width: BOX,
                            height: BOX,
                            clip_to_allocation: true,
                            visible: false,
                        });
                        const snap = new Clutter.Actor();
                        snap.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
                        snap.set_pivot_point(0, 0);
                        refr.add_child(snap);
                        const effect = createRefractEffect();
                        if (!effect)
                            throw new Error('no refraction effect');
                        effect.setUniforms(this._refractUniforms());
                        refr.add_effect_with_name('hive-refract', effect);
                        actor.insert_child_below(refr, cell.glass);
                        cell.refr = refr;
                        cell.snap = snap;
                        cell.refrEffect = effect;
                    } catch (e) {
                        console.warn(`${LOG} refraction layer unavailable: ${e}\n${e.stack ?? ''}`);
                    }
                }
            }
        }

        if (kind === 'logo') { // back glyph: shown while inside a folder (see _updateBackGlyph)
            const sz = Math.round(BOX * 0.36);
            cell.backGlyph = new St.Icon({
                icon_name: 'go-previous-symbolic', icon_size: sz, visible: false,
                style: 'color: rgba(255,255,255,0.92); icon-shadow: 0 1px 5px rgba(0,0,0,0.7);',
            });
            cell.backGlyph.set_position(Math.round((BOX - sz) / 2), Math.round((BOX - sz) / 2));
            actor.add_child(cell.backGlyph);
        }
        if (kind === 'app' && this._custom && this._layout?.fresh.includes(entry.id)) { // "new" dot until moved or launched
            const d = Math.max(8, Math.round(BOX * 0.075));
            cell.freshDot = new St.Widget({
                width: d, height: d,
                style: `border-radius: ${d}px; background-color: ${rgba(G.palette.accent, 0.95)}; border: 1px solid rgba(255,255,255,0.8);`,
            });
            cell.freshDot.set_position(Math.round(BOX * 0.74), Math.round(BOX * 0.16));
            actor.add_child(cell.freshDot);
        }
        if (kind === 'app' || kind === 'folder') {
            const withLabel = G.LABELS !== 'none';
            const blockH = withLabel ? G.ICON + 2 + LABEL_H : G.ICON;
            const top = Math.round((BOX - blockH) / 2);
            const icon = kind === 'folder'
                ? this._folderIcon(entry)
                : new St.Icon({gicon: entry.app.get_icon(), icon_size: G.ICON, style_class: 'hive-icon'});
            if (kind === 'app')
                this._tintIcon(icon);
            icon.set_position(Math.round((BOX - G.ICON) / 2), top);
            actor.add_child(icon);
            cell.icon = icon;
            if (withLabel) {
                const label = new St.Label({
                    text: G.LABEL_UPPER ? entry.name.toLocaleUpperCase() : entry.name,
                    style_class: 'hive-label',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                label.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
                label.set_style(this._labelStyle());
                // fixed-width bin centres the label by its natural width and ellipsizes when it is too wide
                const bin = new St.Bin({width: G.LABEL_W, height: LABEL_H, child: label});
                bin.set_position(Math.round((BOX - G.LABEL_W) / 2), top + G.ICON + 2);
                actor.add_child(bin);
                cell.label = label;
                cell.labelBin = bin;
            }
        }
        return cell;
    }

    /** Greyscale / accent / custom tint for an icon (see tint.js). Attached once at build time, never per frame. */
    _tintIcon(icon) {
        const o = this._opts;
        if (!o || o.iconTint === 'original')
            return;
        const base = o.iconTint === 'custom' ? (hexToRgb(o.iconTintColor) ?? G.palette.accent) : G.palette.accent;
        // strength 0 = plain grey, 1 = the full tint colour (the effect always works from the icon's luminance)
        const rgb = o.iconTint === 'mono' ? [1, 1, 1] : mix([1, 1, 1], base, o.iconTintStrength);
        const effect = createTintEffect(o.iconTint, rgb);
        if (effect)
            icon.add_effect_with_name('hive-tint', effect);
    }

    /** A folder tile's picture: up to four of its apps' icons in a 2x2 arrangement. */
    _folderIcon(entry) {
        const size = G.ICON;
        const box = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: size, height: size});
        const s = Math.round(size * 0.44);
        const gap = Math.round(size * 0.06);
        const off = Math.round((size - (2 * s + gap)) / 2);
        entry.members.slice(0, 4).forEach((m, i) => {
            const ic = new St.Icon({gicon: m.app.get_icon(), icon_size: s, style_class: 'hive-icon'});
            this._tintIcon(ic);
            ic.set_position(off + (i % 2) * (s + gap), off + Math.floor(i / 2) * (s + gap));
            box.add_child(ic);
        });
        return box;
    }

    _markRunning() {
        this._timed('markRunning', () => this._markRunningInner());
    }

    _markRunningInner() {
        const show = this._getBool('show-running', true);
        for (const c of this._appCells) {
            const was = c.running;
            c.running = show && c.entry.app.get_state() !== Shell.AppState.STOPPED;
            if (was !== c.running)
                this._rp(c.area);
        }
        for (const f of this._folderCells.values()) { // a folder counts as running when any of its apps is
            const was = f.running;
            f.running = show && f.members.some(m => m.running);
            if (was !== f.running)
                this._rp(f.area);
        }
    }

    /** Re-layout after the app list / settings changed while the Hive is open. */
    _refresh(force) {
        this._perf?.count('refreshes');
        this._timed('refresh', () => this._refreshInner(force));
    }

    _refreshInner(force) {
        if (force)
            this._sig = '';
        this._applyOptions();
        const rebuilt = this._rebuild();
        if (this._cellsStale) { // options changed: drawings of surviving cells are out of date (new cells paint themselves)
            if (!rebuilt)
                this._repaintAll('options');
            this._cellsStale = false;
        }
        if (!rebuilt) {
            this._applyTheme();
            this._wake();
            return;
        }
        this._markRunning();
        this._applyTheme();
        this._applyLayout();
        for (const c of this._cells) {
            c.lx = c.tx;
            c.ly = c.ty;
            c.vis = c.tvis;
        }
        this._wake();
    }

    // ------------------------------------------------------------------ search + layout
    /** Ranked list of cells matching `query`, via the shell's own app search (same ranking as the overview). */
    _searchCells(query) {
        const ids = [];
        const seen = new Set();
        const push = id => {
            if (!seen.has(id) && this._byId.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        };
        try {
            const usage = Shell.AppUsage.get_default();
            for (const group of Shell.AppSystem.search(query)) {
                const g = [...group];
                try {
                    g.sort((a, b) => usage.compare(a, b));
                } catch (_e) { /* keep search order */ }
                g.forEach(push);
            }
        } catch (_e) { /* fall back to the simple matcher below */ }

        if (ids.length === 0) {
            const q = query.toLowerCase();
            for (const c of this._appCells) {
                if (c.entry.name.toLowerCase().includes(q) || c.entry.id.toLowerCase().includes(q))
                    push(c.entry.id);
            }
        }
        return ids.map(id => this._byId.get(id));
    }

    /**
     * Folder layout (no search): the logo in the middle, then either the open folder's apps or the root level
     * (folder tiles first, then the apps that are in no folder). Positions are assigned along the spiral, so
     * the lattice stays compact whatever is showing; hidden apps stay out (search finds them).
     */
    _layoutGrouped() {
        const folder = this._folder ? this._folderCells.get(this._folder) : null;
        const list = folder
            ? folder.members.filter(c => !c.hiddenApp)
            : [...this._folderCells.values(), ...this._appCells.filter(c => !c.group && !c.hiddenApp)];
        for (const c of this._cells)
            c.tvis = 0;
        let i = 0;
        const place = c => {
            const [q, r] = this._spiral[i++];
            const [px, py] = lat(G.LAYOUT, q, r);
            c.tx = px;
            c.ty = py;
            c.tvis = 1;
        };
        place(this._cells[0]);
        for (const c of list.slice(0, this._spiral.length - 1))
            place(c);
        if (this._opts.decor) {
            // faint empty tiles complete the ring and add one more around it
            const last = cellRing(G.LAYOUT, ...this._spiral[Math.max(0, i - 1)]);
            for (const c of this._cells) {
                if (c.kind !== 'empty' || i >= this._spiral.length)
                    continue;
                if (cellRing(G.LAYOUT, ...this._spiral[i]) > last + 1)
                    break;
                place(c);
            }
        }
    }

    /** `keepView`: edits of a custom layout must not recentre or drop the highlight (nothing but the edited tiles moves). */
    _applyLayout(keepView = false) {
        this._timed(this._query ? 'applyLayout(search)' : 'applyLayout', () => this._applyLayoutInner(keepView));
    }

    _applyLayoutInner(keepView) {
        this._results = [];
        if (!this._query) {
            if (this._custom) {
                this._layoutCustom();
            } else if (this._grouped) {
                this._layoutGrouped();
            } else {
                for (const c of this._cells) {
                    const [px, py] = lat(G.LAYOUT, c.q, c.r);
                    c.tx = px;
                    c.ty = py;
                    c.tvis = (c.kind === 'empty' && !this._opts.decor) || c.hiddenApp ? 0 : 1;
                }
            }
            this._order = this._cells.filter(c => c.kind !== 'empty' && c.tvis >= 0.5);
        } else {
            const found = this._searchCells(this._query).slice(0, this._appCells.length);
            for (const c of this._cells)
                c.tvis = 0;
            // best match takes the centre cell, the rest spiral outwards
            found.forEach((c, i) => {
                const [q, r] = this._spiral[i];
                const [px, py] = lat(G.LAYOUT, q, r);
                c.tx = px;
                c.ty = py;
                c.tvis = 1;
                this._results.push(c);
            });
            this._order = this._results.slice();
        }
        // highlight the best match so it is obvious what Enter will launch
        if (!keepView || this._query)
            this._setHover(this._query && this._results[0] ? this._results[0] : null);
        if (!keepView) {
            this._panT.x = 0;
            this._panT.y = 0;
        }
        this._wake();
    }

    // ------------------------------------------------------------------ custom layout (fixed slots, see layout.js)
    _customEnv() {
        if (!this._envCache || this._envCache.lattice !== G.LAYOUT)
            this._envCache = {lattice: G.LAYOUT, spiral: buildSpiral(G.LAYOUT, MAX_RINGS)};
        return LY.makeEnv(this._envCache.spiral, this._getString('custom-policy', 'packed'), G.LAYOUT);
    }

    /** The outermost ring any tile of the layout sits on. */
    _customReach() {
        let reach = 1;
        const maps = [this._layout.root, ...this._layout.folders.map(f => f.slots)];
        for (const m of maps) {
            for (const k of Object.keys(m))
                reach = Math.max(reach, cellRing(G.LAYOUT, m[k][0], m[k][1]));
        }
        return reach;
    }

    /** Folder definitions ([{id, name, ids}]) for the working layout. */
    _customFolderDefs(env) {
        return this._layout.folders.map(f => ({id: f.id, name: f.name, ids: LY.orderedKeys(env, this._layout, f.id)}));
    }

    /**
     * Load (first time / after an outside edit), snapshot (first time ever) and reconcile the custom layout with the
     * installed apps. Returns the folder definitions for _rebuild().
     */
    _customState(entries) {
        const env = this._customEnv();
        const raw = this._settings.get_string('custom-layout');
        let snapshotted = false;
        if (this._layout === null || raw !== this._layoutRaw) {
            const p = LY.parseLayout(raw, G.LAYOUT);
            for (const w of p.warnings.slice(0, 5))
                console.warn(`${LOG} ${w}`);
            this._layoutRaw = raw;
            this._layoutProtect = p.invalid;
            this._layout = p.layout;
            if (p.blank) {
                this._layout = this._snapshotFromMode(env, entries, this._autoMode);
                snapshotted = true;
            }
        }
        const rc = LY.reconcile(env, this._layout, entries.filter(e => !e.hidden).map(e => e.id));
        if (rc.changed) {
            this._layout = rc.layout;
            this._layoutDirty = true;
        }
        if (snapshotted && !this._layoutProtect) {
            this._undo.clear();
            this._writeLayout(); // freeze what the user sees now: later changes of the Order setting must not move anything
        }
        return this._customFolderDefs(env);
    }

    /** The layout that reproduces what the given automatic mode shows right now (no tile moves when switching to custom). */
    _snapshotFromMode(env, entries, mode) {
        let defs = [];
        if (mode === 'categories' || mode === 'gnome')
            defs = this._computeFolders(entries, mode).filter(d => d.ids.length > 0);
        const taken = new Set();
        const folders = defs.map(d => {
            const id = LY.newFolderId(taken);
            taken.add(id);
            const byId = new Map(entries.map(e => [e.id, e]));
            return {id, name: d.name, ids: d.ids.filter(i => byId.has(i) && !byId.get(i).hidden)};
        });
        entries = entries.filter(e => !e.hidden); // hidden apps are parked, not placed
        const inFolder = groupOf(defs);
        const loose = entries.filter(e => !inFolder.has(e.id));
        const rootKeys = [
            ...folders.map(f => LY.folderKey(f.id)),
            ...loose.filter(e => !e.hidden).map(e => e.id),
            ...loose.filter(e => e.hidden).map(e => e.id),
        ];
        return LY.snapshotCurrent(env, rootKeys, folders);
    }

    /** Persist the working layout. Our own write must not make the Hive rebuild (see _onSettingsChanged). */
    _writeLayout() {
        if (this._destroyed || !this._layout || !this._hasKey('custom-layout'))
            return;
        const raw = LY.serializeLayout(this._layout);
        this._selfWrite++;
        try {
            this._settings.set_string('custom-layout', raw);
            this._layoutRaw = raw;
            this._layoutDirty = false;
        } catch (e) {
            console.error(`${LOG} could not save the custom layout: ${e}`);
        } finally {
            this._selfWrite--;
        }
    }

    /** Write a reconcile result that is only kept in memory (never over unreadable text). */
    _flushLayout() {
        if (this._custom && this._layoutDirty && !this._layoutProtect)
            this._writeLayout();
    }

    /** Adopt `next` as the layout after a user action: one undo step, saved at once, view kept still. */
    _commitLayout(next, merge = false) {
        if (!next || next === this._layout)
            return;
        this._perf?.count('layoutEdits');
        if (!merge) // `merge`: part of the previous action (naming the folder that a drop just made)
            this._undo.push(this._layout);
        this._layout = next;
        this._layoutProtect = false;
        this._writeLayout();
        this._afterLayoutChange();
    }

    /** Run a layout operation `fn(env, layout) -> {layout, error}`; refusals are explained in the footer. */
    _editLayout(fn, okText = '', merge = false) {
        if (!this._custom || !this._layout)
            return null;
        const res = fn(this._customEnv(), this._layout);
        if (res.error) {
            const why = {
                full: 'No room left on the lattice', 'too-many': 'Too many folders', same: 'It is already in that folder',
                policy: 'Only the Free arrangement has empty slots',
            }[res.error] ?? 'That change is not possible';
            this._flash(why);
            return null;
        }
        this._commitLayout(res.layout, merge);
        if (okText)
            this._flash(okText);
        return res;
    }

    _undoLayout(dir) {
        if (!this._custom || !this._layout)
            return;
        const prev = dir < 0 ? this._undo.undo(this._layout) : this._undo.redo(this._layout);
        if (!prev) {
            this._flash(dir < 0 ? 'Nothing to undo' : 'Nothing to redo');
            return;
        }
        if (prev.policy && prev.policy !== this._getString('custom-policy', 'packed')) { // undoing a Packed/Free switch
            this._selfPolicy++;
            try {
                this._settings.set_string('custom-policy', prev.policy);
            } finally {
                this._selfPolicy--;
            }
        }
        this._layout = prev;
        this._writeLayout();
        this._afterLayoutChange();
        this._flash(dir < 0 ? 'Undone' : 'Redone');
    }

    /**
     * Show the new layout without disturbing the view: untouched tiles keep their exact position, the pan and the
     * highlight survive, and only the tiles that changed glide to their new slots.
     */
    _afterLayoutChange() {
        this._timed('afterLayoutChange', () => this._afterLayoutChangeInner());
    }

    _afterLayoutChangeInner() {
        this._edit.grabbed = null; // a carried tile may not exist any more
        const key = c => (c.kind === 'app' ? c.entry.id : c.kind === 'folder' ? LY.folderKey(c.entry.id) : c.kind);
        const old = new Map();
        for (const c of this._cells) {
            if (c.kind !== 'empty')
                old.set(key(c), {lx: c.lx, ly: c.ly, vis: c.vis, members: c.kind === 'folder' ? c.members.map(m => m.entry.id) : null});
        }
        const hoverKey = this._hovered && this._hovered.kind !== 'empty' ? key(this._hovered) : null;
        if (this._rebuild()) {
            this._markRunning();
            this._applyTheme();
            this._applyLayout(true);
            for (const c of this._cells) {
                if (c.kind === 'empty') {
                    c.lx = c.tx;
                    c.ly = c.ty;
                    c.vis = c.tvis;
                    continue;
                }
                let o = old.get(key(c));
                if (!o && c.kind === 'folder') { // a new folder grows out of the tile that became its first member
                    const first = c.members[0] && old.get(c.members[0].entry.id);
                    o = first ? {lx: first.lx, ly: first.ly, vis: first.vis} : null;
                }
                c.lx = o ? o.lx : c.tx;
                c.ly = o ? o.ly : c.ty;
                c.vis = o ? o.vis : 0;
            }
            if (hoverKey) {
                const again = this._cells.find(c => c.kind !== 'empty' && key(c) === hoverKey && c.tvis >= 0.5);
                if (again)
                    this._setHover(again);
            }
        } else {
            this._applyLayout(true);
        }
        this._syncEditUi();
        this._wake();
    }

    /** How many empty-tile cells a level may need (free slots within the occupied rings + the two edit-mode rings). */
    _customEmptyNeed(have) {
        let need = 0;
        const levels = [this._layout.root, ...this._layout.folders.map(f => f.slots)];
        for (const m of levels) {
            const keys = Object.keys(m);
            let reach = 0;
            for (const k of keys)
                reach = Math.max(reach, cellRing(G.LAYOUT, m[k][0], m[k][1]));
            let within = 0;
            for (const [q, r] of this._spiral) {
                if ((q || r) && cellRing(G.LAYOUT, q, r) <= reach + Math.max(2, this._opts.edit.freeRings))
                    within++;
            }
            need = Math.max(need, within - keys.length);
        }
        return Math.max(0, need - Math.max(0, have));
    }

    /** Positions straight from the stored slots: no spiral assignment, no sorting. */
    _layoutCustom() {
        const folder = this._folder ? LY.findFolder(this._layout, this._folder) : null;
        if (this._folder && !folder)
            this._folder = null;
        const map = folder ? folder.slots : this._layout.root;
        for (const c of this._cells) {
            c.tvis = 0;
            if (c.kind === 'empty')
                c.slot = null;
        }
        const logo = this._cells[0];
        logo.tx = 0;
        logo.ty = 0;
        logo.tvis = 1;
        let reach = 0;
        const used = new Set();
        for (const k of Object.keys(map)) {
            const cell = LY.isFolderKey(k) ? this._folderCells.get(LY.folderIdOf(k)) : this._byId.get(k);
            if (!cell)
                continue;
            const [q, r] = map[k];
            const [px, py] = lat(G.LAYOUT, q, r);
            cell.tx = px;
            cell.ty = py;
            cell.tvis = cell.hiddenApp ? 0 : 1;
            used.add(`${q},${r}`);
            reach = Math.max(reach, cellRing(G.LAYOUT, q, r));
        }
        const free = this._getString('custom-policy', 'packed') === 'free';
        const editing = this._edit.active;
        // Packed edit mode shows no empty tiles at all; Free edit mode shows every free slot + the extra rings; outside editing the decor
        // tiles are off unless "keep empty tiles" (and Show empty tiles) are on
        const keep = this._opts.decor && this._opts.edit.keepEmpty;
        const show = editing ? free : keep;
        if (show) {
            // editing: every free slot around the outermost tile; otherwise only the compact flower a packed layout of this size would have
            const packedRing = cellRing(G.LAYOUT, ...(this._spiral[Math.min(Object.keys(map).length, this._spiral.length - 1)] ?? [0, 0]));
            const limit = editing ? reach + this._opts.edit.freeRings : Math.min(reach, packedRing) + 1;
            const pool = this._cells.filter(c => c.kind === 'empty');
            let n = 0;
            for (const [q, r] of this._spiral) {
                if ((q === 0 && r === 0) || used.has(`${q},${r}`))
                    continue;
                if (cellRing(G.LAYOUT, q, r) > limit || n >= pool.length)
                    continue;
                const [px, py] = lat(G.LAYOUT, q, r);
                const c = pool[n++];
                c.tx = px;
                c.ty = py;
                c.tvis = 1;
                c.slot = [q, r];
            }
        }
        this._updateBackGlyph();
    }

    // ------------------------------------------------------------------ Edit Hive: edit mode
    _cellKey(c) {
        return c.kind === 'app' ? c.entry.id : c.kind === 'folder' ? LY.folderKey(c.entry.id) : c.kind === 'logo' ? 'logo' : null;
    }

    _descOf(c) {
        return {key: this._cellKey(c), kind: c.kind};
    }

    _updateBackGlyph() {
        const logo = this._cells[0];
        if (logo?.backGlyph)
            logo.backGlyph.visible = !!this._folder;
    }

    _resetEdit() {
        this._cancelTileDrag();
        this._clearLongPress(this._press);
        this._edit.active = false;
        this._edit.grabbed = null;
        this._editLayer.visible = false;
        this._donePill.visible = false;
    }

    /** Show / hide everything that only exists while editing, and refresh the footer. */
    _syncEditUi() {
        const e = this._edit;
        this._donePill.visible = e.active;
        this._perf?.scene({edit: e.active});
        const busy = e.active && (!!e.drag || !!e.grabbed);
        this._editLayer.visible = busy;
        if (busy) {
            this._editLayer.set_size(this._W, this._H);
            this._editLayer.queue_repaint();
        }
        this._updateHint();
        this._wake();
    }

    _toggleEdit() {
        if (this._edit.active)
            this._leaveEdit();
        else
            this._enterEdit();
    }

    /** Edit mode lives on the custom layout: entering it from another mode snapshots what is on screen and switches to it. */
    _enterEdit() {
        if (!this._open || this._edit.active)
            return;
        if (this._query) {
            this._suppressText = true;
            try {
                this._entry.set_text('');
            } finally {
                this._suppressText = false;
            }
            this._query = '';
            this._applyLayout();
        }
        if (!this._custom) {
            this._settings.set_string('group-mode', 'custom'); // the settings handler rebuilds the Hive as a custom layout
            if (!this._custom) {
                this._flash('Editing needs the “My custom layout” mode');
                return;
            }
        }
        this._edit.active = true;
        this._edit.grabbed = null;
        this._flashText = ''; // drop the "Folders: …" announcement of the mode switch; the editing hint takes over
        this._afterLayoutChange(); // Free: the empty slots appear (they are only built while editing)
    }

    _leaveEdit() {
        if (!this._edit.active)
            return;
        this._cancelTileDrag();
        this._edit.active = false;
        this._edit.grabbed = null;
        if (this._custom)
            this._afterLayoutChange();
        this._syncEditUi();
    }

    /** Packed <-> Free. Going to Packed tidies once (stable order); undoing it restores the old policy too. */
    _setPolicy(policy) {
        if (!this._custom || !this._layout || this._getString('custom-policy', 'packed') === policy)
            return;
        this._selfPolicy++;
        try {
            this._settings.set_string('custom-policy', policy);
        } finally {
            this._selfPolicy--;
        }
        const next = LY.setPolicy(this._customEnv(), this._layout, policy).layout;
        next.policy = policy;
        this._commitLayout(next);
        this._flash(policy === 'packed' ? 'Packed: no gaps' : 'Free: tiles can sit anywhere, gaps allowed');
    }

    _confirmResetLayout(x, y) {
        this._openMenu([
            {label: 'Reset to the plain alphabetical-by-setting order', icon: 'view-refresh-symbolic', danger: true, onClick: () => {
                const next = this._snapshotFromMode(this._customEnv(), this._buildEntries(), 'none');
                this._commitLayout(next);
                this._flash('Layout reset (Ctrl+Z undoes it)');
            }},
            {label: 'Cancel', icon: 'window-close-symbolic'},
        ], x, y, 'Reset the whole custom layout?', null, true);
    }

    // ------------------------------------------------------------------ Edit Hive: mouse / touch drag
    _clearLongPress(p) {
        if (p?.longTimer) {
            GLib.source_remove(p.longTimer);
            p.longTimer = 0;
        }
    }

    _startTileDrag(cell, x, y) {
        const e = this._edit;
        if (!e.active || e.drag || this._menuCard || this._prompt)
            return false;
        if (this._query) {
            this._flash('Clear the search before rearranging');
            return false;
        }
        const p = this._press;
        this._perf?.note(`lift ${cell.kind} ${cell.entry?.name ?? ''}`);
        e.drag = {cell, x, y, gx: cell.sx, gy: cell.sy, gs: cell.stot, target: null, targetCell: null, shift: false, dwellMs: 0, pan: {x: 0, y: 0}};
        e.grabbed = null;
        this._dwell.reset();
        if (p) {
            p.moved = true;
            p.tileDrag = true;
            this._clearLongPress(p);
        }
        this._pressCell(null);
        this._setHover(null);
        this._canvas.set_child_above_sibling(this._editLayer, null);
        this._canvas.set_child_above_sibling(cell.actor, null); // the lifted tile floats above the rings
        this._setCursor('grab');
        this._syncEditUi();
        this._updateTileDrag(x, y);
        return true;
    }

    _updateTileDrag(x, y, shift) {
        const d = this._edit.drag;
        if (!d)
            return;
        d.x = x;
        d.y = y;
        if (shift !== undefined)
            d.shift = shift;
        // near a screen edge the Hive pans by itself (speed grows towards the edge), so far tiles can be reached
        const W = this._W;
        const H = this._H;
        const sp = 900 * this._opts.edit.autopan;
        d.pan.x = x < EDGE_PAN ? -(EDGE_PAN - x) / EDGE_PAN * sp : x > W - EDGE_PAN ? (x - (W - EDGE_PAN)) / EDGE_PAN * sp : 0;
        d.pan.y = y < EDGE_PAN ? -(EDGE_PAN - y) / EDGE_PAN * sp : y > H - EDGE_PAN ? (y - (H - EDGE_PAN)) / EDGE_PAN * sp : 0;
        this._resolveDragTarget();
        this._wake();
    }

    /** What would happen if the lifted tile were dropped right now (screen space, so the fisheye is respected). */
    _resolveDragTarget() {
        this._timed('resolveDragTarget', () => this._resolveDragTargetInner());
    }

    _resolveDragTargetInner() {
        const d = this._edit.drag;
        if (!d)
            return;
        const logo = this._cells[0];
        const tiles = [];
        const slots = [];
        let reach = 0;
        for (const c of this._cells) {
            if (c.tvis < 0.5 || c.stot < 0.12)
                continue;
            const r = G.HEX_R * c.stot;
            if (c.kind === 'empty') {
                if (c.slot)
                    slots.push({slot: c.slot, x: c.sx, y: c.sy, r, cell: c});
                continue;
            }
            reach = Math.max(reach, Math.hypot(c.sx - logo.sx, c.sy - logo.sy));
            if (c !== d.cell)
                tiles.push({key: this._cellKey(c), kind: c.kind, x: c.sx, y: c.sy, r, cell: c});
        }
        const dragged = this._descOf(d.cell);
        const st = {
            policy: this._getString('custom-policy', 'packed'), inFolder: !!this._folder, shift: d.shift, dwellMs: 0,
            dwellNeeded: this._opts.edit.dwellMs, hit: this._opts.edit.hit,
            beyond: Math.hypot(d.x - logo.sx, d.y - logo.sy) > reach + G.HEX_R * 0.8,
        };
        const ptr = {x: d.x, y: d.y};
        let t = dropTarget(tiles, slots, ptr, dragged, st);
        const dwellKey = (t.kind === 'swap' || t.kind === 'folder') && dragged.kind === 'app' && !this._folder ? t.key : null;
        st.dwellMs = this._dwell.update(dwellKey, GLib.get_monotonic_time() / 1000);
        if (dwellKey)
            t = dropTarget(tiles, slots, ptr, dragged, st);
        d.target = t;
        d.dwellMs = st.dwellMs;
        d.targetCell = t.key ? (tiles.find(x => x.key === t.key)?.cell ?? null)
            : t.kind === 'move' ? (slots.find(x => x.slot === t.slot)?.cell ?? null)
                : t.kind === 'out' ? logo : null;
    }

    _finishTileDrag(x, y, shift) {
        const d = this._edit.drag;
        if (!d)
            return;
        this._updateTileDrag(x, y, shift);
        const {cell, target, targetCell} = d;
        this._edit.drag = null;
        this._dwell.reset();
        this._setCursor('default');
        if (target.kind !== 'none') {
            if (targetCell && target.kind !== 'out') { // the tile appears to come from where it was dropped
                cell.lx = targetCell.lx;
                cell.ly = targetCell.ly;
            }
            this._applyDrop(cell, target);
        }
        this._syncEditUi();
    }

    _cancelTileDrag() {
        const d = this._edit.drag;
        if (!d)
            return;
        this._edit.drag = null;
        this._dwell.reset();
        if (this._press)
            this._press.cancelled = true;
        this._setCursor('default');
        this._syncEditUi();
    }

    /** Carry out a resolved drop / keyboard action on the layout. */
    _applyDrop(cell, act) {
        this._perf?.note(`drop ${act.kind}`);
        const level = this._folder ?? LY.ROOT;
        const dk = this._cellKey(cell);
        switch (act.kind) {
        case 'swap':
            return !!this._editLayout((env, l) => LY.swap(env, l, level, dk, act.key));
        case 'folder': {
            const res = this._editLayout((env, l) => LY.makeFolder(env, l, LY.ROOT, dk, act.key, 'New folder'));
            if (res)
                this._nameNewFolder(res.folderId);
            return !!res;
        }
        case 'into':
            return !!this._editLayout((env, l) => LY.addToFolder(env, l, dk, LY.folderIdOf(act.key)), 'Added to the folder');
        case 'move':
            return !!this._editLayout((env, l) => LY.moveToSlot(env, l, level, dk, act.slot));
        case 'out':
            if (!this._folder)
                return false;
            return !!this._editLayout((env, l) => LY.removeFromFolder(env, l, this._folder, dk), 'Taken out of the folder');
        default:
            return false;
        }
    }

    /** A folder was just made by a drop: ask for its name right away (the rename joins the same undo step). */
    _nameNewFolder(id) {
        if (!this._opts.edit.askName)
            return;
        this._askName('Name the new folder', 'New folder', name => {
            this._editLayout((env, l) => LY.renameFolder(env, l, id, name), '', true);
        });
    }

    // ------------------------------------------------------------------ Edit Hive: keyboard carry
    _editGrab() {
        const c = this._hovered;
        if (!c || (c.kind !== 'app' && c.kind !== 'folder') || c.tvis < 0.5) {
            this._flash('Highlight a tile with the arrow keys first, then press Space');
            return;
        }
        this._edit.grabbed = c;
        this._syncEditUi();
    }

    _editRelease() {
        this._edit.grabbed = null;
        this._syncEditUi();
    }

    /** Enter / Shift+Enter while carrying: act on the tile (or empty slot) under the cursor. */
    _editDropCarried(shift) {
        const g = this._edit.grabbed;
        const t = this._hovered;
        if (!g)
            return;
        if (!t || t === g || t.tvis < 0.5) {
            this._flash('Move the highlight onto the tile to swap with, then press Enter');
            return;
        }
        const policy = this._getString('custom-policy', 'packed');
        const st = {shift, inFolder: !!this._folder, policy};
        const act = t.kind === 'empty' ? onSlot(t.slot, st) : onTile(this._descOf(g), this._descOf(t), st);
        if (act.kind === 'none') {
            this._flash(t.kind === 'logo' ? 'Nothing to do on the centre tile here' : 'That cannot be dropped there');
            return;
        }
        if (act.kind !== 'out') {
            g.lx = t.lx;
            g.ly = t.ly;
        }
        this._applyDrop(g, act);
    }

    // ------------------------------------------------------------------ Edit Hive: overlay painting
    _paintEdit() {
        const e = this._edit;
        const cr = this._editLayer.get_context();
        try {
            const P = G.palette;
            const acc = P.accent;
            const R = G.HEX_R;
            const colors = {swap: acc, folder: [1, 0.78, 0.25], into: [0.35, 0.85, 0.5], move: acc, out: [0.95, 0.5, 0.4]};
            const ring = (x, y, r, col, a, lw, dash) => {
                cr.setLineWidth(lw);
                cr.setSourceRGBA(col[0], col[1], col[2], a);
                cr.setDash(dash ?? [], 0);
                cr.newPath();
                cr.arc(x, y, r, 0, Math.PI * 2);
                cr.stroke();
            };
            const d = e.drag;
            if (d) {
                ring(d.gx, d.gy, R * d.gs * 0.92, P.fg, 0.45, 2, [6, 5]); // ghost outline where the tile came from
                const t = d.target;
                const tc = d.targetCell;
                if (t && t.kind !== 'none' && tc) {
                    const r = R * Math.max(tc.stot, 0.3) * 0.98 + 4;
                    ring(tc.sx, tc.sy, r, colors[t.kind] ?? acc, 0.95, t.kind === 'folder' || t.kind === 'into' ? 4 : 3);
                    if (t.kind === 'swap' && d.cell.kind === 'app' && tc.kind === 'app' && !this._folder) {
                        const pr = dwellProgress(d.dwellMs, this._opts.edit.dwellMs); // fills while hovering: complete = "make a folder"
                        if (pr > 0) {
                            const f = colors.folder;
                            cr.setLineWidth(5);
                            cr.setSourceRGBA(f[0], f[1], f[2], 0.95);
                            cr.setDash([], 0);
                            cr.newPath();
                            cr.arc(tc.sx, tc.sy, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr);
                            cr.stroke();
                        }
                    }
                }
            } else if (e.grabbed) {
                const g = e.grabbed;
                ring(g.sx, g.sy, R * g.stot * 0.95, acc, 0.9, 3, [8, 6]);
                const h = this._hovered;
                if (h && h !== g && h.tvis >= 0.5) {
                    const st = {shift: false, inFolder: !!this._folder, policy: this._getString('custom-policy', 'packed')};
                    const act = h.kind === 'empty' ? onSlot(h.slot, st) : onTile(this._descOf(g), this._descOf(h), st);
                    if (act.kind !== 'none')
                        ring(h.sx, h.sy, R * Math.max(h.stot, 0.3) * 0.98 + 4, colors[act.kind] ?? acc, 0.95, 3);
                }
            }
        } finally {
            cr.$dispose();
        }
    }

    // ------------------------------------------------------------------ custom layout: folder name prompt
    /** Ask for a folder name in the search field (no dialog): Enter commits, Esc cancels, the lattice stays frozen. */
    _askName(title, initial, onCommit) {
        this._closeMenu();
        this._prompt = {title, onCommit};
        this._suppressText = true;
        try {
            this._entry.set_text(initial);
            this._entry.clutter_text.set_selection?.(0, -1);
        } finally {
            this._suppressText = false;
        }
        this._entry.grab_key_focus();
        this._updateHint();
    }

    _endPrompt() {
        this._prompt = null;
        this._suppressText = true;
        try {
            this._entry.set_text('');
        } finally {
            this._suppressText = false;
        }
        this._query = '';
        this._updateHint();
    }

    _cancelPrompt() {
        if (this._prompt)
            this._endPrompt();
    }

    _commitPrompt() {
        const p = this._prompt;
        if (!p)
            return;
        const text = this._entry.clutter_text.get_text();
        this._endPrompt();
        p.onCommit(text);
    }

    // ------------------------------------------------------------------ custom layout: menu actions
    _newFolderFor(cell) {
        this._askName('New folder name', 'New folder', name => {
            this._editLayout((env, l) => LY.newFolder(env, l, cell.entry.id, name), `Folder “${LY.normName(name)}” created`);
        });
    }

    _moveToFolderMenu(cell, x, y) {
        const items = [];
        for (const f of this._layout.folders) {
            if (f.id === cell.group)
                continue;
            items.push({
                label: f.name, icon: 'folder-symbolic',
                onClick: () => this._editLayout((env, l) => LY.addToFolder(env, l, cell.entry.id, f.id), `Moved to “${f.name}”`),
            });
        }
        if (items.length)
            items.push({sep: true});
        items.push({label: 'New folder…', icon: 'folder-new-symbolic', onClick: () => this._newFolderFor(cell)});
        this._openMenu(items, x, y, `Move “${cell.entry.name}” to…`, null, true);
    }

    _renameFolderPrompt(cell) {
        this._askName('Folder name', cell.entry.name, name => {
            this._editLayout((env, l) => LY.renameFolder(env, l, cell.entry.id, name));
        });
    }

    _confirmDeleteFolder(cell, x, y) {
        this._openMenu([
            {label: 'Delete folder (its apps stay)', icon: 'user-trash-symbolic', danger: true,
                onClick: () => this._editLayout((env, l) => LY.deleteFolder(env, l, cell.entry.id), 'Folder deleted')},
            {label: 'Cancel', icon: 'window-close-symbolic'},
        ], x, y, `Delete “${cell.entry.name}”?`, null, true);
    }

    /** Re-read the previous automatic mode's arrangement into the custom layout (one undo step). */
    _resnapshot() {
        const entries = this._buildEntries();
        const next = this._snapshotFromMode(this._customEnv(), entries, this._autoMode);
        this._commitLayout(next);
        this._flash('Layout copied from the current automatic order');
    }

    _clampPan() {
        const d = Math.hypot(this._panT.x, this._panT.y);
        if (d > this._maxPan) {
            this._panT.x *= this._maxPan / d;
            this._panT.y *= this._maxPan / d;
        }
    }

    /** Magnetise the view so the nearest real app sits exactly in the centre. */
    _snapToNearest() {
        let best = null;
        let bd = 1e12;
        for (const c of this._cells) {
            if (c.tvis < 0.5 || c.kind === 'empty')
                continue; // always land on a real cell
            const d = (c.tx - this._panT.x) ** 2 + (c.ty - this._panT.y) ** 2;
            if (d < bd) {
                bd = d;
                best = c;
            }
        }
        if (best) {
            this._panT.x = best.tx;
            this._panT.y = best.ty;
        }
        this._wake();
    }

    // ------------------------------------------------------------------ frame loop
    _wake() {
        this._idle = 0;
        if (!this._root.visible || this._destroyed)
            return;
        if (!this._driver.running) {
            this._last = 0;
            this._driver.start();
        }
    }

    /** One animation frame. Returns false when everything has settled (the driver then stops). */
    _tick() {
        const now = GLib.get_monotonic_time();
        const pt0 = this._perf ? now : 0;
        if (!this._last)
            this._last = now;
        const dt = Math.min(0.05, (now - this._last) / 1e6);
        this._last = now;
        if (this._firstFramePending) { // the Hive's own evidence for the load governor: how long open() -> first frame took
            this._firstFramePending = false;
            this._openHist.push((now - this._openT0) / 1000);
        }
        let moving = false;
        const drag = this._edit.drag;
        if (drag && (drag.pan.x || drag.pan.y)) { // dragging a tile near a screen edge pans the Hive
            this._panT.x += drag.pan.x * dt;
            this._panT.y += drag.pan.y * dt;
            this._clampPan();
        }

        // smooth pan: exponential approach (stiffer while the finger is down)
        const fp = 1 - Math.exp(-(this._dragging ? 38 : 11) * dt);
        const pdx = this._panT.x - this._pan.x;
        const pdy = this._panT.y - this._pan.y;
        if (Math.abs(pdx) > 0.05 || Math.abs(pdy) > 0.05)
            moving = true;
        this._pan.x += pdx * fp;
        this._pan.y += pdy * fp;

        const da = this._appearT - this._appear;
        if (Math.abs(da) > 0.003) {
            this._appear += da * (1 - Math.exp(-7 * dt * G.ANIM_SPEED));
            moving = true;
        }
        const fade = Math.round(255 * clamp01(this._appear * 1.8));
        this._bg.opacity = fade;
        this._vignette.opacity = fade;
        this._bar.opacity = fade;
        this._hint.opacity = fade;

        const W = this._W;
        const H = this._H;
        const ccx = W / 2;
        const ccy = H / 2 + this._barShift;
        const fh = 1 - Math.exp(-16 * dt); // hover easing
        const fl = 1 - Math.exp(-9 * dt);  // layout easing
        const R0 = this._R0;
        const KD = this._KD;
        // 'materialize': the glass focuses into being by ramping the lens strength instead of just fading
        if (this._useRefraction && this._snapContent) {
            const lens = this._animate && G.OPEN_ANIM === 'materialize' ? Math.round(clamp01(this._appear * 1.5) * 20) / 20 : 1;
            if (lens !== this._lensApplied) {
                this._lensApplied = lens;
                this._pushLens(lens);
            }
        }
        const zoomOpen = this._animate && G.OPEN_ANIM === 'zoom';
        const cz = zoomOpen ? 0.88 + 0.12 * clamp01(this._appear) : 1;
        if (cz !== this._canvasScale) {
            this._canvasScale = cz;
            this._canvas.set_scale(cz, cz);
        }
        const ambient = this._animate && !this._ambientPaused ? G.AMBIENT : 'none';
        const tt = now / 1e6;
        if (ambient !== 'none' && this._open)
            moving = true; // ambient animations keep the frame loop alive while the Hive is shown
        const ed = this._opts.edit;
        const wobble = this._edit.active && this._animate && ed.wobble > 0; // editing: tiles tremble gently ("jiggle mode")
        if (wobble || drag || this._edit.grabbed)
            moving = true;

        for (const c of this._cells) {
            if (Math.abs(c.tx - c.lx) > 0.05 || Math.abs(c.ty - c.ly) > 0.05 || Math.abs(c.tvis - c.vis) > 0.004)
                moving = true;
            c.lx += (c.tx - c.lx) * fl;
            c.ly += (c.ty - c.ly) * fl;
            c.vis += (c.tvis - c.vis) * fl;
            // hover response: smooth ease, or a damped spring for the 'bounce' style
            if (G.HOVER_STYLE === 'bounce' && this._animate) {
                const h = Math.min(dt, 0.025);
                if (Math.abs(c.thover - c.hover) > 0.002 || Math.abs(c.hvel) > 0.01) {
                    c.hvel += (380 * (c.thover - c.hover) - 17 * c.hvel) * h;
                    c.hover += c.hvel * h;
                    moving = true;
                    if (c.kind !== 'empty')
                        this._rp(c.area);
                } else if (c.hover !== c.thover) {
                    c.hover = c.thover;
                    c.hvel = 0;
                }
            } else if (Math.abs(c.thover - c.hover) > 0.004) {
                moving = true;
                c.hover += (c.thover - c.hover) * fh;
                if (c.kind !== 'empty')
                    this._rp(c.area);
            }
            // press feedback
            if (Math.abs(c.tpress - c.press) > 0.003) {
                c.press += (c.tpress - c.press) * (1 - Math.exp(-28 * dt));
                moving = true;
            }
            // glint sweep (one-shot, started when the tile is hovered)
            if (c.shineT < 1) {
                c.shineT = Math.min(1, c.shineT + dt * 1.8);
                this._rp(c.area);
                moving = true;
            }

            // ---- fisheye ----
            const vx = c.lx - this._pan.x;
            const vy = c.ly - this._pan.y;
            const d = Math.hypot(vx, vy);
            const SMIN = G.SMIN;
            const s = SMIN + (1 - SMIN) / (1 + (d / R0) ** 2);                   // local scale
            const dm = SMIN * d + (1 - SMIN) * R0 * Math.atan(d / R0);           // ∫scale ⇒ tight packing
            const k = d > 0.001 ? dm / d : 1;
            const sc = Math.min(1, s * 1.1) * (1 + (G.HOVER_SCALE - 1) * c.hover) * (1 - 0.07 * c.press);
            const launched = this._closing && G.LAUNCH_ANIM && c === this._launchCell;
            const cascade = this._animate && G.OPEN_ANIM === 'cascade';
            const stagger = launched ? 1 : cascade
                ? clamp01(this._appear * 2.4 - c.ang01 * 1.4 - c.ring * 0.05)
                : clamp01(this._appear * (1 + KD * 0.24) - c.ring * 0.24);
            const st01 = clamp01(stagger);
            const vis = Math.max(0, c.vis);

            // ---- opening / closing animation (per-tile)
            let total;
            let alpha = 1;
            let yoff = 0;
            let xoff = 0;
            let rot = 0;
            let flipY = 0;
            switch (this._animate ? G.OPEN_ANIM : 'pop') {
            case 'fade':
                total = sc * vis * (0.88 + 0.12 * st01);
                alpha = st01;
                break;
            case 'zoom':
                total = sc * vis;
                alpha = clamp01(this._appear * 1.8);
                break;
            case 'rise':
                total = sc * vis * (0.9 + 0.1 * st01);
                alpha = clamp01(st01 * 1.4);
                yoff = (1 - st01) * 80;
                break;
            case 'spin':
                total = sc * vis * Math.max(0, easeOutBack(stagger));
                rot = -(1 - st01) * 140;
                break;
            case 'materialize':
                total = sc * vis * (0.96 + 0.04 * st01);
                alpha = clamp01(st01 * 1.3);
                break;
            case 'spring':
                total = sc * vis * Math.max(0, easeOutElastic(st01));
                alpha = clamp01(st01 * 2);
                break;
            case 'flip':
                total = sc * vis * (0.75 + 0.25 * st01);
                alpha = clamp01(st01 * 1.6);
                flipY = (1 - st01) * 90;
                break;
            case 'converge': {
                // fly in from beyond the screen edge, along the line from the centre
                const dd = Math.max(1, Math.hypot(vx, vy));
                const away = (1 - st01) * Math.max(W, H) * 0.55;
                xoff = vx / dd * away;
                yoff = vy / dd * away;
                total = sc * vis * (0.6 + 0.4 * st01);
                alpha = clamp01(st01 * 1.6);
                break;
            }
            case 'cascade':
                total = sc * vis * Math.max(0, easeOutBack(stagger));
                break;
            default: // pop
                total = sc * vis * Math.max(0, easeOutBack(stagger));
            }
            if (launched) {
                // the launched tile swells and fades while everything else shrinks away
                total *= 1 + (1 - clamp01(this._appear)) * 1.2;
                c.actor.opacity = Math.round(255 * clamp01(this._appear * 2.4));
            }

            if (wobble && (c.kind === 'app' || c.kind === 'folder') && !(drag && c === drag.cell))
                rot += ed.wobble * Math.sin(tt * 9 * ed.wobbleSpeed + c.ring * 1.9 + c.q * 0.8);

            // ---- ambient animation
            let fy = 0;
            if (ambient === 'breathe')
                total *= 1 + 0.018 * Math.sin(tt * 1.6 + c.ring * 0.5);
            else if (ambient === 'wave')
                total *= 1 + 0.035 * Math.sin(tt * 2.2 - d / 70);
            if (ambient === 'float' || ambient === 'both')
                fy = Math.sin(tt * 1.3 + c.ring * 0.8 + c.q * 0.6) * 3 * clamp01(this._appear) * vis;
            if (c.running && (ambient === 'pulse' || ambient === 'both')) {
                c.pulse = 0.5 + 0.5 * Math.sin(tt * 2.6);
                this._rp(c.area);
            } else if (c.pulse !== 1) {
                c.pulse = 1;
                this._rp(c.area);
            }

            c.sx = ccx + vx * k;
            c.sy = ccy + vy * k + fy;
            c.stot = total;
            if (drag && c === drag.cell) { // the lifted tile follows the pointer, a little larger and see-through
                drag.gx = c.sx;
                drag.gy = c.sy;
                drag.gs = total;
                c.sx = drag.x;
                c.sy = drag.y;
                total = Math.max(total, 0.9) * this._opts.edit.liftScale;
                c.stot = total;
                alpha = Math.min(alpha, this._opts.edit.liftOpacity);
            }

            // ---- 3D tilt toward the pointer (hovered tile only; eases back to flat)
            let tgtX = 0;
            let tgtY = 0;
            if (G.HOVER_STYLE === 'tilt' && this._animate && c === this._hovered && this._ptr && total > 0.2) {
                const rr = G.HEX_R * total;
                tgtY = clamp((this._ptr.x - c.sx) / rr, -1, 1) * 14;
                tgtX = -clamp((this._ptr.y - c.sy) / rr, -1, 1) * 14;
            }
            if (Math.abs(tgtX - c.tiltX) > 0.05 || Math.abs(tgtY - c.tiltY) > 0.05) {
                const ft = 1 - Math.exp(-14 * dt);
                c.tiltX += (tgtX - c.tiltX) * ft;
                c.tiltY += (tgtY - c.tiltY) * ft;
                moving = true;
            }

            // ---- liquid glass: light direction follows the pointer
            if (G.LIGHT_FOLLOW && G.TILE_STYLE === 'liquid' && c.kind !== 'empty') {
                let tx = DEFAULT_LIGHT[0];
                let ty = DEFAULT_LIGHT[1];
                if (this._ptr) {
                    const ddx = this._ptr.x - c.sx;
                    const ddy = this._ptr.y - c.sy;
                    const dist = Math.hypot(ddx, ddy);
                    const reach = clamp01(1 - dist / (3.4 * G.STEP));
                    if (dist > 1 && reach > 0) {
                        tx = DEFAULT_LIGHT[0] * (1 - reach) + (ddx / dist) * reach;
                        ty = DEFAULT_LIGHT[1] * (1 - reach) + (ddy / dist) * reach;
                        const n = Math.hypot(tx, ty) || 1;
                        tx /= n;
                        ty /= n;
                    }
                }
                if (Math.abs(tx - c.ld[0]) > 0.02 || Math.abs(ty - c.ld[1]) > 0.02) {
                    const fk = 1 - Math.exp(-12 * dt);
                    c.ld[0] += (tx - c.ld[0]) * fk;
                    c.ld[1] += (ty - c.ld[1]) * fk;
                    if (c.glass) {
                        // just swap to the nearest pre-rendered image: no cairo work at all
                        const gi = lightAngleIndex(c.ld[0], c.ld[1]);
                        if (gi !== c.glassIdx) {
                            const g = this._atlas.iconFor(gi);
                            if (g && g.index !== c.glassIdx) {
                                c.glass.gicon = g.icon;
                                c.glassIdx = g.index;
                            }
                        }
                    } else {
                        this._rp(c.area);
                    }
                    moving = true;
                }
            }

            // cull tiny / off-screen cells so they cost nothing in the scene graph
            if (total < 0.06 || c.sx < -G.BOX || c.sx > W + G.BOX || c.sy < -G.BOX || c.sy > H + G.BOX) {
                if (c.refrOn) {
                    c.refr.visible = false;
                    c.refrOn = false;
                }
                if (c.shown) {
                    c.actor.hide();
                    c.shown = false;
                }
                continue;
            }
            if (!c.shown) {
                c.actor.show();
                c.shown = true;
            }
            c.actor.set_position(c.sx - G.BOX / 2 + xoff, c.sy - G.BOX / 2 + yoff);
            c.actor.set_scale(total, total);
            if (c.refr)
                this._updateRefraction(c, total, xoff, yoff);

            // per-child opacity (cheaper than group opacity, which would render every tile off-screen)
            const qa = Math.round(alpha * 32) / 32;
            if (qa !== c.alpha) {
                c.alpha = qa;
                const o8 = Math.round(qa * 255);
                if (c.area)
                    c.area.opacity = o8;
                if (c.emptyIcon)
                    c.emptyIcon.opacity = o8;
                if (c.glass)
                    c.glass.opacity = o8;
                if (c.refr)
                    c.refr.opacity = o8;
                if (c.icon)
                    c.icon.opacity = o8;
                if (c.labelBin)
                    c.labelBin.opacity = o8;
            }
            const qr = Math.round(rot * 2) / 2;
            if (qr !== c.rot) {
                c.rot = qr;
                c.actor.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, qr);
            }
            const qy = Math.round((c.tiltY + flipY) * 2) / 2;
            if (qy !== c.rotY) {
                c.rotY = qy;
                c.actor.set_rotation_angle(Clutter.RotateAxis.Y_AXIS, qy);
            }
            const qx = Math.round(c.tiltX * 2) / 2;
            if (qx !== c.rotX) {
                c.rotX = qx;
                c.actor.set_rotation_angle(Clutter.RotateAxis.X_AXIS, qx);
            }
            if (c.label) {
                // captions fade out on the small outer cells instead of turning into unreadable specks
                const lo = G.LABELS === 'hover'
                    ? Math.round(clamp01(c.hover) * 16) / 16
                    : Math.round(clamp01((sc - 0.55) / 0.25) * 16) / 16;
                if (lo !== c.labelAlpha) {
                    c.labelAlpha = lo;
                    c.label.opacity = Math.round(lo * 255);
                    c.labelBin.visible = lo > 0;
                }
            }
        }

        const ptMap = this._perf ? GLib.get_monotonic_time() : 0;
        if (drag)
            this._resolveDragTarget(); // positions changed this frame (pan, glide): keep the drop ring and the dwell timer honest
        if (this._editLayer.visible)
            this._editLayer.queue_repaint();

        if (this._perf) {
            const pf = this._pf;
            const flags = [];
            if (this._closing)
                flags.push('closing');
            else if (this._appear < 0.999)
                flags.push('open-anim');
            if (drag)
                flags.push('lift');
            if (this._edit.grabbed)
                flags.push('carry');
            if (this._edit.active)
                flags.push('edit');
            if (this._dragging)
                flags.push('pan');
            if (this._query)
                flags.push('search');
            if (moving && !flags.length)
                flags.push('glide');
            if (pf.draws > pf.repaints) // paints nobody queued: the toolkit repainted them itself (map / style / size change)
                this._perf.reason('implicit-draws', pf.draws - pf.repaints);
            this._perf.frame({work: (GLib.get_monotonic_time() - pt0) / 1000, map: (ptMap - pt0) / 1000, flags, repaints: pf.repaints, draws: pf.draws, drawMs: pf.drawMs});
            pf.repaints = 0;
            pf.draws = 0;
            pf.drawMs = 0;
        }
        if (this._closing && this._appear < 0.04) {
            this._finishClose();
            return false;
        }
        this._idle = moving || this._dragging ? 0 : this._idle + 1;
        return this._idle <= 3;
    }

    // ------------------------------------------------------------------ hit testing
    /** Exact shape test; the topmost cell is the one with the smallest normalised distance. */
    _hit(px, py) {
        let best = null;
        let bd = 1e12;
        for (const c of this._cells) {
            if (c.kind === 'empty' || c.stot < 0.12)
                continue;
            const dx = (px - c.sx) / c.stot;
            const dy = (py - c.sy) / c.stot;
            if (shapeHit(G.SHAPE, G.HEX_R, dx, dy)) {
                const d = dx * dx + dy * dy;
                if (d < bd) {
                    bd = d;
                    best = c;
                }
            }
        }
        return best;
    }

    _local(event) {
        const [x, y] = event.get_coords();
        return [x - this._mon.x, y - this._mon.y];
    }

    // ------------------------------------------------------------------ pointer input
    // A press starts on the canvas; motion and release are handled on the root so a drag keeps working
    // (and always ends) even over the search bar or off the monitor. Any button pans when dragged;
    // without a drag: left = launch, right = context menu.
    // NB: Mutter 46+ no longer reports mouse-button state in event.get_state(), so we never rely on it.
    _onPress(event) {
        if (!this._open)
            return Clutter.EVENT_PROPAGATE;
        this._entry.grab_key_focus(); // keep "just type to search" working after any click
        this._kbdLock = null;
        const button = event.get_button();
        if (button !== BTN_LEFT && button !== BTN_MIDDLE && button !== BTN_RIGHT)
            return Clutter.EVENT_STOP;
        const [x, y] = this._local(event);
        this._pressCell(this._hit(x, y));
        this._press = {
            button, x, y,
            panX: this._panT.x, panY: this._panT.y,
            moved: false,
            vx: 0, vy: 0,
            lastX: 0, lastY: 0, lastT: GLib.get_monotonic_time(),
            tile: null, longTimer: 0, tileDrag: false, cancelled: false,
        };
        const hit = this._hit(x, y);
        if (this._edit.active && button === BTN_LEFT && hit && (hit.kind === 'app' || hit.kind === 'folder')) {
            // a press on a tile can become a lift: after moving past the threshold, or (touch) after holding still
            const p = this._press;
            p.tile = hit;
            p.longTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._opts.edit.longPressMs, this._safe(() => {
                p.longTimer = 0;
                if (this._press === p && !p.moved && this._open)
                    this._startTileDrag(hit, p.x, p.y);
                return GLib.SOURCE_REMOVE;
            }));
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._open)
            return Clutter.EVENT_PROPAGATE;
        const p = this._press;

        if (p) {
            const [x, y] = this._local(event);
            const ox = x - p.x;
            const oy = y - p.y;
            if (p.cancelled)
                return Clutter.EVENT_STOP; // Esc cancelled the lift: ignore the rest of this gesture
            if (p.tileDrag) {
                this._updateTileDrag(x, y, !!(event.get_state() & Clutter.ModifierType.SHIFT_MASK));
                return Clutter.EVENT_STOP;
            }
            if (!p.moved && p.tile && Math.hypot(ox, oy) > this._opts.edit.liftDistance && this._startTileDrag(p.tile, x, y)) {
                this._updateTileDrag(x, y, !!(event.get_state() & Clutter.ModifierType.SHIFT_MASK));
                return Clutter.EVENT_STOP;
            }
            if (!p.moved && !(p.tile && this._edit.active) && Math.hypot(ox, oy) > DRAG_THRESHOLD) { // (a press on a tile while editing waits to be lifted, it never pans)
                p.moved = true;
                this._pressCell(null);
                this._dragging = true;
                this._setHover(null);
                this._setCursor('grab');
                this._wake();
            }
            if (p.moved) {
                this._panT.x = p.panX - ox;
                this._panT.y = p.panY - oy;
                this._clampPan();
                // velocity estimate (low-pass) for the inertial fling on release
                const t = GLib.get_monotonic_time();
                const dts = (t - p.lastT) / 1e6;
                if (dts > 0.004) {
                    p.vx = p.vx * 0.6 + (-(ox - p.lastX) / dts) * 0.4;
                    p.vy = p.vy * 0.6 + (-(oy - p.lastY) / dts) * 0.4;
                    p.lastX = ox;
                    p.lastY = oy;
                    p.lastT = t;
                }
                this._wake();
            }
            return Clutter.EVENT_STOP;
        }

        if (this._menuCard)
            return Clutter.EVENT_PROPAGATE;
        // Ignore the search bar by geometry. (event.get_source() is not a reliable way to tell on newer
        // Mutter versions, and relying on it silently disabled all hover effects.)
        const [sx, sy] = event.get_coords();
        if (this._contains(this._entry, sx, sy))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = this._local(event);
        this._mouse = {x, y};
        if (this._kbdLock) {
            // keyboard navigation owns the highlight until the pointer really moves
            const lk = this._kbdLock;
            if (lk.x === null) {
                lk.x = x;
                lk.y = y;
                return Clutter.EVENT_STOP;
            }
            if (Math.hypot(x - lk.x, y - lk.y) < KBD_SLACK)
                return Clutter.EVENT_STOP;
            this._kbdLock = null;
        }
        this._ptr = {x, y};
        this._setHover(this._hit(x, y));
        if (G.LIGHT_FOLLOW || G.HOVER_STYLE === 'tilt')
            this._wake();
        return Clutter.EVENT_STOP;
    }

    /** Squish the tile under the pointer while a button is held (cleared with null). */
    _pressCell(cell) {
        if (this._pressedCell)
            this._pressedCell.tpress = 0;
        this._pressedCell = null;
        if (cell && G.PRESS && cell.kind !== 'empty') {
            cell.tpress = 1;
            this._pressedCell = cell;
        }
        this._wake();
    }

    /** Inverse-video hover: the caption switches to the contrast colour while its tile is filled with the accent. */
    _invertLabel(cell, on) {
        if (G.HOVER_FX !== 'invert' || !cell?.label)
            return;
        cell.label.set_style(on ? this._labelStyle(G.palette.accentFg, false) : this._labelStyle());
    }

    _setHover(cell) {
        if (cell === this._hovered)
            return;
        if (this._hovered) {
            this._hovered.thover = 0;
            this._invertLabel(this._hovered, false);
        }
        this._hovered = cell;
        if (cell) {
            cell.thover = 1;
            this._invertLabel(cell, true);
            if (G.HOVER_FX === 'shine' && this._animate)
                cell.shineT = 0;
            this._canvas.set_child_above_sibling(cell.actor, null); // grown cell overlaps its neighbours
        }
        if (!this._dragging)
            this._setCursor(cell ? 'pointer' : 'default');
        this._wake();
    }

    _onLeave() {
        if (this._press || !this._open)
            return Clutter.EVENT_PROPAGATE;
        if (!this._query)
            this._setHover(null);
        return Clutter.EVENT_PROPAGATE;
    }

    _endDrag(p) {
        if (!this._dragging)
            return;
        this._dragging = false;
        this._setCursor(this._hovered ? 'pointer' : 'default');
        const k = 0.16 * (this._opts?.inertia ?? 1); // a little inertia, then magnetise to the nearest hex
        this._panT.x += p.vx * k;
        this._panT.y += p.vy * k;
        this._clampPan();
        if (this._getBool('snap', true))
            this._snapToNearest();
        this._wake();
    }

    _onRelease(event) {
        const p = this._press;
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        const button = event.get_button();
        if (button !== p.button)
            return Clutter.EVENT_STOP;
        this._press = null;
        this._pressCell(null);
        this._clearLongPress(p);
        if (!this._open)
            return Clutter.EVENT_STOP;

        if (p.cancelled)
            return Clutter.EVENT_STOP;
        if (p.tileDrag) {
            const [dx, dy] = this._local(event);
            this._finishTileDrag(dx, dy, !!(event.get_state() & Clutter.ModifierType.SHIFT_MASK));
            return Clutter.EVENT_STOP;
        }
        if (p.moved) {
            this._endDrag(p);
            return Clutter.EVENT_STOP;
        }
        const [x, y] = this._local(event);

        if (button === BTN_RIGHT) {
            const c = this._hit(p.x, p.y);
            if (c)
                this._showCellMenu(c, p.x, p.y);
            return Clutter.EVENT_STOP;
        }
        if (button === BTN_LEFT) {
            // a click only counts if press and release landed on the same cell
            const c = this._hit(x, y);
            if (c !== this._hit(p.x, p.y))
                return Clutter.EVENT_STOP;
            if (!c) {
                if (!this._edit.active)        // while editing, a stray click must not throw the work away
                    this.close();
            } else
                this._activateCell(c);
        } else if (button === BTN_MIDDLE && this._opts?.middleNew) {
            const c = this._hit(x, y);
            if (c && c === this._hit(p.x, p.y))
                this._newWindow(c);
        }
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        if (!this._open)
            return Clutter.EVENT_PROPAGATE;
        let dx = 0;
        let dy = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: dy = -1; break;
        case Clutter.ScrollDirection.DOWN: dy = 1; break;
        case Clutter.ScrollDirection.LEFT: dx = -1; break;
        case Clutter.ScrollDirection.RIGHT: dx = 1; break;
        case Clutter.ScrollDirection.SMOOTH:
            [dx, dy] = event.get_scroll_delta();
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        const sp = 70 * (this._opts?.scrollSpeed ?? 1);
        this._panT.x += dx * sp;
        this._panT.y += dy * sp;
        this._clampPan();
        this._removeSnapTimer();
        this._snapSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 240, () => {
            this._snapSource = 0;
            try {
                if (this._open)
                    this._snapToNearest();
            } catch (e) {
                console.error(`${LOG} snap failed: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._wake();
        return Clutter.EVENT_STOP;
    }

    _removeSnapTimer() {
        if (this._snapSource) {
            GLib.source_remove(this._snapSource);
            this._snapSource = 0;
        }
    }

    // ------------------------------------------------------------------ keyboard
    //   arrows         move the highlight to the neighbouring tile (the Hive pans to keep it centred)
    //   Ctrl/Shift+arrows, PgUp/PgDn   leap several tiles;  Home / End   first / last;  Tab / Shift+Tab   next / previous
    //   Enter          open (folder: step inside);  Shift+Enter new window;  Ctrl+Enter / Menu   app menu;  Alt+Enter details
    //   Backspace / Esc   leave a folder (Esc: clears the search first);  F1 key help;  F2 / Shift+F2 centre widget
    // With text in the search field, Left/Right/Home/End keep editing the text and Up/Down move through the results.
    _onKey(event) {
        if (!this._open)
            return Clutter.EVENT_PROPAGATE;
        const sym = event.get_key_symbol();

        // while the context menu is open, arrows move between its items
        if (this._menuCard) {
            if (sym === Clutter.KEY_Escape) {
                this._closeMenu();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Up || sym === Clutter.KEY_Down) {
                const dir = sym === Clutter.KEY_Up ? St.DirectionType.TAB_BACKWARD : St.DirectionType.TAB_FORWARD;
                this._menuCard.navigate_focus(global.stage.key_focus, dir, true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        // naming a folder: the field is a plain text editor, only Esc is ours (Enter reaches the field's `activate`)
        if (this._prompt) {
            if (sym === Clutter.KEY_Escape) {
                this._cancelPrompt();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        const hasText = this._query.length > 0; // (not get_text(): St.Entry may report its placeholder as text)
        const state = event.get_state();
        const ctrl = !!(state & Clutter.ModifierType.CONTROL_MASK);
        const shift = !!(state & Clutter.ModifierType.SHIFT_MASK);
        const alt = !!(state & Clutter.ModifierType.MOD1_MASK);
        const leap = ctrl || shift ? LEAP_STEPS : 1;
        const stop = () => Clutter.EVENT_STOP;

        if (this._custom && !hasText && ctrl && (sym === Clutter.KEY_z || sym === Clutter.KEY_Z)) {
            this._undoLayout(shift ? 1 : -1);
            return stop();
        }

        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._help)
                this._setHelp(false);
            else if (hasText)
                this._entry.set_text('');
            else if (this._edit.drag)
                this._cancelTileDrag();
            else if (this._edit.grabbed)
                this._editRelease();
            else if (this._edit.active)
                this._leaveEdit();
            else if (this._folder)
                this._leaveFolder(true);
            else
                this.close();
            return stop();
        case Clutter.KEY_BackSpace:
            if (hasText || !this._folder)
                return Clutter.EVENT_PROPAGATE;
            if (this._edit.grabbed) { // carrying a tile inside a folder: Backspace takes it out
                this._applyDrop(this._edit.grabbed, {kind: 'out'});
                return stop();
            }
            this._leaveFolder(true);
            return stop();
        case Clutter.KEY_Up:
            this._navigate(0, -1, leap);
            return stop();
        case Clutter.KEY_Down:
            this._navigate(0, 1, leap);
            return stop();
        case Clutter.KEY_Left:
            if (hasText)
                return Clutter.EVENT_PROPAGATE; // caret movement
            this._navigate(-1, 0, leap);
            return stop();
        case Clutter.KEY_Right:
            if (hasText)
                return Clutter.EVENT_PROPAGATE;
            this._navigate(1, 0, leap);
            return stop();
        case Clutter.KEY_Page_Up:
            this._navigate(0, -1, PAGE_STEPS);
            return stop();
        case Clutter.KEY_Page_Down:
            this._navigate(0, 1, PAGE_STEPS);
            return stop();
        case Clutter.KEY_Home:
        case Clutter.KEY_End: {
            if (hasText)
                return Clutter.EVENT_PROPAGATE; // caret movement
            const order = this._navOrder();
            this._focusCell(sym === Clutter.KEY_Home ? order[0] : order[order.length - 1]);
            return stop();
        }
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            const back = sym === Clutter.KEY_ISO_Left_Tab || shift;
            const h = this._hovered;
            this._focusCell(cycle(this._navOrder(), h, back ? -1 : 1));
            return stop();
        }
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter: {
            if (this._edit.active && !hasText && !ctrl && !alt) { // editing: Enter swaps, Shift+Enter makes a folder (never launches)
                if (this._edit.grabbed)
                    this._editDropCarried(shift);
                else if (this._focused())
                    this._activateCell(this._focused());
                return stop();
            }
            if (!ctrl && !alt && !shift)
                return Clutter.EVENT_PROPAGATE; // plain Enter: the search field's `activate` handler
            const c = this._focused();
            if (!c)
                return stop();
            if (ctrl)
                this._showCellMenu(c, c.sx, c.sy, true);
            else if (alt)
                this._detailsFor(c);
            else
                this._newWindow(c);
            return stop();
        }
        case Clutter.KEY_F1:
            this._setHelp(!this._help);
            return stop();
        case Clutter.KEY_F2:
            this._cycleWidget(shift ? -1 : 1);
            return stop();
        case Clutter.KEY_F3:
            this._cycleFolderMode(shift ? -1 : 1);
            return stop();
        case Clutter.KEY_F4:
            this._toggleEdit();
            return stop();
        case Clutter.KEY_space:
            if (!this._edit.active || hasText)
                return Clutter.EVENT_PROPAGATE; // a search character
            if (this._edit.grabbed)
                this._editRelease();
            else
                this._editGrab();
            return stop();
        case Clutter.KEY_r:
        case Clutter.KEY_R: {
            const h = this._hovered;
            if (!ctrl || hasText || !this._custom || h?.kind !== 'folder')
                return Clutter.EVENT_PROPAGATE;
            this._renameFolderPrompt(h);
            return stop();
        }
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete: {
            const h = this._hovered;
            if (hasText || !this._custom || h?.kind !== 'folder')
                return Clutter.EVENT_PROPAGATE;
            this._confirmDeleteFolder(h, h.sx, h.sy);
            return stop();
        }
        case Clutter.KEY_Menu:
        case Clutter.KEY_F10: {
            if (sym === Clutter.KEY_F10 && !shift)
                return Clutter.EVENT_PROPAGATE;
            const c = this._focused() ?? this._navigate(0, 0);
            if (c)
                this._showCellMenu(c, c.sx, c.sy, true);
            return stop();
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /** The tile that Enter / the menu key act on: the highlighted one, else the best search match. */
    _focused() {
        const h = this._hovered;
        if (h && h.kind !== 'empty' && h.tvis >= 0.5)
            return h;
        return this._results[0] ?? null;
    }

    /** Tiles that are currently on the lattice, in reading order (best match / most used first). */
    _navOrder() {
        const v = this._order.filter(c => c.tvis >= 0.5);
        if (this._edit.grabbed && this._custom && this._getString('custom-policy', 'packed') === 'free') {
            for (const c of this._cells) { // Free: the carried tile can also be moved onto an empty slot
                if (c.kind === 'empty' && c.slot && c.tvis >= 0.5)
                    v.push(c);
            }
        }
        return v;
    }

    /**
     * Move the highlight `steps` tiles in a direction ((0, 0) = just make sure something is highlighted)
     * and pan so it sits in the centre. Returns the highlighted cell.
     */
    _navigate(dx, dy, steps = 1) {
        const cands = this._navOrder();
        if (cands.length === 0)
            return null;
        const cur = cands.includes(this._hovered) ? this._hovered : null;
        let next = null;
        if (!cur)
            next = nearestTo(cands, this._panT.x, this._panT.y); // first key press: whatever is nearest the centre
        else if (dx === 0 && dy === 0)
            next = cur;
        else
            next = steps > 1 ? leapFrom(cands, cur, dx, dy, steps) : stepFrom(cands, cur, dx, dy);
        if (next)
            this._focusCell(next);
        return next ?? cur;
    }

    /** Highlight `cell` from the keyboard and pan the Hive to it. */
    _focusCell(cell) {
        if (!cell)
            return;
        this._kbdLock = {x: this._mouse?.x ?? null, y: this._mouse?.y ?? null};
        this._removeSnapTimer();
        this._setHover(cell);
        // the lit tile ends up in the centre, so light / tilt aim there rather than at the resting pointer
        this._ptr = {x: this._W / 2, y: this._H / 2 + this._barShift};
        this._panT.x = cell.tx;
        this._panT.y = cell.ty;
        this._clampPan();
        this._wake();
    }

    _setHelp(on) {
        this._help = on;
        this._updateHint();
    }

    /** The footer line: the short reminder, the F1 cheat-sheet, or where you are inside a folder. */
    _updateHint() {
        let text = this._help ? HINT_KEYS : this._custom ? HINT_CUSTOM : HINT_SHORT;
        if (!this._help && this._folder) {
            const name = this._folderCells.get(this._folder)?.entry.name ?? 'Folder';
            text = `${name}  ·  Backspace or Esc to go back  ·  Type to search every app  ·  F1 keys`;
        }
        if (!this._help && this._edit.active) {
            text = HINT_EDIT;
            const g = this._edit.grabbed;
            if (g) {
                const nm = g.entry?.name ?? 'tile';
                text = `Carrying ${nm}  ·  arrows to move  ·  Enter swap  ·  Shift+Enter make folder${this._folder ? '  ·  Backspace take out' : ''}  ·  Esc cancel`;
            }
        }
        if (!this._help && this._flashText)
            text = this._flashText;
        if (this._prompt)
            text = `${this._prompt.title}  ·  Enter to confirm  ·  Esc to cancel`;
        this._hint.set_text(text);
        this._hint.visible = this._help || !!this._flashText || !!this._prompt || this._edit.active || (this._opts?.hints ?? true);
    }

    /** Show a short status message in the footer for a moment. */
    _flash(text, ms = 2600) {
        this._flashText = text;
        if (this._flashSource)
            GLib.source_remove(this._flashSource);
        this._flashSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._flashSource = 0;
            this._flashText = '';
            this._updateHint();
            return GLib.SOURCE_REMOVE;
        });
        this._updateHint();
    }

    /** F3 / Shift+F3 (and the centre-tile menu): switch between a flat lattice, category folders and GNOME's folders. */
    _cycleFolderMode(dir) {
        if (!this._hasKey('group-mode'))
            return;
        const ids = FOLDER_MODES.map(m => m[0]);
        const i = Math.max(0, ids.indexOf(this._getString('group-mode', 'none')));
        this._setGroupMode(ids[(i + dir + ids.length) % ids.length]);
    }

    _setGroupMode(id) {
        if (this._hasKey('group-mode'))
            this._settings.set_string('group-mode', id);
    }

    /** Confirm a folder-mode change in the footer (also when it was changed from the preferences window). */
    _announceFolders() {
        const mode = this._getString('group-mode', 'none');
        let text = `Folders: ${FOLDER_MODES.find(m => m[0] === mode)?.[1] ?? mode}`;
        if (mode !== 'none' && mode !== 'custom' && this._folderCells.size === 0)
            text += mode === 'gnome' ? '  ·  no GNOME app folders found' : '  ·  not enough apps share a category';
        this._flash(text);
    }

    /** F2 / Shift+F2: switch the centre tile to the next / previous widget. */
    _cycleWidget(dir) {
        if (!this._hasKey('center-widget'))
            return;
        const ids = WIDGETS.map(w => w[0]);
        const i = Math.max(0, ids.indexOf(this._getString('center-widget', 'logo')));
        this._setWidget(ids[(i + dir + ids.length) % ids.length]);
    }

    // ------------------------------------------------------------------ launching
    /** What a click / Enter on a tile does. */
    _activateCell(cell) {
        if (this._edit.active) { // editing never launches anything
            if (cell.kind === 'folder')
                this._openFolder(cell.entry.id);
            else if (cell.kind === 'logo' && this._folder)
                this._leaveFolder(true);
            else if (cell.kind === 'app')
                this._flash('Editing: drag a tile to move it, or press Done');
            return;
        }
        if (cell.kind === 'app')
            this._launch(cell);
        else if (cell.kind === 'folder')
            this._openFolder(cell.entry.id);
        else if (cell.kind === 'logo')
            this._logoClick();
    }

    /** The centre tile steps back out of a folder; otherwise it does what its widget does. */
    _logoClick() {
        if (this._folder)
            this._leaveFolder(true);
        else
            this._widgetClick();
    }

    /** Step into a folder tile: its apps burst out of the tile and the lattice re-forms around them. */
    _openFolder(id) {
        const f = this._folderCells.get(id);
        if (!f || this._query)
            return;
        this._folder = id;
        for (const m of f.members) {
            m.lx = f.tx;
            m.ly = f.ty;
            m.vis = 0;
        }
        this._applyLayout();
        this._updateHint();
        this._wake();
    }

    /** Back to the root level. With `viaKey` the folder we came out of is highlighted so navigation continues there. */
    _leaveFolder(viaKey = false) {
        if (!this._folder)
            return;
        const f = this._folderCells.get(this._folder);
        this._folder = null;
        if (f) {
            for (const m of f.members) { // the apps fly back into the folder tile as they fade out
                m.tx = f.tx;
                m.ty = f.ty;
            }
        }
        this._applyLayout();
        this._updateHint();
        if (f && viaKey)
            this._focusCell(f);
        this._wake();
    }

    _newWindow(cell) {
        if (cell?.kind !== 'app')
            return;
        const app = cell.entry.app;
        this._noteRecent(cell.entry.id);
        this.close();
        try {
            if (app.can_open_new_window())
                app.open_new_window(-1);
            else
                app.activate();
        } catch (e) {
            console.error(`${LOG} new window failed: ${e}`);
        }
    }

    _detailsFor(cell) {
        if (cell?.kind !== 'app' || !Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop'))
            return;
        this.close();
        this._showDetails(cell.entry.id);
    }

    _launch(cell) {
        const app = cell.entry.app;
        this._noteRecent(cell.entry.id);
        this._launchCell = cell;
        this.close(); // drop the grab first so the launched window can take focus
        try {
            app.activate();
        } catch (e) {
            console.error(`${LOG} launch failed: ${e}`);
        }
    }

    // ------------------------------------------------------------------ context menu
    _showCellMenu(cell, x, y, focusFirst = false) {
        if (cell.kind === 'folder') {
            const n = cell.members.filter(m => !m.hiddenApp).length;
            const items = [
                {label: 'Open folder', icon: 'folder-open-symbolic', onClick: () => this._openFolder(cell.entry.id)},
                {label: `${n} app${n === 1 ? '' : 's'}`, text: true},
            ];
            if (this._custom) {
                items.push(
                    {sep: true},
                    {label: 'Rename…', icon: 'document-edit-symbolic', onClick: () => this._renameFolderPrompt(cell)},
                    {label: 'Delete folder…', icon: 'user-trash-symbolic', danger: true, onClick: () => this._confirmDeleteFolder(cell, x, y)});
            }
            this._openMenu(items, x, y, cell.entry.name, null, focusFirst);
            return;
        }
        if (cell.kind === 'logo') {
            const items = [];
            if (this._folder) {
                items.push(
                    {label: 'Back to all apps', icon: 'go-previous-symbolic', onClick: () => this._leaveFolder(true)},
                    {sep: true});
            }
            items.push({label: 'Centre tile', text: true});
            if (G.WIDGET === 'media') {
                items.push(
                    {label: 'Play / Pause', icon: 'media-playback-start-symbolic', onClick: () => this._widgets.playPause()},
                    {label: 'Next track', icon: 'media-skip-forward-symbolic', onClick: () => this._widgets.next()},
                    {label: 'Previous track', icon: 'media-skip-backward-symbolic', onClick: () => this._widgets.previous()},
                    {sep: true});
            }
            for (const [id, label] of WIDGETS) {
                items.push({
                    label,
                    icon: id === G.WIDGET ? 'object-select-symbolic' : undefined,
                    onClick: () => this._setWidget(id),
                });
            }
            items.push({sep: true}, {label: 'Folders (F3)', text: true});
            const mode = this._getString('group-mode', 'none');
            for (const [id, label] of FOLDER_MODES) {
                items.push({
                    label,
                    icon: id === mode ? 'object-select-symbolic' : undefined,
                    onClick: () => this._setGroupMode(id),
                });
            }
            items.push({sep: true});
            items.push({
                label: this._edit.active ? 'Done editing (F4)' : 'Edit layout (F4)', icon: 'document-edit-symbolic',
                onClick: () => this._toggleEdit(),
            });
            if (this._custom && this._layout) {
                const policy = this._getString('custom-policy', 'packed');
                items.push({label: 'My custom layout', text: true});
                if (this._undo.canUndo)
                    items.push({label: 'Undo (Ctrl+Z)', icon: 'edit-undo-symbolic', onClick: () => this._undoLayout(-1)});
                if (this._undo.canRedo)
                    items.push({label: 'Redo (Ctrl+Shift+Z)', icon: 'edit-redo-symbolic', onClick: () => this._undoLayout(1)});
                items.push(
                    {label: policy === 'packed' ? 'Arrangement: Packed (no gaps) - switch to Free' : 'Arrangement: Free (gaps allowed) - switch to Packed',
                        icon: 'view-grid-symbolic', onClick: () => this._setPolicy(policy === 'packed' ? 'free' : 'packed')});
                if (policy === 'free') {
                    items.push({label: 'Tidy up (close all gaps)', icon: 'edit-clear-all-symbolic',
                        onClick: () => this._editLayout((env, l) => LY.tidy(env, l), 'Tidied up')});
                }
                items.push(
                    {label: 'New folder…', icon: 'folder-new-symbolic', onClick: () => this._askName('New folder name', 'New folder',
                        name => this._editLayout((env, l) => LY.newEmptyFolder(env, l, name), `Folder “${LY.normName(name)}” created`))},
                    {label: 'Copy the current automatic order here', icon: 'view-refresh-symbolic', onClick: () => this._resnapshot()},
                    {label: 'Reset layout…', icon: 'user-trash-symbolic', danger: true, onClick: () => this._confirmResetLayout(x, y)},
                    {label: `Return to “${FOLDER_MODES.find(m => m[0] === this._autoMode)?.[1] ?? this._autoMode}”`, icon: 'go-previous-symbolic',
                        onClick: () => this._setGroupMode(this._autoMode)});
            }
            items.push({sep: true});
            if (this._hidden.size > 0) {
                items.push({
                    label: `Unhide ${this._hidden.size} hidden app${this._hidden.size === 1 ? '' : 's'}`,
                    icon: 'view-reveal-symbolic',
                    onClick: () => {
                        this._hidden.clear();
                        this._saveHidden();
                        this._refresh(true);
                    },
                });
            }
            items.push({label: 'Close', icon: 'window-close-symbolic', onClick: () => this.close()});
            this._openMenu(items, x, y, null, null, focusFirst);
            return;
        }
        if (cell.kind !== 'app')
            return;

        const {app, id, name} = cell.entry;
        const favs = AppFavorites.getAppFavorites();
        const isFav = favs.isFavorite(id);
        const running = app.get_state() === Shell.AppState.RUNNING;

        const items = [
            {label: running ? 'Show' : 'Open', icon: 'media-playback-start-symbolic', onClick: () => this._launch(cell)},
        ];
        if (running && app.can_open_new_window()) {
            items.push({
                label: 'New Window',
                icon: 'window-new-symbolic',
                onClick: () => {
                    this._noteRecent(id);
                    this.close();
                    app.open_new_window(-1);
                },
            });
        }
        // one entry per open window (the old Hive listed Hyprland clients here)
        let windows = [];
        try {
            windows = app.get_windows().slice(0, 6);
        } catch (_e) { /* app not running */ }
        if (windows.length > 0) {
            items.push({sep: true});
            for (const w of windows) {
                items.push({
                    label: w.get_title() || name,
                    icon: 'focus-windows-symbolic',
                    onClick: () => {
                        this._noteRecent(id);
                        this.close();
                        Main.activateWindow(w);
                    },
                });
            }
        }
        items.push({sep: true});
        items.push({
            // "favorites" are what the dash / dock (Dash to Dock, Ubuntu Dock, …) shows as pinned apps
            label: isFav ? 'Unpin from Dock' : 'Pin to Dock',
            icon: 'view-pin-symbolic',
            onClick: () => {
                if (isFav)
                    favs.removeFavorite(id);
                else
                    favs.addFavorite(id);
                if (this._getString('sort-mode', 'frequency') === 'favorites')
                    this._refresh(true);
            },
        });
        if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop')) {
            items.push({
                label: 'Show Details',
                icon: 'help-about-symbolic',
                onClick: () => {
                    this.close();
                    this._showDetails(id);
                },
            });
        }
        if (this._custom && !this._query) {
            items.push({sep: true});
            items.push({label: 'Move to folder…', icon: 'folder-symbolic', onClick: () => this._moveToFolderMenu(cell, x, y)});
            if (cell.group) {
                items.push({
                    label: 'Remove from folder', icon: 'go-up-symbolic',
                    onClick: () => this._editLayout((env, l) => LY.removeFromFolder(env, l, cell.group, id), 'Moved out of the folder'),
                });
            }
        }
        items.push({sep: true});
        items.push({
            label: cell.hiddenApp ? 'Show in the Hive again' : 'Hide from the Hive',
            icon: cell.hiddenApp ? 'view-reveal-symbolic' : 'view-conceal-symbolic',
            danger: !cell.hiddenApp,
            onClick: () => {
                if (cell.hiddenApp)
                    this._hidden.delete(id);
                else
                    this._hidden.add(id);
                this._saveHidden();
                this._refresh(true);
            },
        });
        this._openMenu(items, x, y, name, app.get_icon(), focusFirst);
    }

    // ------------------------------------------------------------------ centre-tile widgets
    _setWidget(id) {
        if (this._hasKey('center-widget'))
            this._settings.set_string('center-widget', id);
    }

    /** What clicking the centre tile does: the logo closes the Hive; widgets act on their subject. */
    _widgetClick() {
        const launch = ids => {
            const sys = Shell.AppSystem.get_default();
            for (const id of ids) {
                const app = sys.lookup_app(id);
                if (app) {
                    this.close();
                    app.activate();
                    return true;
                }
            }
            return false;
        };
        switch (G.WIDGET) {
        case 'logo':
            this.close();
            break;
        case 'media':
            this._widgets.playPause();
            break;
        case 'clock':
        case 'analog':
            launch(['org.gnome.clocks.desktop']);
            break;
        case 'calendar':
            launch(['org.gnome.Calendar.desktop']);
            break;
        case 'system':
            launch(['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop']);
            break;
        default:
            break;
        }
    }

    _startWidgetTimer() {
        this._stopWidgetTimer();
        if (G.WIDGET === 'logo' || !this._open)
            return;
        this._timed('widgetUpdate', () => this._updateWidget()); // one reading so the tile is never empty
        if (this._opts?.tierWidgets === false || this._ambientPaused)
            return; // lite tier / machine busy: no 1 Hz timer, the widget keeps its first reading
        this._widgetTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            try {
                this._timed('widgetUpdate', () => this._updateWidget());
            } catch (e) {
                console.error(`${LOG} widget update failed: ${e}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWidgetTimer() {
        if (this._widgetTimer) {
            GLib.source_remove(this._widgetTimer);
            this._widgetTimer = 0;
        }
    }

    _updateWidget() {
        if (!this._open)
            return;
        this._widgets.update(G.WIDGET, G.WIDGET_DATA, this._clock24);
        this._rp(this._cells[0]?.area);
    }

    _showDetails(id) {
        try {
            const args = GLib.Variant.new_tuple([GLib.Variant.new_string(id), GLib.Variant.new_string('')]);
            Gio.DBus.session.call(
                'org.gnome.Software', '/org/gnome/Software', 'org.gtk.Actions', 'Activate',
                new GLib.Variant('(sava{sv})', ['details', [args], {}]),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (e) {
            console.warn(`${LOG} could not open GNOME Software: ${e}`);
        }
    }

    /**
     * Context menu. The card is made of St.Buttons (for styling and keyboard activation), but mouse and
     * touch input is resolved by hand in _onCaptured(): it hit-tests the items itself instead of relying on
     * St.Button's press/release/hover tracking, which proved unreliable under the Hive's modal grab.
     *
     * @param {Array<{label:string, icon?:string, onClick?:Function, danger?:boolean, sep?:boolean, text?:boolean}>} items
     */
    _openMenu(items, x, y, title = null, gicon = null, focusFirst = false) {
        this._timed('openMenu', () => this._openMenuInner(items, x, y, title, gicon, focusFirst));
    }

    _openMenuInner(items, x, y, title, gicon, focusFirst) {
        this._closeMenu();
        this._setHover(null);
        this._setCursor('default');

        const card = new St.BoxLayout({style_class: 'hive-menu', orientation: Clutter.Orientation.VERTICAL, reactive: true});
        const P = G.palette;
        if (G.CHROME === 'glass') {
            card.set_style(
                `background-gradient-direction: vertical; ` +
                `background-gradient-start: ${P.dark ? 'rgba(74, 78, 98, 0.66)' : 'rgba(255, 255, 255, 0.86)'}; ` +
                `background-gradient-end: ${P.dark ? 'rgba(30, 32, 44, 0.78)' : 'rgba(240, 242, 248, 0.78)'}; ` +
                `border-color: rgba(255, 255, 255, ${P.dark ? 0.34 : 0.8}); color: ${rgba(P.fg, 1)};`);
        } else {
            card.set_style(`background-color: ${rgba(P.surface, 0.97)}; border-color: ${rgba(P.fg, 0.14)}; color: ${rgba(P.fg, 1)};`);
        }
        this._menuItems = [];
        this._menuPress = null;

        if (title) {
            const head = new St.BoxLayout({style_class: 'hive-menu-head'});
            if (gicon)
                head.add_child(new St.Icon({gicon, icon_size: 28, style_class: 'hive-menu-head-icon'}));
            const l = new St.Label({text: title, style_class: 'hive-menu-title', y_align: Clutter.ActorAlign.CENTER});
            l.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            head.add_child(l);
            card.add_child(head);
        }

        for (const it of items) {
            if (it.sep) {
                const sep = new St.Widget({style_class: 'hive-menu-sep'});
                sep.set_style(`background-color: ${rgba(P.fg, 0.12)};`);
                card.add_child(sep);
                continue;
            }
            if (it.text) {
                const l = new St.Label({text: it.label, style_class: 'hive-menu-text'});
                l.set_style(`color: ${rgba(P.fg, 0.65)};`);
                l.clutter_text.set_line_wrap(true);
                card.add_child(l);
                continue;
            }
            const b = new St.Button({style_class: 'hive-menu-item', can_focus: true, x_expand: true});
            const entry = {b, hl: false, run: null, paint: null};
            const tint = it.danger ? DANGER : P.accent;
            entry.paint = () => b.set_style(
                `color: ${rgba(it.danger ? DANGER : P.fg, 1)}; ` +
                `background-color: ${rgba(tint, entry.hl || b.has_key_focus() ? 0.24 : 0)};`);
            entry.paint();
            b.connect('key-focus-in', entry.paint);
            b.connect('key-focus-out', entry.paint);
            const row = new St.BoxLayout({style_class: 'hive-menu-row'});
            if (it.icon)
                row.add_child(new St.Icon({icon_name: it.icon, icon_size: 16, style_class: 'hive-menu-icon'}));
            row.add_child(new St.Label({text: it.label, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
            b.set_child(row);
            // one activation path for mouse, touch and keyboard (Enter on a focused item emits 'clicked')
            entry.run = this._safe(() => {
                this._closeMenu();
                it.onClick?.();
            });
            b.connect('clicked', entry.run);
            card.add_child(b);
            this._menuItems.push(entry);
        }

        this._menuCard = card;
        this._menuLayer.add_child(card);
        this._menuLayer.show();

        // keep the card fully on screen
        const [, , natW, natH] = card.get_preferred_size();
        card.set_position(
            Math.round(clamp(x, 8, Math.max(8, this._W - natW - 8))),
            Math.round(clamp(y, 8, Math.max(8, this._H - natH - 8))));
        if (G.MENU_ANIM && this._animate) {
            try {
                card.set_pivot_point(0.1, 0);
                card.set_opacity(0);
                card.set_scale(0.94, 0.94);
                card.translation_y = 6;
                card.ease({
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    translation_y: 0,
                    duration: 140,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } catch (_e) {
                card.set_opacity(255);
            }
        }
        if (focusFirst)
            card.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    /** Is the stage point (x, y) inside `actor`, taking its current transform into account? */
    _contains(actor, x, y) {
        try {
            const r = actor.get_transformed_extents();
            return x >= r.origin.x && y >= r.origin.y &&
                x <= r.origin.x + r.size.width && y <= r.origin.y + r.size.height;
        } catch (_e) {
            const [ok, lx, ly] = actor.transform_stage_point(x, y);
            const [w, h] = actor.get_size();
            return ok && lx >= 0 && ly >= 0 && lx <= w && ly <= h;
        }
    }

    _itemAt(x, y) {
        return this._menuItems.find(i => this._contains(i.b, x, y)) ?? null;
    }

    _setMenuHover(item) {
        for (const i of this._menuItems) {
            const hl = i === item;
            if (i.hl !== hl) {
                i.hl = hl;
                i.paint();
            }
        }
    }

    /**
     * Capture-phase handler for the whole overlay while a menu is open:
     *  - motion highlights the item under the pointer
     *  - a press outside the card dismisses the menu (and is swallowed)
     *  - press + release on the same item activates it
     */
    _onCaptured(event) {
        if (!this._menuCard)
            return Clutter.EVENT_PROPAGATE;
        const T = Clutter.EventType;
        const t = event.type();
        if (t !== T.MOTION && t !== T.BUTTON_PRESS && t !== T.BUTTON_RELEASE &&
            t !== T.TOUCH_BEGIN && t !== T.TOUCH_END && t !== T.TOUCH_UPDATE)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        if (t === T.MOTION || t === T.TOUCH_UPDATE) {
            this._setMenuHover(this._itemAt(x, y));
            return Clutter.EVENT_PROPAGATE;
        }

        if (t === T.BUTTON_PRESS || t === T.TOUCH_BEGIN) {
            if (!this._contains(this._menuCard, x, y)) {
                this._closeMenu();
                return Clutter.EVENT_STOP; // the click only dismisses the menu
            }
            const btn = t === T.TOUCH_BEGIN ? BTN_LEFT : event.get_button();
            this._menuPress = btn === BTN_LEFT ? this._itemAt(x, y) : null;
            this._setMenuHover(this._menuPress);
            return Clutter.EVENT_STOP;
        }

        // release
        const pressed = this._menuPress;
        this._menuPress = null;
        const item = this._itemAt(x, y);
        if (pressed && item === pressed)
            item.run();
        return Clutter.EVENT_STOP;
    }

    _closeMenu() {
        if (!this._menuCard)
            return;
        const card = this._menuCard;
        this._menuCard = null;
        this._menuItems = [];
        this._menuPress = null;
        this._menuLayer.hide();
        card.destroy();
        if (this._open)
            this._entry.grab_key_focus();
    }
}

