// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
// Geometry, lattice maths, colour palettes and Cairo drawing for the Hive tiles.
//
// `G` is a single mutable "current configuration" object: configure() fills it from the user's settings
// each time the Hive opens, and the drawing / hit-testing helpers below read from it.

import Cairo from 'gi://cairo';
import GLib from 'gi://GLib';

import {THEMES, SYSTEM_ACCENTS} from './options.js';

export const SQ3 = Math.sqrt(3);
export const SQ2 = Math.SQRT2;
export const LABEL_H = 16;   // caption height under the icon
export const MAX_RINGS = 9;  // lattice radius cap
const TAU = Math.PI * 2;
const SQUIRCLE_N = 5; // superellipse exponent: Apple-style continuous corners
const AXIAL_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const clamp01 = v => clamp(v, 0, 1);
export const easeOutBack = t => {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

// ============================================================================ colours
export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

const luminance = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const rgba = (c, a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;

/**
 * Resolve the colours for a theme. `accentHex` (custom colour) beats `systemAccent` (GNOME accent name),
 * which beats the theme's own accent.
 */
export function resolvePalette(themeId, accentHex = '', systemAccent = '') {
    const t = THEMES[themeId] ?? THEMES.tokyo;
    let accent = hexToRgb(t.accent);
    let accentFg = hexToRgb(t.accentFg);
    const override = hexToRgb(accentHex) ?? (systemAccent ? hexToRgb(SYSTEM_ACCENTS[systemAccent]) : null);
    if (override) {
        accent = override;
        accentFg = luminance(override) > 0.55 ? [0.07, 0.07, 0.1] : [1, 1, 1];
    }
    return {
        id: themeId,
        dark: t.dark !== false,
        accent,
        accentFg,
        surface: hexToRgb(t.surface),
        fg: hexToRgb(t.fg),
        backdrop: t.backdrop.map(v => v / 255),
    };
}

// ============================================================================ shape metrics
// All shapes are defined by R = G.HEX_R (the hexagon's circumradius) so they share one size slider.
function metrics(shape, R) {
    switch (shape) {
    case 'circle':
        return {h: 0.5 * SQ3 * R * 1.04};
    case 'rounded': {
        const s = 0.5 * SQ3 * R * 1.02;
        return {h: s, s, c: s * clamp(G.CORNER, 0.05, 1)};
    }
    case 'squircle':
        return {h: 0.5 * SQ3 * R * 1.06};
    case 'diamond':
        return {h: 0.5 * SQ3 * R * 1.25};
    case 'octagon':
        return {h: 0.5 * SQ3 * R * 1.06};
    default: // hexagon
        return {h: 0.5 * SQ3 * R};
    }
}

/** Half the shape's width at vertical offset `y` from its centre (≤ 0 means "outside"). */
export function halfWidthAt(shape, R, y) {
    const ay = Math.abs(y);
    const m = metrics(shape, R);
    switch (shape) {
    case 'circle':
        return Math.sqrt(Math.max(0, m.h * m.h - ay * ay));
    case 'rounded': {
        const flat = m.s - m.c;
        if (ay <= flat)
            return m.s;
        return flat + Math.sqrt(Math.max(0, m.c * m.c - (ay - flat) ** 2));
    }
    case 'squircle':
        return m.h * Math.pow(Math.max(0, 1 - Math.pow(ay / m.h, SQUIRCLE_N)), 1 / SQUIRCLE_N);
    case 'diamond':
        return m.h - ay;
    case 'octagon':
        return Math.min(m.h, m.h * SQ2 - ay);
    default:
        return R - ay / SQ3;
    }
}

/** Exact point-in-shape test; (dx, dy) are offsets from the tile centre in unscaled pixels. */
export function shapeHit(shape, R, dx, dy) {
    const ay = Math.abs(dy);
    if (ay > metrics(shape, R).h)
        return false;
    return Math.abs(dx) <= halfWidthAt(shape, R, ay);
}

/**
 * Build the outline of `shape` as the current cairo path. With `append` the outline is added as a new
 * sub-path instead of replacing the path (used for even-odd cut-outs such as crescents and shadows).
 */
export function shapePath(cr, shape, cx, cy, R, append = false) {
    const m = metrics(shape, R);
    if (!append)
        cr.newPath();
    switch (shape) {
    case 'circle':
        cr.newSubPath();
        cr.arc(cx, cy, m.h, 0, TAU);
        break;
    case 'squircle': {
        const steps = 96;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps * TAU;
            const c = Math.cos(t);
            const sn = Math.sin(t);
            const x = cx + m.h * Math.sign(c) * Math.pow(Math.abs(c), 2 / SQUIRCLE_N);
            const y = cy + m.h * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / SQUIRCLE_N);
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
        cr.closePath();
        break;
    }
    case 'rounded': {
        cr.newSubPath();
        const x = cx - m.s;
        const y = cy - m.s;
        const w = 2 * m.s;
        const r = m.c;
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + w - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + w - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        break;
    }
    case 'diamond':
        cr.moveTo(cx, cy - m.h);
        cr.lineTo(cx + m.h, cy);
        cr.lineTo(cx, cy + m.h);
        cr.lineTo(cx - m.h, cy);
        cr.closePath();
        break;
    case 'octagon': {
        const Rc = m.h / Math.cos(Math.PI / 8); // circumradius from the apothem
        for (let i = 0; i < 8; i++) {
            const a = Math.PI / 8 + i * Math.PI / 4;
            const x = cx + Rc * Math.cos(a);
            const y = cy + Rc * Math.sin(a);
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
        cr.closePath();
        break;
    }
    default:
        for (let i = 0; i < 6; i++) {
            const a = i * Math.PI / 3;
            const x = cx + R * Math.cos(a);
            const y = cy + R * Math.sin(a);
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
        cr.closePath();
    }
}

// ============================================================================ configuration
export const G = {
    SIZE: 62,          // lattice cell radius
    STEP: 62 * SQ3,    // distance between neighbouring tile centres
    HEX_R: 57,         // drawn tile radius (SIZE − gap)
    BOX: 128,          // square actor box for one tile
    ICON: 44,
    LABEL_W: 72,
    SHAPE: 'hexagon',
    LAYOUT: 'honeycomb',
    LOGO: 'ring',
    LABELS: 'auto',
    SMIN: 0.3,
    // tile look
    TILE_STYLE: 'gradient',
    TILE_OPACITY: 0.85,
    TILE_COLOR: null,        // rgb or null (= theme surface)
    SHEEN: true,
    HOVER_FX: 'glow',
    HOVER_SCALE: 1.16,
    HOVER_STYLE: 'grow',
    PRESS: true,
    SHADOW: 0,               // 0..1 soft drop shadow under tiles
    LIGHT_FOLLOW: false,     // liquid glass: highlights follow the pointer
    CHROME: 'solid',         // search bar / menu look: 'solid' | 'glass'
    ANIM_SPEED: 1,
    // liquid-glass refraction (GPU shader; see refraction.js)
    REFRACT: false,
    REF_STRENGTH: 12,        // px of edge bending
    REF_FROST: 3,            // px of blur inside the glass
    REF_CHROMA: 1.5,         // px of colour fringing at the edge
    REF_VIBRANCE: 1.25,      // saturation boost of the refracted image
    REF_EDGE: 0.5,           // width of the lensing band as a fraction of the tile radius
    // liquid-glass surface (all 0..1)
    GLASS_RIM: 0.35,         // thin specular rim line
    GLASS_GLOSS: 0.3,        // soft inner light along the edge
    GLASS_DEPTH: 0.4,        // shading on the far side / contact shadow hairline
    GLASS_ANGLE: -124,       // default light direction in degrees (towards the light)
    // centre tile
    CENTER_STYLE: 'filled',  // centre tile: 'filled' | 'outline' | 'transparent'
    VIGNETTE: true,
    PATTERN: 'none',         // backdrop pattern: 'none' | 'grid-paper' | 'scanlines' | 'dots' (drawn once, with the vignette)
    PATTERN_A: 0.12,
    PATTERN_SP: 24,
    LABEL_UPPER: false,
    WIDGET: 'logo',
    WIDGET_DATA: {},
    CORNER: 0.42,            // roundness of the 'rounded' shape (0.05 = square … 1 = circle)
    RUNNING: 'both',
    // border
    BORDER_W: 1.3,
    BORDER_STYLE: 'solid',
    BORDER_MODE: 'accent',
    BORDER_COLOR: null,
    BORDER_A: 0.28,
    // animation
    OPEN_ANIM: 'pop',
    AMBIENT: 'none',
    LAUNCH_ANIM: true,
    MENU_ANIM: true,
    palette: resolvePalette('tokyo'),
};

/** Fill `G` from user options (see HiveOverlay._readOptions). */
export function configure(o) {
    const t = clamp(o.tileSize, 0.6, 1.5);
    G.SIZE = 62 * t;
    G.STEP = SQ3 * G.SIZE;
    G.HEX_R = Math.max(14, G.SIZE - clamp(o.gap, 0, 20));
    G.BOX = Math.ceil(2.1 * G.HEX_R) + 20; // extra room for drop shadows and glow
    G.ICON = Math.max(16, Math.round(44 * t * clamp(o.iconScale, 0.6, 1.5)));
    G.SHAPE = o.shape;
    G.LAYOUT = o.layout;
    G.LOGO = o.logo;
    G.LABELS = o.labels;
    G.SMIN = clamp(o.minScale, 0.12, 1);
    G.TILE_STYLE = o.tileStyle;
    G.TILE_OPACITY = clamp(o.tileOpacity, 0.05, 1);
    G.TILE_COLOR = hexToRgb(o.tileColor);
    G.SHEEN = o.sheen;
    G.HOVER_FX = o.hoverEffect;
    G.HOVER_SCALE = clamp(o.hoverScale, 1, 1.4);
    G.HOVER_STYLE = o.hoverStyle;
    G.PRESS = o.pressFeedback;
    G.SHADOW = clamp01(o.tileShadow);
    G.LIGHT_FOLLOW = o.glassLight === 'follow';
    G.CHROME = o.chromeStyle;
    G.ANIM_SPEED = clamp(o.animSpeed, 0.4, 2.5);
    G.REFRACT = !!o.refraction;
    G.REF_STRENGTH = clamp(o.refStrength, 0, 30);
    G.REF_FROST = clamp(o.refFrost, 0, 12);
    G.REF_CHROMA = clamp(o.refChroma, 0, 6);
    G.REF_VIBRANCE = clamp(o.refVibrance, 0.8, 1.8);
    G.REF_EDGE = clamp(o.refEdge ?? 0.5, 0.2, 0.8);
    G.GLASS_RIM = clamp01(o.glassRim ?? 0.35);
    G.GLASS_GLOSS = clamp01(o.glassGloss ?? 0.3);
    G.GLASS_DEPTH = clamp01(o.glassDepth ?? 0.4);
    G.GLASS_ANGLE = clamp(o.glassAngle ?? -124, -180, 180);
    DEFAULT_LIGHT[0] = Math.cos(G.GLASS_ANGLE * Math.PI / 180); // in place: everyone holds the same array
    DEFAULT_LIGHT[1] = Math.sin(G.GLASS_ANGLE * Math.PI / 180);
    G.WIDGET = o.widget ?? 'logo';
    G.CENTER_STYLE = o.centerStyle ?? 'filled';
    G.VIGNETTE = o.vignette !== false;
    G.PATTERN = o.pattern ?? 'none';
    G.PATTERN_A = clamp(o.patternOpacity ?? 0.12, 0.02, 0.6);
    G.PATTERN_SP = clamp(o.patternSpacing ?? 24, 2, 80);
    G.LABEL_UPPER = o.labelCase === 'upper';
    G.CORNER = clamp(o.corner, 0.05, 1);
    G.RUNNING = o.runningStyle;
    G.BORDER_W = clamp(o.borderWidth, 0, 6);
    G.BORDER_STYLE = o.borderStyle;
    G.BORDER_MODE = o.borderMode;
    G.BORDER_COLOR = hexToRgb(o.borderColor);
    G.BORDER_A = clamp01(o.borderOpacity);
    G.OPEN_ANIM = o.openAnim;
    G.AMBIENT = o.ambient;
    G.LAUNCH_ANIM = o.launchAnim;
    G.MENU_ANIM = o.menuAnim;
    const blockH = G.LABELS === 'none' ? G.ICON : G.ICON + 2 + LABEL_H;
    // captions must fit inside the tile at their own height, otherwise they spill over the edges
    G.LABEL_W = clamp(Math.floor(2 * halfWidthAt(G.SHAPE, G.HEX_R, blockH / 2) - 8), 44, G.BOX - 14);
    G.palette = resolvePalette(o.theme, o.accent, o.systemAccent);
}

// ============================================================================ lattice
/** Axial coordinates of the k-th hexagonal ring around the origin. */
function ringCells(k) {
    if (k === 0)
        return [[0, 0]];
    const out = [];
    let q = -k;
    let r = k;
    for (let i = 0; i < 6; i++) {
        for (let j = 0; j < k; j++) {
            out.push([q, r]);
            q += AXIAL_DIRS[i][0];
            r += AXIAL_DIRS[i][1];
        }
    }
    return out;
}

/** All lattice cells out to radius K, nearest-to-centre first (index 0 is always the centre). */
export function buildSpiral(layout, K) {
    if (layout === 'grid') {
        const out = [];
        const lim = (K + 0.35) ** 2;
        for (let q = -K; q <= K; q++) {
            for (let r = -K; r <= K; r++) {
                if (q * q + r * r <= lim)
                    out.push([q, r]);
            }
        }
        out.sort((a, b) =>
            (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2) ||
            Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
        return out;
    }
    const out = [];
    for (let k = 0; k <= K; k++)
        out.push(...ringCells(k));
    return out;
}

/** Ring index used for the staggered appear animation. */
export function cellRing(layout, q, r) {
    if (layout === 'grid')
        return Math.round(Math.hypot(q, r));
    return Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r));
}

/** Lattice coordinates → lattice pixel position. */
export function lat(layout, q, r) {
    if (layout === 'grid')
        return [G.STEP * q, G.STEP * r];
    return [G.SIZE * 1.5 * q, G.SIZE * SQ3 * (r + q / 2)];
}

// ============================================================================ drawing
/** HSV (all 0..1) → [r, g, b]. */
export function hsv(h, sat, val) {
    const i = Math.floor(h * 6) % 6;
    const f = h * 6 - Math.floor(h * 6);
    const p = val * (1 - sat);
    const q = val * (1 - f * sat);
    const t = val * (1 - (1 - f) * sat);
    return [[val, t, p], [q, val, p], [p, val, t], [p, q, val], [t, p, val], [val, p, q]][i];
}

/** Stroke the current tile outline in the user's border style. */
function strokeBorder(cr, cx, cy, R, col, alpha, width) {
    cr.setSourceRGBA(col[0], col[1], col[2], alpha);
    switch (G.BORDER_STYLE) {
    case 'dashed':
        cr.setDash([width * 3 + 3, width * 2 + 3], 0);
        shapePath(cr, G.SHAPE, cx, cy, R);
        cr.setLineWidth(width);
        cr.stroke();
        cr.setDash([], 0);
        break;
    case 'dotted':
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setDash([0.01, width * 2.2 + 3], 0);
        shapePath(cr, G.SHAPE, cx, cy, R);
        cr.setLineWidth(width * 1.4);
        cr.stroke();
        cr.setDash([], 0);
        cr.setLineCap(Cairo.LineCap.BUTT);
        break;
    case 'double':
        shapePath(cr, G.SHAPE, cx, cy, R);
        cr.setLineWidth(Math.max(0.8, width * 0.6));
        cr.stroke();
        shapePath(cr, G.SHAPE, cx, cy, Math.max(6, R - width * 2.6 - 2));
        cr.stroke();
        break;
    default:
        shapePath(cr, G.SHAPE, cx, cy, R);
        cr.setLineWidth(width);
        cr.stroke();
    }
}
function gradient(kind, args, stops) {
    const g = kind === 'radial' ? new Cairo.RadialGradient(...args) : new Cairo.LinearGradient(...args);
    for (const [off, c, a] of stops)
        g.addColorStopRGBA(off, c[0], c[1], c[2], a);
    return g;
}

// ============================================================================ centre-tile widgets
function fitText(cr, text, maxW) {
    if (cr.textExtents(text).width <= maxW)
        return text;
    let n = text.length;
    while (n > 1 && cr.textExtents(`${text.slice(0, n)}…`).width > maxW)
        n--;
    return `${text.slice(0, n).trimEnd()}…`;
}

function textAt(cr, text, cx, cy, size, bold, col, alpha, maxW = 1e9) {
    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
    cr.setFontSize(size);
    const t = fitText(cr, text, maxW);
    const e = cr.textExtents(t);
    cr.setSourceRGBA(col[0], col[1], col[2], alpha);
    cr.moveTo(cx - e.width / 2 - e.xBearing, cy - e.height / 2 - e.yBearing);
    cr.showText(t);
}

function gaugeRing(cr, cx, cy, r, width, frac, col, trackCol) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(width);
    cr.newPath();
    cr.arc(cx, cy, r, 0, TAU);
    cr.setSourceRGBA(trackCol[0], trackCol[1], trackCol[2], 0.16);
    cr.stroke();
    if (frac > 0.005) {
        cr.newPath();
        cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + clamp01(frac) * TAU);
        cr.setSourceRGBA(col[0], col[1], col[2], 0.95);
        cr.stroke();
    }
    cr.setLineCap(Cairo.LineCap.BUTT);
}

/** The widgets that can live on the centre tile; `G.WIDGET_DATA` is refreshed by the Hive while it is open. */
function drawWidget(cr, cx, cy, fg) {
    const D = G.WIDGET_DATA ?? {};
    const k = G.HEX_R;
    const acc = G.palette.accent;
    const maxW = k * 1.35;
    cr.setLineJoin(Cairo.LineJoin.ROUND);

    switch (G.WIDGET) {
    case 'clock':
        textAt(cr, D.hhmm ?? '--:--', cx, cy - k * 0.1, k * 0.46, true, fg, 0.97, maxW);
        textAt(cr, D.date ?? '', cx, cy + k * 0.28, k * 0.17, false, fg, 0.7, maxW);
        break;
    case 'analog': {
        const r = k * 0.62;
        cr.setLineWidth(1.5);
        cr.newPath();
        cr.arc(cx, cy, r, 0, TAU);
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.35);
        cr.stroke();
        for (let i = 0; i < 12; i++) {
            const a = i / 12 * TAU;
            const long = i % 3 === 0;
            cr.newPath();
            cr.moveTo(cx + Math.cos(a) * r * (long ? 0.8 : 0.88), cy + Math.sin(a) * r * (long ? 0.8 : 0.88));
            cr.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
            cr.setLineWidth(long ? 2.2 : 1.2);
            cr.setSourceRGBA(fg[0], fg[1], fg[2], long ? 0.85 : 0.45);
            cr.stroke();
        }
        const hand = (frac, len, width, col, a) => {
            const ang = frac * TAU - Math.PI / 2;
            cr.newPath();
            cr.moveTo(cx - Math.cos(ang) * r * 0.1, cy - Math.sin(ang) * r * 0.1);
            cr.lineTo(cx + Math.cos(ang) * r * len, cy + Math.sin(ang) * r * len);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(width);
            cr.setSourceRGBA(col[0], col[1], col[2], a);
            cr.stroke();
            cr.setLineCap(Cairo.LineCap.BUTT);
        };
        const hr = (D.hour ?? 10) % 12;
        hand((hr + (D.min ?? 8) / 60) / 12, 0.5, 3.4, fg, 0.95);
        hand(((D.min ?? 8) + (D.sec ?? 0) / 60) / 60, 0.78, 2.4, fg, 0.95);
        hand((D.sec ?? 0) / 60, 0.84, 1.2, acc, 1);
        cr.newPath();
        cr.arc(cx, cy, 3, 0, TAU);
        cr.setSourceRGBA(acc[0], acc[1], acc[2], 1);
        cr.fill();
        break;
    }
    case 'calendar':
        textAt(cr, (D.month ?? 'JAN').toUpperCase(), cx, cy - k * 0.4, k * 0.17, true, [0.96, 0.36, 0.36], 1, maxW);
        textAt(cr, String(D.day ?? 1), cx, cy + k * 0.04, k * 0.58, true, fg, 0.97, maxW);
        textAt(cr, D.weekday ?? '', cx, cy + k * 0.44, k * 0.16, false, fg, 0.7, maxW);
        break;
    case 'system': {
        const cpu = D.cpu ?? 0;
        const mem = D.mem ?? 0;
        gaugeRing(cr, cx, cy, k * 0.58, k * 0.1, cpu / 100, acc, fg);
        gaugeRing(cr, cx, cy, k * 0.4, k * 0.08, mem / 100, mix(acc, [1, 1, 1], 0.45), fg);
        textAt(cr, `${Math.round(cpu)}%`, cx, cy - k * 0.07, k * 0.2, true, fg, 0.97, k);
        textAt(cr, `RAM ${Math.round(mem)}%`, cx, cy + k * 0.13, k * 0.11, false, fg, 0.7, k);
        break;
    }
    case 'battery': {
        const b = D.bat ?? {present: false};
        if (!b.present) {
            textAt(cr, 'AC', cx, cy - k * 0.04, k * 0.32, true, fg, 0.95, maxW);
            textAt(cr, 'no battery', cx, cy + k * 0.26, k * 0.13, false, fg, 0.65, maxW);
            break;
        }
        const col = b.charging ? acc : (b.pct <= 20 ? [0.95, 0.32, 0.32] : [0.3, 0.82, 0.45]);
        gaugeRing(cr, cx, cy, k * 0.52, k * 0.11, b.pct / 100, col, fg);
        textAt(cr, `${Math.round(b.pct)}%`, cx, cy - k * 0.03, k * 0.28, true, fg, 0.97, k);
        textAt(cr, b.charging ? 'charging' : 'battery', cx, cy + k * 0.22, k * 0.11, false, fg, 0.65, k);
        break;
    }
    case 'media': {
        const m = D.media ?? {have: false};
        if (!m.have) {
            textAt(cr, '♪', cx, cy - k * 0.1, k * 0.42, true, fg, 0.6, maxW);
            textAt(cr, 'Nothing playing', cx, cy + k * 0.3, k * 0.13, false, fg, 0.6, maxW);
            break;
        }
        textAt(cr, m.title || 'Unknown', cx, cy - k * 0.22, k * 0.17, true, fg, 0.97, maxW);
        textAt(cr, m.artist || '', cx, cy - k * 0.02, k * 0.13, false, fg, 0.7, maxW);
        // play / pause glyph
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.95);
        if (m.playing) {
            cr.rectangle(cx - k * 0.12, cy + k * 0.2, k * 0.08, k * 0.26);
            cr.rectangle(cx + k * 0.04, cy + k * 0.2, k * 0.08, k * 0.26);
        } else {
            cr.moveTo(cx - k * 0.1, cy + k * 0.18);
            cr.lineTo(cx + k * 0.16, cy + k * 0.33);
            cr.lineTo(cx - k * 0.1, cy + k * 0.48);
            cr.closePath();
        }
        cr.fill();
        break;
    }
    default:
        break;
    }
}

/** Centre-tile content: the chosen widget, or the logo glyph. */
function drawCenter(cr, cx, cy, fg) {
    if (G.WIDGET && G.WIDGET !== 'logo')
        drawWidget(cr, cx, cy, fg);
    else
        drawLogoGlyph(cr, cx, cy, fg);
}

function drawLogoGlyph(cr, cx, cy, fg) {
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    if (G.LOGO === 'clock') {
        const now = GLib.DateTime.new_now_local();
        const text = now.format('%H:%M');
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(clamp(G.HEX_R * 0.3, 11, 24));
        const e = cr.textExtents(text);
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.95);
        cr.moveTo(cx - e.width / 2 - e.xBearing, cy - e.height / 2 - e.yBearing);
        cr.showText(text);
        return;
    }
    if (G.LOGO === 'hive') {
        // a tiny honeycomb: one hollow cell surrounded by six filled ones
        const r = G.HEX_R * 0.13;
        const d = r * SQ3 * 1.06;
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.95);
        for (let i = 0; i < 6; i++) {
            const a = Math.PI / 6 + i * Math.PI / 3;
            shapePath(cr, 'hexagon', cx + d * Math.cos(a), cy + d * Math.sin(a), r);
            cr.fill();
        }
        shapePath(cr, 'hexagon', cx, cy, r);
        cr.setLineWidth(1.8);
        cr.stroke();
        return;
    }
    // 'ring': a ring with a dot that sits at the current time of day
    const R = G.HEX_R * 0.39;
    const now = GLib.DateTime.new_now_local();
    const hour = now.get_hour() + now.get_minute() / 60;
    const ang = hour / 24 * TAU - Math.PI / 2;
    cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.92);
    cr.setLineWidth(3.5);
    cr.newPath();
    cr.arc(cx, cy, R, -Math.PI / 2 + 0.55, 3 * Math.PI / 2 - 0.55);
    cr.stroke();
    shapePath(cr, 'hexagon', cx, cy, R * 0.45);
    cr.setLineWidth(2);
    cr.stroke();
    cr.newPath();
    cr.arc(cx + R * Math.cos(ang), cy + R * Math.sin(ang), 4.6, 0, TAU);
    cr.fill();
}

export const DEFAULT_LIGHT = [-0.55, -0.83]; // direction towards the light, from a tile's centre

/** Soft drop shadow, drawn only OUTSIDE the tile so translucent glass stays clear. */
function drawShadow(cr, w, h, cx, cy, R, strength) {
    cr.save();
    cr.rectangle(0, 0, w, h);
    shapePath(cr, G.SHAPE, cx, cy, R, true);
    cr.setFillRule(Cairo.FillRule.EVEN_ODD);
    cr.clip();
    for (let i = 0; i < 9; i++) {
        shapePath(cr, G.SHAPE, cx, cy + R * 0.1, R * 0.9 + i * 1.9);
        cr.setSourceRGBA(0, 0, 0, 0.03 * strength * (i < 2 ? 1.4 : 1));
        cr.fill();
    }
    cr.restore();
}

/** One-shot diagonal glint that sweeps across a tile when it is first hovered. */
function drawShine(cr, cell, w, h, cx, cy, R) {
    const t = cell.shineT ?? 1;
    if (t >= 1 || G.HOVER_FX !== 'shine')
        return;
    const p = -0.3 + 1.6 * t;
    cr.setSource(gradient('linear', [cx - R, cy - R, cx + R, cy + R], [
        [clamp01(p - 0.2), [1, 1, 1], 0],
        [clamp01(p), [1, 1, 1], 0.55 * (1 - t * 0.5)],
        [clamp01(p + 0.2), [1, 1, 1], 0],
    ]));
    cr.rectangle(0, 0, w, h);
    cr.fill();
}

function drawRunning(cr, cell, cx, cy, R) {
    if (!cell.running || (G.RUNNING !== 'dot' && G.RUNNING !== 'both'))
        return;
    const P = G.palette;
    const pulse = cell.pulse ?? 1;
    cr.newPath();
    cr.arc(cx, cy + R * 0.8, 2.6 + 0.8 * pulse, 0, TAU);
    cr.setSourceRGBA(P.accent[0], P.accent[1], P.accent[2], 0.98);
    cr.fill();
}

/** Hidden apps only show up in search results; mark them with a dashed inner outline so that is obvious. */
function drawHiddenMark(cr, cell, cx, cy, R) {
    if (!cell.hiddenApp)
        return;
    const P = G.palette;
    cr.save();
    cr.setDash([3, 4], 0);
    shapePath(cr, G.SHAPE, cx, cy, Math.max(6, R - 5));
    cr.setSourceRGBA(P.fg[0], P.fg[1], P.fg[2], 0.45);
    cr.setLineWidth(1.2);
    cr.stroke();
    cr.restore();
}

function borderColour(cell) {
    if (G.BORDER_MODE === 'rainbow')
        return hsv(cell.hue ?? 0, 0.62, 0.98);
    if (G.BORDER_MODE === 'custom' && G.BORDER_COLOR)
        return G.BORDER_COLOR;
    return G.palette.accent;
}

function drawUserBorder(cr, cell, cx, cy, R, hv) {
    const bw = G.BORDER_W * (1 + 0.6 * hv) + (cell.running ? 0.5 : 0);
    if (bw <= 0.05)
        return;
    const alpha = clamp01(G.BORDER_A + (cell.running ? 0.36 : 0) + 0.5 * hv);
    strokeBorder(cr, cx, cy, R, borderColour(cell), alpha, bw);
}

export const LIGHT_STEPS = 24; // pre-rendered light directions for the glass atlas
export const lightAngleIndex = (x, y) =>
    ((Math.round(Math.atan2(y, x) / TAU * LIGHT_STEPS) % LIGHT_STEPS) + LIGHT_STEPS) % LIGHT_STEPS;
export const lightFromIndex = k => [Math.cos(k / LIGHT_STEPS * TAU), Math.sin(k / LIGHT_STEPS * TAU)];

/**
 * The static half of the "liquid glass" tile: only what does NOT change while a tile is hovered.
 *
 * Apple's material is mostly CLEAR: it defines itself through lensing (the bending of what is behind it, done by
 * the refraction shader), not through white overlays. So this layer is deliberately restrained:
 *   soft shadow · a whisper of tint · faint light gathered along the rim · slight shading on the far side ·
 *   a thin specular rim line, bright only near the lit corner and (weaker) the opposite one.
 * Every part scales with the user's rim / gloss / depth controls. `ld` is the direction towards the light.
 *
 * It is expensive to draw, so for app tiles it is rendered ONCE per light direction into a PNG (see glass.js)
 * that all tiles share as a GPU texture. `refracting` lowers the tint because the lensed desktop shows through.
 */
function drawLiquidStatic(cr, w, h, cx, cy, R, ld, tint, k0, refracting) {
    const W = [1, 1, 1];
    const K = [0, 0, 0];
    const rimK = G.GLASS_RIM;
    const glossK = G.GLASS_GLOSS;
    const depthK = G.GLASS_DEPTH;
    const [ldx, ldy] = ld;
    const k = k0 * (refracting ? 0.6 : 1);
    const lx = cx + ldx * R;
    const ly = cy + ldy * R;
    const dx = cx - ldx * R;
    const dy = cy - ldy * R;
    const along = stops => gradient('linear', [lx, ly, dx, dy], stops);

    if (G.SHADOW > 0)
        drawShadow(cr, w, h, cx, cy, R, G.SHADOW);

    // body: barely tinted, slightly lighter towards the light
    shapePath(cr, G.SHAPE, cx, cy, R);
    cr.setSource(along([
        [0, mix(tint, W, 0.35), clamp01(0.075 * k)],
        [1, mix(tint, W, 0.1), clamp01(0.03 * k)],
    ]));
    cr.fillPreserve();

    cr.save();
    cr.clipPreserve();
    cr.newPath();

    // light gathering along the rim (many thin steps so there is no visible edge to the glow)
    for (let i = 0; i < 7; i++) {
        shapePath(cr, G.SHAPE, cx, cy, R);
        cr.setSource(along([[0, W, 0.025 * glossK], [0.5, W, 0.004 * glossK], [1, W, 0.016 * glossK]]));
        cr.setLineWidth(2 + i * 2);
        cr.stroke();
    }
    // far side gets a little shade: gives the slab thickness without painting it white
    for (let i = 0; i < 6; i++) {
        shapePath(cr, G.SHAPE, cx, cy, R);
        cr.setSource(along([[0, K, 0], [0.5, K, 0], [1, K, 0.02 * depthK]]));
        cr.setLineWidth(2 + i * 2.4);
        cr.stroke();
    }
    // very soft light from above
    cr.setSource(along([[0, W, 0.06 * glossK], [0.5, W, 0], [1, W, 0]]));
    cr.rectangle(0, 0, w, h);
    cr.fill();
    cr.restore();

    // thin specular rim: strongest at the lit corner, a weaker echo at the opposite one, almost nothing between
    shapePath(cr, G.SHAPE, cx, cy, R);
    cr.setSource(along([
        [0, W, 0.9 * rimK], [0.2, W, 0.34 * rimK], [0.5, W, 0.05 * rimK],
        [0.8, W, 0.14 * rimK], [1, [0.86, 0.94, 1], 0.6 * rimK],
    ]));
    cr.setLineWidth(1);
    cr.stroke();
    shapePath(cr, G.SHAPE, cx, cy, Math.max(6, R - 2));
    cr.setSourceRGBA(1, 1, 1, 0.06 * rimK);
    cr.setLineWidth(0.7);
    cr.stroke();
    // contact hairline keeps the edge readable over light backgrounds
    shapePath(cr, G.SHAPE, cx, cy, R + 0.6);
    cr.setSourceRGBA(0, 0, 0, 0.07 * depthK);
    cr.setLineWidth(1);
    cr.stroke();
}

/** The cheap, per-tile half: hover brightening, rim boost and the glint sweep. Draws nothing when idle. */
function drawLiquidDynamic(cr, cell, w, h, cx, cy, R, hv, ld) {
    const shining = (cell.shineT ?? 1) < 1 && G.HOVER_FX === 'shine';
    if (hv <= 0.01 && !shining)
        return;
    const W = [1, 1, 1];
    shapePath(cr, G.SHAPE, cx, cy, R);
    cr.save();
    cr.clipPreserve();
    cr.newPath();
    if (hv > 0.01) {
        cr.setSourceRGBA(1, 1, 1, 0.04 * hv);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        const hx = cx + ld[0] * R * 0.4;
        const hy = cy + ld[1] * R * 0.4;
        cr.setSource(gradient('radial', [hx, hy, 0, hx, hy, R * 1.1], [[0, W, 0.09 * hv], [1, W, 0]]));
        cr.rectangle(0, 0, w, h);
        cr.fill();
    }
    drawShine(cr, cell, w, h, cx, cy, R);
    cr.restore();
    if (hv > 0.01) {
        shapePath(cr, G.SHAPE, cx, cy, R);
        cr.setSourceRGBA(1, 1, 1, (0.1 + 0.3 * G.GLASS_RIM) * hv);
        cr.setLineWidth(1.1);
        cr.stroke();
    }
}

/** Full single-pass version (used for the centre tile, and as a fallback when the atlas is unavailable). */
function drawLiquid(cr, cell, w, h, cx, cy, R, hv, tintOverride = null, boost = 1) {
    const ld = cell.ld ?? DEFAULT_LIGHT;
    const tint = tintOverride ?? G.TILE_COLOR ?? [1, 1, 1];
    const k = clamp(G.TILE_OPACITY / 0.85, 0.2, 1.5) * boost;
    drawLiquidStatic(cr, w, h, cx, cy, R, ld, tint, k, false);
    drawLiquidDynamic(cr, cell, w, h, cx, cy, R, hv, ld);
}

/** Render the static glass layer for light direction `index` to a PNG (2x for HiDPI). */
export function renderGlassImage(path, index, refracting, pxScale = 2) {
    const size = G.BOX;
    const px = Math.ceil(size * pxScale);
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, px, px);
    const cr = new Cairo.Context(surface);
    try {
        cr.scale(pxScale, pxScale);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        const k = clamp(G.TILE_OPACITY / 0.85, 0.2, 1.5);
        drawLiquidStatic(cr, size, size, size / 2, size / 2, G.HEX_R, lightFromIndex(index), G.TILE_COLOR ?? [1, 1, 1], k, refracting);
        surface.writeToPNG(path);
    } finally {
        cr.$dispose();
        surface.finish();
    }
}

/**
 * The tile outline as a superellipse for the refraction shader: half sizes (fractions of the tile box)
 * and the exponent n (2 = circle, 5 = squircle, large = square). Non-superellipse shapes are approximated.
 */
export function shapeShaderParams() {
    const R = G.HEX_R;
    const m = metrics(G.SHAPE, R);
    let hx = m.h;
    let hy = m.h;
    let n = 5;
    switch (G.SHAPE) {
    case 'circle': n = 2; break;
    case 'rounded': n = 2 + 10 * (1 - clamp(G.CORNER, 0.05, 1)); break;
    case 'diamond': n = 1; break;
    case 'octagon': n = 6; break;
    case 'hexagon': hx = R; hy = 0.5 * SQ3 * R; n = 2.6; break;
    default: n = 5;
    }
    return {hx: hx / G.BOX, hy: hy / G.BOX, n};
}

/** Paint one tile (called from the St.DrawingArea 'repaint' signal). */
/** The faint decorative empty tile. Shared by the cairo fallback (drawCell) and renderEmptyImage (one texture for every empty tile). */
function drawEmptyShape(cr, cx, cy, R) {
    const P = G.palette;
    shapePath(cr, G.SHAPE, cx, cy, R);
    cr.setSourceRGBA(P.fg[0], P.fg[1], P.fg[2], 0.035);
    cr.fillPreserve();
    cr.setSourceRGBA(P.fg[0], P.fg[1], P.fg[2], 0.12);
    cr.setLineWidth(1);
    cr.stroke();
}

/** Render the empty tile once into a PNG: every decorative empty tile then shows the same shared GPU texture. */
export function renderEmptyImage(path, pxScale = 2) {
    const size = G.BOX;
    const px = Math.ceil(size * pxScale);
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, px, px);
    const cr = new Cairo.Context(surface);
    try {
        cr.scale(pxScale, pxScale);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        drawEmptyShape(cr, size / 2, size / 2, G.HEX_R);
        surface.writeToPNG(path);
    } finally {
        cr.$dispose();
        surface.finish();
    }
}

/** Half-extent `a` of the largest square, centred on the tile, whose corners still lie inside the tile shape. */
export function bracketHalf(shape, R) {
    let lo = 0;
    let hi = R;
    for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (halfWidthAt(shape, R, mid) >= mid)
            lo = mid;
        else
            hi = mid;
    }
    return lo;
}

/** Four corner ticks (the 'brackets' tile style) instead of a full outline. */
function drawBrackets(cr, cell, cx, cy, R, hv) {
    const bw = Math.max(1, G.BORDER_W) * (1 + 0.6 * hv) + (cell.running ? 0.5 : 0);
    const alpha = clamp01(Math.max(G.BORDER_A, 0.35) + (cell.running ? 0.3 : 0) + 0.5 * hv);
    const bc = borderColour(cell);
    const a = bracketHalf(G.SHAPE, R);
    const t = Math.max(5, a * 0.5);
    cr.save();
    if (Cairo.LineCap)
        cr.setLineCap(Cairo.LineCap.SQUARE);
    cr.setLineJoin(Cairo.LineJoin.MITER);
    cr.setLineWidth(bw);
    cr.setSourceRGBA(bc[0], bc[1], bc[2], alpha);
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            cr.moveTo(cx + sx * a, cy + sy * (a - t));
            cr.lineTo(cx + sx * a, cy + sy * a);
            cr.lineTo(cx + sx * (a - t), cy + sy * a);
            cr.stroke();
        }
    }
    cr.restore();
}

export function drawCell(cell, area) {
    const cr = area.get_context();
    try {
        const [w, h] = area.get_surface_size();
        const P = G.palette;
        const R = G.HEX_R;
        const cx = w / 2;
        const cy = h / 2;
        const top = cy - R;
        const bottom = cy + R;
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        if (cell.kind === 'empty') {
            drawEmptyShape(cr, cx, cy, R);
            return;
        }

        if (cell.kind === 'logo' && G.TILE_STYLE === 'liquid') {
            const hvl = clamp01(cell.hover);
            drawLiquid(cr, cell, w, h, cx, cy, R, hvl, mix(P.accent, [1, 1, 1], 0.35), 1.9);
            drawCenter(cr, cx, cy, P.dark ? [1, 1, 1] : [0.12, 0.14, 0.2]);
            return;
        }

        if (cell.kind === 'logo' && G.CENTER_STYLE !== 'filled') {
            // outline / transparent: the centre follows the tile style instead of being a loud accent slab
            const hvc = clamp01(cell.hover);
            if (G.CENTER_STYLE === 'outline') {
                shapePath(cr, G.SHAPE, cx, cy, R);
                cr.setSourceRGBA(P.accent[0], P.accent[1], P.accent[2], 0.06 + 0.2 * hvc);
                cr.fillPreserve();
                cr.setSourceRGBA(P.accent[0], P.accent[1], P.accent[2], 0.9);
                cr.setLineWidth(Math.max(1.2, G.BORDER_W));
                cr.stroke();
            } else if (hvc > 0.01) {
                shapePath(cr, G.SHAPE, cx, cy, R);
                cr.setSourceRGBA(P.accent[0], P.accent[1], P.accent[2], 0.16 * hvc);
                cr.fill();
            }
            drawCenter(cr, cx, cy, P.accent);
            return;
        }

        if (cell.kind === 'logo') {
            if (G.SHADOW > 0)
                drawShadow(cr, w, h, cx, cy, R, G.SHADOW);
            shapePath(cr, G.SHAPE, cx, cy, R);
            cr.setSource(gradient('linear', [cx, top, cx, bottom], [
                [0, mix(P.accent, [1, 1, 1], 0.28), 0.98],
                [1, mix(P.accent, [0, 0, 0], 0.22), 0.98],
            ]));
            cr.fillPreserve();
            cr.setSourceRGBA(1, 1, 1, 0.3);
            cr.setLineWidth(1.5);
            cr.stroke();
            drawCenter(cr, cx, cy, P.accentFg);
            return;
        }

        // ---- app tile
        const hv = clamp01(cell.hover);
        const style = G.TILE_STYLE;

        if (style === 'liquid') {
            if (cell.glass)
                drawLiquidDynamic(cr, cell, w, h, cx, cy, R, hv, cell.ld ?? DEFAULT_LIGHT);
            else
                drawLiquid(cr, cell, w, h, cx, cy, R, hv);
            drawUserBorder(cr, cell, cx, cy, R, hv);
            drawHiddenMark(cr, cell, cx, cy, R);
            drawRunning(cr, cell, cx, cy, R);
            return;
        }

        const body = G.TILE_COLOR ?? P.surface;
        const op = G.TILE_OPACITY;
        const base = P.dark ? mix(body, [1, 1, 1], 0.1) : body;
        const low = P.dark ? body : mix(body, P.fg, 0.08);
        const bc = borderColour(cell);

        if (G.SHADOW > 0)
            drawShadow(cr, w, h, cx, cy, R, G.SHADOW);

        // 1. body fill
        shapePath(cr, G.SHAPE, cx, cy, R);
        switch (style) {
        case 'neon':
            cr.setSourceRGBA(body[0] * 0.6, body[1] * 0.6, body[2] * 0.6, clamp01(op * 1.05));
            break;
        case 'soft':
            cr.setSource(gradient('linear', [cx - R, cy - R, cx + R, cy + R], [
                [0, mix(body, [1, 1, 1], 0.07), op],
                [1, mix(body, [0, 0, 0], 0.14), op],
            ]));
            break;
        case 'holo':
            cr.setSource(gradient('linear', [cx, top, cx, bottom], [
                [0, mix(body, [1, 1, 1], 0.2), op * 0.5],
                [1, body, op * 0.35],
            ]));
            break;
        case 'solid':
        case 'brackets':
            cr.setSourceRGBA(body[0], body[1], body[2], op);
            break;
        case 'glass':
            cr.setSource(gradient('linear', [cx, top, cx, bottom], [
                [0, mix(body, [1, 1, 1], 0.3), op * 0.5],
                [1, body, op * 0.25],
            ]));
            break;
        case 'outline':
            cr.setSourceRGBA(body[0], body[1], body[2], 0);
            break;
        case 'accent':
            cr.setSource(gradient('linear', [cx, top, cx, bottom], [
                [0, mix(P.accent, [1, 1, 1], 0.15), op * 0.6],
                [1, mix(P.accent, [0, 0, 0], 0.4), op * 0.75],
            ]));
            break;
        default:
            cr.setSource(gradient('linear', [cx, top, cx, bottom], [
                [0, base, clamp01(op * 0.94)],
                [1, low, clamp01(op * 1.08)],
            ]));
        }
        cr.fillPreserve();

        // 2. clipped extras: hover effect, running glow, holographic sheen, gloss
        cr.save();
        cr.clipPreserve();
        cr.newPath();
        if (hv > 0.01 && G.HOVER_FX === 'glow') {
            cr.setSource(gradient('radial', [cx, cy, 0, cx, cy, R * 1.05], [
                [0, P.accent, 0.38 * hv],
                [1, P.accent, 0.04 * hv],
            ]));
            cr.rectangle(0, 0, w, h);
            cr.fill();
        } else if (hv > 0.01 && G.HOVER_FX === 'fill') {
            cr.setSourceRGBA(P.accent[0], P.accent[1], P.accent[2], 0.3 * hv);
            cr.rectangle(0, 0, w, h);
            cr.fill();
        } else if (hv > 0.01 && G.HOVER_FX === 'invert') { // inverse video: the tile fills with the accent colour
            cr.setSourceRGBA(P.accent[0], P.accent[1], P.accent[2], 0.92 * hv);
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }
        drawShine(cr, cell, w, h, cx, cy, R);
        const pulse = cell.pulse ?? 1;
        if (cell.running && (G.RUNNING === 'glow' || G.RUNNING === 'both')) {
            cr.setSource(gradient('radial', [cx, bottom, 0, cx, bottom, R * 0.9], [
                [0, P.accent, 0.46 * (0.55 + 0.45 * pulse)],
                [1, P.accent, 0],
            ]));
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }
        if (style === 'holo') {
            const hh = (cell.hue ?? 0) * 0.4;
            cr.setSource(gradient('linear', [cx - R, cy - R, cx + R, cy + R], [0, 0.25, 0.5, 0.75, 1].map(
                (o, i) => [o, hsv((0.92 + hh + i * 0.17) % 1, 0.55, 1), 0.26])));
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }
        if (G.SHEEN) {
            const k = style === 'glass' ? 1.7 : 1;
            cr.setSource(gradient('linear', [cx, top, cx, cy], [
                [0, [1, 1, 1], clamp01((P.dark ? 0.13 : 0.55) * k)],
                [1, [1, 1, 1], 0],
            ]));
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }
        cr.restore();

        // 3. soft (neumorphic) bevel
        if (style === 'soft') {
            shapePath(cr, G.SHAPE, cx, cy, Math.max(6, R - 1.5));
            cr.setSource(gradient('linear', [cx - R, cy - R, cx + R, cy + R], [
                [0, [1, 1, 1], 0.32], [0.5, [1, 1, 1], 0], [1, [0, 0, 0], 0.38],
            ]));
            cr.setLineWidth(3);
            cr.stroke();
        }

        // 4. border (the neon style glows in the border colour instead)
        if (style === 'neon') {
            const bw = G.BORDER_W * (1 + 0.6 * hv) + (cell.running ? 0.5 : 0);
            const boost = 0.6 + 0.8 * hv + (cell.running ? 0.3 : 0);
            for (const [wd, al] of [[7, 0.08], [4.5, 0.15], [2.5, 0.28]]) {
                shapePath(cr, G.SHAPE, cx, cy, R);
                cr.setSourceRGBA(bc[0], bc[1], bc[2], clamp01(al * boost));
                cr.setLineWidth(wd + bw);
                cr.stroke();
            }
            strokeBorder(cr, cx, cy, R, mix(bc, [1, 1, 1], 0.35), clamp01(0.85 + 0.15 * hv), Math.max(1.4, bw));
        } else if (style === 'brackets') {
            drawBrackets(cr, cell, cx, cy, R, hv);
        } else {
            drawUserBorder(cr, cell, cx, cy, R, hv);
        }

        // 5. hidden-app marker, running dot
        drawHiddenMark(cr, cell, cx, cy, R);
        drawRunning(cr, cell, cx, cy, R);
    } finally {
        cr.$dispose(); // mandatory in GJS: releases the cairo context
    }
}

/**
 * Backdrop pattern, drawn ONCE (the vignette area keeps its texture until the theme changes):
 * graph paper = fine lines with a heavier line every 5th, scanlines = thin horizontal lines, dots = a dot lattice.
 */
export function drawBackdropPattern(cr, w, h, kind, alpha, spacing, col) {
    // the number of primitives is bounded so a tiny spacing can never stall the shell
    const sp = Math.max(kind === 'scanlines' ? 2 : 6, spacing);
    cr.save();
    if (Cairo.Antialias)
        cr.setAntialias(Cairo.Antialias.NONE);
    if (kind === 'grid-paper') {
        cr.setLineWidth(1);
        cr.setSourceRGBA(col[0], col[1], col[2], clamp01(alpha * 0.5));
        for (let x = 0.5; x < w; x += sp) {
            cr.moveTo(x, 0);
            cr.lineTo(x, h);
        }
        for (let y = 0.5; y < h; y += sp) {
            cr.moveTo(0, y);
            cr.lineTo(w, y);
        }
        cr.stroke();
        const major = sp * 5;
        cr.setSourceRGBA(col[0], col[1], col[2], clamp01(alpha * 1.25));
        for (let x = 0.5; x < w; x += major) {
            cr.moveTo(x, 0);
            cr.lineTo(x, h);
        }
        for (let y = 0.5; y < h; y += major) {
            cr.moveTo(0, y);
            cr.lineTo(w, y);
        }
        cr.stroke();
    } else if (kind === 'scanlines') {
        cr.setLineWidth(1);
        cr.setSourceRGBA(col[0], col[1], col[2], clamp01(alpha * 0.7));
        for (let y = 0.5; y < h; y += sp) {
            cr.moveTo(0, y);
            cr.lineTo(w, y);
        }
        cr.stroke();
    } else if (kind === 'dots') {
        if (Cairo.Antialias)
            cr.setAntialias(Cairo.Antialias.DEFAULT);
        cr.setSourceRGBA(col[0], col[1], col[2], clamp01(alpha * 1.1));
        // at most ~30000 dots whatever the spacing and screen size (a tiny spacing must never stall the shell)
        const dsp = Math.max(sp, Math.sqrt(w * h / 30000));
        const r = Math.max(0.8, dsp * 0.06);
        for (let y = dsp / 2; y < h; y += dsp) {
            for (let x = dsp / 2; x < w; x += dsp) {
                cr.newSubPath();
                cr.arc(x, y, r, 0, TAU);
            }
        }
        cr.fill();
    }
    cr.restore();
}

/** Backdrop pattern + soft vignette / centre glow painted behind the tiles. */
export function drawVignette(area) {
    const cr = area.get_context();
    try {
        const [w, h] = area.get_surface_size();
        const P = G.palette;
        if (G.PATTERN !== 'none')
            drawBackdropPattern(cr, w, h, G.PATTERN, G.PATTERN_A, G.PATTERN_SP, G.PATTERN === 'dots' ? P.fg : P.accent);
        if (!G.VIGNETTE)
            return;
        const cx = w / 2;
        const cy = h / 2;
        const rad = Math.hypot(w, h) / 2;
        cr.setSource(gradient('radial', [cx, cy, 0, cx, cy, rad], [
            [0, P.accent, P.dark ? 0.1 : 0.12],
            [0.55, P.accent, 0.0],
            [1, mix(P.backdrop, [0, 0, 0], P.dark ? 0.6 : 0), P.dark ? 0.5 : 0],
        ]));
        cr.rectangle(0, 0, w, h);
        cr.fill();
    } finally {
        cr.$dispose();
    }
}
