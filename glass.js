// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Glass atlas: the expensive static half of the liquid-glass tile is rendered ONCE per light direction
// into a PNG in the user's cache directory. Every tile then just shows one of these images (St.Icon →
// shared GPU texture), so opening the Hive and re-lighting tiles as the pointer moves costs almost nothing.
// (Before this, every tile ran ~40 software-rendered gradient strokes on each repaint, which is what made
// the liquid presets laggy.)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {G, renderGlassImage, renderEmptyImage, LIGHT_STEPS, lightAngleIndex, DEFAULT_LIGHT} from './shapes.js';

const LOG = '[hive-launcher]';

/** Index of the light direction for the user's "light angle" setting (DEFAULT_LIGHT is updated by configure()). */
export const defaultLightIndex = () => lightAngleIndex(DEFAULT_LIGHT[0], DEFAULT_LIGHT[1]);

export class GlassAtlas {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'hive-launcher']);
        this._sig = '';
        this._hash = '';
        this._refracting = false;
        this._icons = new Map();
        this._queue = [];
        this._idleId = 0;
        this._broken = false;
    }

    get usable() {
        return !this._broken && this._icons.size > 0;
    }

    /**
     * (Re)configure for the current geometry/theme. Renders the default-light image immediately and, when
     * `allAngles` is set (pointer-following light), the other directions lazily while the shell is idle.
     */
    configure(refracting, allAngles) {
        const sig = [
            G.SHAPE, G.HEX_R.toFixed(2), G.BOX, G.TILE_OPACITY.toFixed(2), (G.TILE_COLOR ?? []).join(','),
            G.SHADOW.toFixed(2), G.CORNER.toFixed(2), refracting ? 'r' : 'f',
            G.GLASS_RIM.toFixed(2), G.GLASS_GLOSS.toFixed(2), G.GLASS_DEPTH.toFixed(2), 'v3',
        ].join('|');

        if (sig !== this._sig) {
            this._cancelIdle();
            this._sig = sig;
            this._hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, sig, -1).slice(0, 12);
            this._refracting = refracting;
            this._icons.clear();
            this._broken = false;
            try {
                GLib.mkdir_with_parents(this._dir, 0o755);
                this._prune();
                this._ensure(defaultLightIndex());
            } catch (e) {
                console.warn(`${LOG} glass atlas unavailable, drawing tiles directly: ${e}`);
                this._broken = true;
                return;
            }
        }
        if (allAngles && !this._broken)
            this._queueRemaining();
    }

    /** Icon for the nearest available light direction (null if the atlas is not usable). */
    iconFor(index) {
        if (this._broken || this._icons.size === 0)
            return null;
        const hit = this._icons.get(index);
        if (hit)
            return {icon: hit, index};
        for (let d = 1; d <= LIGHT_STEPS / 2; d++) {
            for (const k of [(index + d) % LIGHT_STEPS, (index - d + LIGHT_STEPS) % LIGHT_STEPS]) {
                const icon = this._icons.get(k);
                if (icon)
                    return {icon, index: k};
            }
        }
        return null;
    }

    _path(index) {
        return GLib.build_filenamev([this._dir, `glass-${this._hash}-${index}.png`]);
    }

    _ensure(index) {
        if (this._icons.has(index))
            return;
        const path = this._path(index);
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            renderGlassImage(path, index, this._refracting);
        this._icons.set(index, new Gio.FileIcon({file}));
    }

    _queueRemaining() {
        if (this._idleId || this._icons.size >= LIGHT_STEPS)
            return;
        this._queue = [];
        for (let i = 0; i < LIGHT_STEPS; i++) {
            if (!this._icons.has(i))
                this._queue.push(i);
        }
        this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const next = this._queue.shift();
            if (next === undefined) {
                this._idleId = 0;
                return GLib.SOURCE_REMOVE;
            }
            try {
                this._ensure(next);
            } catch (e) {
                console.warn(`${LOG} glass image ${next} failed: ${e}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cancelIdle() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._queue = [];
    }

    /** Delete images that belong to other configurations so the cache directory stays tiny. */
    _prune() {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('glass-') && !name.startsWith(`glass-${this._hash}-`))
                    dir.get_child(name).delete(null);
            }
            en.close(null);
        } catch (_e) { /* best effort */ }
    }

    destroy() {
        this._cancelIdle();
        this._icons.clear();
    }
}

/**
 * One shared texture for every decorative empty tile: each empty tile is a plain icon showing the same PNG,
 * which the shell's texture cache uploads once (instead of one cairo-drawn area per tile).
 */
export class EmptyTexture {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'hive-launcher']);
        this._sig = '';
        this.icon = null;
    }

    /** (Re)render when the shape / size / colours changed. Returns true when `icon` changed. */
    configure() {
        const P = G.palette;
        const sig = [G.SHAPE, G.HEX_R.toFixed(2), G.BOX, G.CORNER.toFixed(2), P.fg.map(v => v.toFixed(3)).join(','), 'e1'].join('|');
        if (sig === this._sig && this.icon)
            return false;
        this._sig = sig;
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, sig, -1).slice(0, 12);
            const path = GLib.build_filenamev([this._dir, `empty-${hash}.png`]);
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null))
                renderEmptyImage(path);
            this._prune(`empty-${hash}.png`);
            this.icon = new Gio.FileIcon({file});
        } catch (e) {
            console.warn(`${LOG} empty-tile texture unavailable: ${e}`);
            this.icon = null;
        }
        return true;
    }

    get usable() {
        return !!this.icon;
    }

    _prune(keep) {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            for (let n = 0; n < 500 && (info = en.next_file(null)) !== null; n++) {
                const name = info.get_name();
                if (name.startsWith('empty-') && name !== keep)
                    dir.get_child(name).delete(null);
            }
            en.close(null);
        } catch (_e) { /* best effort */ }
    }

    destroy() {
        this.icon = null;
    }
}
