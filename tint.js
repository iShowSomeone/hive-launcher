// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Icon tinting (Terminal / Blueprint looks): greyscale or a single colour instead of the app's own colours.
//
// Implemented with Clutter's built-in ColorizeEffect (greyscale x tint colour) / DesaturateEffect, attached ONCE when a tile is built.
// Clutter renders the icon into an offscreen buffer only when the icon changes and re-uses it every frame (the icons never change while the Hive
// is open), so the running cost is one extra textured quad per icon, not a shader run per frame. (True pre-tinted bitmaps would need pixel access
// to the themed icon, for which there is no API that behaves the same on Shell 45-51.)
//
// The tint colour type differs between Shell versions (Clutter.Color up to 45, Cogl.Color afterwards); the first construction that works is
// remembered. If none works the tile falls back to plain greyscale, and finally to the original icon: tinting can never break the Hive.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';

const LOG = '[hive-launcher]';
let working = -1;   // index of the colour constructor that worked (-1 = not probed yet, -2 = none works)
let warned = false;

const bytes = rgb => rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));

const FACTORIES = [
    rgb => {
        const [r, g, b] = bytes(rgb);
        return new Cogl.Color({red: r, green: g, blue: b, alpha: 255});
    },
    rgb => {
        const [r, g, b] = bytes(rgb);
        return new Clutter.Color({red: r, green: g, blue: b, alpha: 255});
    },
];

function colorize(rgb) {
    const order = working >= 0 ? [working] : FACTORIES.map((_f, i) => i);
    for (const i of order) {
        try {
            const effect = new Clutter.ColorizeEffect({tint: FACTORIES[i](rgb)});
            working = i;
            return effect;
        } catch (_e) { /* try the next way of making a colour */ }
    }
    working = -2;
    return null;
}

/**
 * An effect that tints an icon, or null (leave the icon alone).
 * @param {'mono'|'accent'|'custom'} mode
 * @param {number[]} rgb tint colour 0..1 (ignored for 'mono')
 */
export function createTintEffect(mode, rgb) {
    try {
        if (mode === 'original')
            return null;
        if (working !== -2) {
            const e = colorize(mode === 'mono' ? [1, 1, 1] : rgb);
            if (e)
                return e;
        }
        if (!warned) {
            warned = true;
            console.warn(`${LOG} icon tint: no usable colour type in this shell, using greyscale`);
        }
        return new Clutter.DesaturateEffect({factor: 1});
    } catch (e) {
        if (!warned) {
            warned = true;
            console.warn(`${LOG} icon tint unavailable, icons keep their colours: ${e}`);
        }
        return null;
    }
}
