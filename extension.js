// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hive Launcher — a honeycomb app launcher for GNOME Shell 45 – 51.
//
//   * hexagon / circle / rounded / diamond / octagon tiles on a honeycomb or square-grid lattice
//   * fisheye lens: tiles grow towards the centre of the screen and shrink towards the rim
//   * drag (any button) or scroll to pan, or drive it entirely from the keyboard (arrows, Tab, Home/End,
//     Enter, Menu key; F1 lists every key), just type to search
//   * right-click for an app menu (windows, favourites, details, hide)
//   * optional folder tiles (by category, or GNOME's own app folders), a "recently opened" order,
//     and a centre tile that can show a clock, system load, battery or the track that is playing
//
// This file only wires the extension into the shell (shortcut, panel button, settings);
// the launcher itself lives in hive.js, geometry/drawing in shapes.js, option lists in options.js.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {HiveOverlay} from './hive.js';

const LOG = '[hive-launcher]';

export default class HiveLauncherExtension extends Extension {
    enable() {
        this._settings = null;
        this._indicator = null;
        this._keybindingAdded = false;
        this._settingsId = 0;
        this._previewId = 0;
        this._editId = 0;
        this._gridPatched = false;
        this._gridUndo = [];
        this._gridSignals = [];
        this._gridTimers = new Set();
        this._gridId = 0;
        this._intercepting = false;
        this._prewarmId = 0;

        // The schema only exists once the extension has been packed/installed correctly; if it is missing
        // we still run (panel button only, defaults for everything) rather than failing to enable.
        try {
            this._settings = this.getSettings();
        } catch (e) {
            console.warn(`${LOG} settings schema unavailable, using defaults: ${e}`);
        }

        this._hive = new HiveOverlay(this._settings);
        this._hive.envInfo = {shellVersion: Config.PACKAGE_VERSION, version: this.metadata?.['version-name'] ?? '?'}; // only shown in the perf report

        if (this._hasKey('toggle-hive')) {
            try {
                Main.wm.addKeybinding(
                    'toggle-hive',
                    this._settings,
                    Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                    Shell.ActionMode.NORMAL,
                    () => this._hive?.toggle());
                this._keybindingAdded = true;
            } catch (e) {
                console.warn(`${LOG} could not bind shortcut: ${e}`);
            }
        }

        if (this._hasKey('show-panel-icon'))
            this._settingsId = this._settings.connect('changed::show-panel-icon', () => this._syncIndicator());
        this._syncIndicator();

        // optionally take over GNOME's application grid (dock "Show Applications" button, Super+A)
        if (this._hasKey('replace-app-grid')) {
            this._gridId = this._settings.connect('changed::replace-app-grid', () => this._syncAppGrid());
            this._syncAppGrid();
        }

        // build the scene in the background shortly after login / enable (low priority, so the session start is not slowed down)
        this._prewarmId = GLib.timeout_add(GLib.PRIORITY_LOW, 2500, () => {
            this._prewarmId = 0;
            try {
                this._hive?.prewarm();
            } catch (e) {
                console.warn(`${LOG} background build failed: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });

        // "Preview" button in the preferences window
        if (this._hasKey('preview-request')) {
            this._previewId = this._settings.connect('changed::preview-request', () => {
                try {
                    this._hive?.open();
                } catch (e) {
                    console.error(`${LOG} preview failed: ${e}`);
                }
            });
        }

        // "Edit layout…" button in the preferences window
        if (this._hasKey('edit-request')) {
            this._editId = this._settings.connect('changed::edit-request', () => {
                try {
                    this._hive?.openEditing();
                } catch (e) {
                    console.error(`${LOG} edit request failed: ${e}`);
                }
            });
        }
    }

    // NB: GNOME Shell 51 throws if disable() is async, so everything here is synchronous.
    disable() {
        if (this._prewarmId) {
            GLib.source_remove(this._prewarmId);
            this._prewarmId = 0;
        }
        if (this._settings && this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._settings && this._gridId) {
            this._settings.disconnect(this._gridId);
            this._gridId = 0;
        }
        this._unpatchAppGrid();
        if (this._settings && this._editId) {
            this._settings.disconnect(this._editId);
            this._editId = 0;
        }
        if (this._settings && this._previewId) {
            this._settings.disconnect(this._previewId);
            this._previewId = 0;
        }
        if (this._keybindingAdded) {
            Main.wm.removeKeybinding('toggle-hive');
            this._keybindingAdded = false;
        }
        this._destroyIndicator();
        this._hive?.destroy(); // releases the modal grab, timeouts, signal handlers and all actors
        this._hive = null;
        this._settings = null;
    }

    // ------------------------------------------------------------------ replace GNOME's app grid
    _syncAppGrid() {
        const want = this._hasKey('replace-app-grid') && this._settings.get_boolean('replace-app-grid');
        if (want && !this._gridPatched)
            this._patchAppGrid();
        else if (!want && this._gridPatched)
            this._unpatchAppGrid();
    }

    /** Replace `obj[name]` for the lifetime of the patch; `fn(original, ...args)` is called instead. */
    _override(obj, name, fn) {
        if (!obj || typeof obj[name] !== 'function')
            return;
        const own = Object.prototype.hasOwnProperty.call(obj, name);
        const orig = obj[name];
        obj[name] = (...args) => fn(orig.bind(obj), ...args);
        this._gridUndo.push(() => {
            if (own)
                obj[name] = orig;
            else
                delete obj[name];
        });
    }

    /**
     * Every way into the application grid is routed to the Hive instead:
     *  - Overview.showApps() / Overview.show(APP_GRID) / the controls' showApps() and _toggleAppsPage()
     *  - as a net for docks that reach the grid some other way: the app grid becoming mapped, and the dash's
     *    "Show Applications" button being checked
     * These are private shell APIs, so every step is optional and wrapped; anything missing is skipped.
     */
    _patchAppGrid() {
        this._gridPatched = true;
        try {
            const overview = Main.overview;
            const controls = overview._overview?.controls ?? overview._overview?._controls;
            const APP_GRID = OverviewControls.ControlsState?.APP_GRID ?? 2;
            const take = () => this._openHiveInstead();

            this._override(overview, 'showApps', () => take());
            this._override(overview, 'show', (orig, state, ...rest) => {
                if (state === APP_GRID)
                    take();
                else
                    orig(state, ...rest);
            });
            if (controls) {
                this._override(controls, 'showApps', () => take());
                this._override(controls, '_toggleAppsPage', () => take());
                const grid = controls.appDisplay ?? controls._appDisplay;
                if (grid) {
                    this._gridSignals.push([grid, grid.connect('notify::mapped', () => {
                        if (grid.mapped)
                            take();
                    })]);
                }
            }
            const button = overview.dash?.showAppsButton;
            if (button) {
                this._gridSignals.push([button, button.connect('notify::checked', () => {
                    if (button.checked)
                        take();
                })]);
            }
        } catch (e) {
            console.warn(`${LOG} could not take over the app grid: ${e}`);
        }
    }

    _unpatchAppGrid() {
        if (!this._gridPatched && this._gridUndo.length === 0)
            return;
        for (const [obj, id] of this._gridSignals.splice(0)) {
            try {
                obj.disconnect(id);
            } catch (_e) { /* already gone */ }
        }
        for (const undo of this._gridUndo.splice(0).reverse()) {
            try {
                undo();
            } catch (_e) { /* best effort */ }
        }
        for (const id of this._gridTimers)
            GLib.source_remove(id);
        this._gridTimers.clear();
        this._gridPatched = false;
        this._intercepting = false;
    }

    /** Leave the overview if it is (becoming) visible, then open the Hive. */
    _openHiveInstead() {
        if (this._intercepting || !this._hive)
            return;
        this._intercepting = true;

        const overview = Main.overview;
        try {
            const button = overview.dash?.showAppsButton;
            if (button?.checked)
                button.checked = false;
        } catch (_e) { /* cosmetic */ }

        const later = (ms, fn) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._gridTimers.delete(id);
                fn();
                return GLib.SOURCE_REMOVE;
            });
            this._gridTimers.add(id);
            return id;
        };
        const open = () => {
            this._intercepting = false;
            try {
                this._hive?.open();
            } catch (e) {
                console.error(`${LOG} could not open the Hive: ${e}`);
            }
        };

        if (overview.visible || overview._shown) {
            let hiddenId = 0;
            let fallback = 0;
            const finish = () => {
                if (hiddenId) {
                    overview.disconnect(hiddenId);
                    hiddenId = 0;
                }
                if (fallback) {
                    GLib.source_remove(fallback);
                    this._gridTimers.delete(fallback);
                    fallback = 0;
                }
                open();
            };
            hiddenId = overview.connect('hidden', finish);
            this._gridSignals.push([overview, hiddenId]); // disable() mid-flight must not leave it connected
            fallback = later(900, () => {
                fallback = 0;
                finish();
            });
            overview.hide();
        } else {
            later(30, open); // let the click that got us here finish first
        }
    }

    _hasKey(key) {
        try {
            return !!this._settings?.settings_schema?.has_key(key);
        } catch (_e) {
            return false;
        }
    }

    _syncIndicator() {
        const want = this._hasKey('show-panel-icon') ? this._settings.get_boolean('show-panel-icon') : true;
        if (want && !this._indicator) {
            const ind = new PanelMenu.Button(0.0, 'Hive Launcher', true);
            ind.add_child(new St.Icon({icon_name: 'view-app-grid-symbolic', style_class: 'system-status-icon'}));
            const toggle = () => {
                this._hive?.toggle();
                return Clutter.EVENT_STOP;
            };
            ind.connect('button-press-event', toggle);
            ind.connect('touch-event', (a, e) => {
                if (e.type() === Clutter.EventType.TOUCH_BEGIN)
                    return toggle();
                return Clutter.EVENT_PROPAGATE;
            });
            Main.panel.addToStatusArea(this.uuid, ind);
            this._indicator = ind;
        } else if (!want) {
            this._destroyIndicator();
        }
    }

    _destroyIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
