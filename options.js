// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
// Pure data shared by the extension and its preferences window (no imports on purpose).

export const SHAPES = [
    ['hexagon', 'Hexagon'],
    ['circle', 'Circle'],
    ['rounded', 'Rounded square'],
    ['squircle', 'Squircle'],
    ['diamond', 'Diamond'],
    ['octagon', 'Octagon'],
];

export const LAYOUTS = [
    ['honeycomb', 'Honeycomb'],
    ['grid', 'Square grid'],
];

export const LOGO_STYLES = [
    ['ring', 'Day ring'],
    ['hive', 'Honeycomb'],
    ['clock', 'Clock'],
];

export const LABEL_MODES = [
    ['auto', 'Fade with distance'],
    ['hover', 'Only on hover'],
    ['none', 'Hidden'],
];

export const WIDGETS = [
    ['logo', 'Logo'],
    ['clock', 'Digital clock'],
    ['analog', 'Analogue clock'],
    ['calendar', 'Calendar date'],
    ['system', 'CPU and memory'],
    ['battery', 'Battery'],
    ['media', 'Now playing'],
];

export const SORT_MODES = [
    ['frequency', 'Most used'],
    ['name', 'Name (A–Z)'],
    ['favorites', 'Favorites first'],
    ['recent', 'Recently opened'],
];

export const FOLDER_MODES = [
    ['none', 'Off (one flat lattice)'],
    ['categories', 'By category (automatic)'],
    ['gnome', 'My GNOME app folders'],
    ['custom', 'My custom layout (edit in the Hive)'],
];

export const CUSTOM_POLICIES = [
    ['packed', 'Packed (no gaps)'],
    ['free', 'Free (gaps allowed)'],
];

// backdrop = tint colour behind the Hive (0-255), dark = false switches captions/hints to dark text
export const THEMES = {
    tokyo: {name: 'Tokyo Night', accent: '#7aa2f7', accentFg: '#11131c', surface: '#1a1b26', fg: '#e6e9f5', backdrop: [8, 10, 18]},
    honey: {name: 'Honey', accent: '#f5b301', accentFg: '#1a1200', surface: '#261d08', fg: '#fff4d6', backdrop: [16, 11, 2]},
    catppuccin: {name: 'Catppuccin Mocha', accent: '#cba6f7', accentFg: '#1e1e2e', surface: '#1e1e2e', fg: '#cdd6f4', backdrop: [17, 17, 27]},
    nord: {name: 'Nord', accent: '#88c0d0', accentFg: '#2e3440', surface: '#2e3440', fg: '#eceff4', backdrop: [20, 24, 32]},
    gruvbox: {name: 'Gruvbox', accent: '#d79921', accentFg: '#1d2021', surface: '#282828', fg: '#ebdbb2', backdrop: [20, 18, 14]},
    rose: {name: 'Rosé Pine', accent: '#ebbcba', accentFg: '#191724', surface: '#1f1d2e', fg: '#e0def4', backdrop: [14, 12, 24]},
    emerald: {name: 'Emerald', accent: '#34d399', accentFg: '#052018', surface: '#0f1f1a', fg: '#e6fff5', backdrop: [4, 14, 10]},
    mono: {name: 'Monochrome', accent: '#e8e8e8', accentFg: '#101010', surface: '#141414', fg: '#ffffff', backdrop: [0, 0, 0]},
    light: {name: 'Daylight', accent: '#3584e4', accentFg: '#ffffff', surface: '#ffffff', fg: '#1f2430', backdrop: [236, 239, 246], dark: false},
};

// GNOME's system accent colours (org.gnome.desktop.interface accent-color)
export const SYSTEM_ACCENTS = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
};

export const TILE_STYLES = [
    ['gradient', 'Gradient'],
    ['solid', 'Solid'],
    ['glass', 'Glass'],
    ['liquid', 'Liquid glass'],
    ['neon', 'Neon'],
    ['soft', 'Soft (neumorphic)'],
    ['holo', 'Holographic'],
    ['outline', 'Outline only'],
    ['accent', 'Accent tinted'],
    ['brackets', 'Corner brackets'],
];

export const HOVER_EFFECTS = [
    ['glow', 'Glow'],
    ['fill', 'Colour fill'],
    ['shine', 'Glint sweep'],
    ['none', 'None'],
    ['invert', 'Inverse video'],
];

export const BORDER_STYLES = [
    ['solid', 'Solid'],
    ['dashed', 'Dashed'],
    ['dotted', 'Dotted'],
    ['double', 'Double'],
];

export const BORDER_MODES = [
    ['accent', 'Accent colour'],
    ['custom', 'Custom colour'],
    ['rainbow', 'Rainbow (by position)'],
];

export const RUNNING_STYLES = [
    ['both', 'Dot and glow'],
    ['dot', 'Dot'],
    ['glow', 'Glow'],
    ['none', 'None'],
];

export const OPEN_ANIMS = [
    ['pop', 'Pop (staggered)'],
    ['fade', 'Fade'],
    ['rise', 'Rise'],
    ['spin', 'Spin'],
    ['zoom', 'Zoom'],
    ['spring', 'Spring'],
    ['cascade', 'Cascade (sweep)'],
    ['flip', 'Flip'],
    ['converge', 'Converge from the edges'],
    ['materialize', 'Materialize (lens focus)'],
];

export const AMBIENT_ANIMS = [
    ['none', 'None'],
    ['float', 'Gentle float'],
    ['pulse', 'Pulsing running apps'],
    ['both', 'Float and pulse'],
    ['breathe', 'Breathing'],
    ['wave', 'Ripple wave'],
];

export const HOVER_STYLES = [
    ['grow', 'Smooth grow'],
    ['bounce', 'Springy bounce'],
    ['tilt', '3D tilt toward the pointer'],
];

export const CHROME_STYLES = [
    ['solid', 'Solid'],
    ['glass', 'Glass'],
];

export const LIGHT_MODES = [
    ['fixed', 'Fixed (top-left)'],
    ['follow', 'Follows the pointer'],
];

export const SEARCH_POSITIONS = [
    ['top', 'Top'],
    ['bottom', 'Bottom'],
];

// ---- look details (each is its own setting: after applying a preset any of them can be kept or dropped separately)
export const ICON_TINTS = [
    ['original', 'Original colours'],
    ['mono', 'Greyscale'],
    ['accent', 'Tinted with the accent colour'],
    ['custom', 'Tinted with a custom colour'],
];

export const CENTER_STYLES = [
    ['filled', 'Solid accent tile'],
    ['outline', 'Outline only'],
    ['transparent', 'No tile (glyph only)'],
];

export const LABEL_FONTS = [
    ['default', 'System font'],
    ['monospace', 'Monospace'],
];

export const LABEL_CASES = [
    ['normal', 'As written'],
    ['upper', 'UPPERCASE'],
];

export const BACKDROP_PATTERNS = [
    ['none', 'None'],
    ['grid-paper', 'Graph paper'],
    ['scanlines', 'Scanlines'],
    ['dots', 'Dots'],
];

export const SEARCH_STYLES = [
    ['pill', 'Pill'],
    ['square', 'Square'],
];

export const SEARCH_PROMPTS = [
    ['none', 'Magnifier'],
    ['chevron', '“>” prompt'],
];

export const PERF_TIERS = [
    ['auto', 'Automatic (follows the machine load)'],
    ['full', 'Full (everything as configured)'],
    ['balanced', 'Balanced (no ambient motion or refraction)'],
    ['lite', 'Lite (instant, no animation, blur or refraction)'],
];

// ---------------------------------------------------------------------------------------------
// Presets: every appearance key is listed in PRESET_BASE (= the defaults), so applying a preset
// always produces a complete, predictable look; each preset only lists what it changes.
export const PRESET_BASE = {
    'theme': 'honey', 'accent-color': '', 'use-system-accent': false,
    'shape': 'hexagon', 'layout': 'honeycomb', 'tile-size': 1.0, 'tile-gap': 5.0, 'icon-scale': 1.0,
    'labels': 'auto', 'label-size': 1.0, 'logo-style': 'ring', 'show-empty': true,
    'tile-style': 'gradient', 'tile-opacity': 0.85, 'tile-color': '', 'tile-sheen': true,
    'hover-effect': 'glow', 'hover-scale': 1.16, 'corner-roundness': 0.42, 'running-style': 'both',
    'border-width': 2.0, 'border-style': 'solid', 'border-mode': 'accent', 'border-color': '', 'border-opacity': 0.45,
    'blur': true, 'blur-strength': 30.0, 'backdrop-opacity': 0.62, 'backdrop-color': '', 'show-vignette': true,
    'show-hints': true, 'min-scale': 0.3, 'zoom': 1.0,
    'open-animation': 'pop', 'ambient-animation': 'float', 'launch-animation': true, 'menu-animation': true,
    'tile-shadow': 0.0, 'chrome-style': 'solid', 'glass-light': 'fixed',
    'hover-style': 'grow', 'press-feedback': true, 'animation-speed': 1.0,
    'glass-refraction': false, 'refraction-strength': 16.0, 'refraction-frost': 1.5,
    'refraction-chroma': 1.0, 'refraction-vibrance': 1.2, 'refraction-edge': 0.5,
    'glass-rim': 0.35, 'glass-gloss': 0.3, 'glass-depth': 0.4, 'glass-angle': -124.0,
    'icon-tint': 'original', 'icon-tint-color': '', 'icon-tint-strength': 1.0, 'center-style': 'filled',
    'label-font': 'default', 'label-case': 'normal', 'label-glow': 0.0,
    'backdrop-pattern': 'none', 'pattern-opacity': 0.12, 'pattern-spacing': 24.0,
    'search-style': 'pill', 'search-prompt': 'none',
};

export const PRESETS = {
    honey: {name: 'Honey Hive (default)', values: {}},
    liquid: {name: 'Liquid Glass (Damn)', values: {
        'theme': 'mono', 'shape': 'squircle', 'layout': 'grid', 'tile-style': 'liquid', 'tile-opacity': 0.9,
        'tile-sheen': false, 'border-width': 0.0, 'tile-gap': 12.0, 'icon-scale': 1.08, 'logo-style': 'hive',
        'show-empty': false, 'blur-strength': 28.0, 'backdrop-opacity': 0.3, 'tile-shadow': 0.55,
        'glass-refraction': true, 'refraction-strength': 16.0, 'refraction-frost': 1.5, 'refraction-chroma': 1.0,
        'refraction-vibrance': 1.2, 'refraction-edge': 0.45,
        'glass-rim': 0.35, 'glass-gloss': 0.3, 'glass-depth': 0.4, 'glass-angle': -124.0,
        'glass-light': 'follow', 'chrome-style': 'glass', 'hover-effect': 'shine', 'hover-style': 'bounce',
        'hover-scale': 1.08, 'running-style': 'dot', 'open-animation': 'materialize', 'min-scale': 0.42,
        'ambient-animation': 'none',
    }},
    neon: {name: 'Neon Nights', values: {
        'theme': 'catppuccin', 'tile-style': 'neon', 'tile-opacity': 0.9, 'tile-sheen': false,
        'border-width': 1.4, 'border-mode': 'rainbow', 'border-opacity': 0.9, 'backdrop-opacity': 0.78,
        'hover-effect': 'fill', 'running-style': 'glow', 'open-animation': 'spin', 'ambient-animation': 'pulse',
    }},
    holo: {name: 'Holographic', values: {
        'theme': 'tokyo', 'shape': 'circle', 'tile-style': 'holo', 'tile-opacity': 0.8, 'border-width': 1.0,
        'border-mode': 'rainbow', 'border-opacity': 0.7, 'tile-gap': 6.0, 'open-animation': 'spin',
        'ambient-animation': 'none',
    }},
    glass: {name: 'Glass Circles', values: {
        'theme': 'nord', 'shape': 'circle', 'layout': 'grid', 'tile-style': 'glass', 'tile-opacity': 0.8,
        'border-width': 1.0, 'border-opacity': 0.35, 'tile-gap': 8.0, 'show-empty': false, 'open-animation': 'fade',
        'ambient-animation': 'none',
    }},
    soft: {name: 'Soft UI', values: {
        'theme': 'light', 'shape': 'rounded', 'layout': 'grid', 'corner-roundness': 0.5, 'tile-style': 'soft',
        'tile-opacity': 1.0, 'tile-sheen': false, 'border-width': 0.0, 'tile-gap': 10.0, 'backdrop-opacity': 0.55,
        'hover-effect': 'none', 'hover-scale': 1.08, 'show-empty': false, 'open-animation': 'fade',
        'ambient-animation': 'none',
    }},
    // Blueprint v2: cyanotype drafting paper. Deep blue backdrop with a fine 24 px graph-paper grid (major line every 5th), thin white-blue
    // outlines, icons tinted pale blue, small uppercase monospace captions, outline-only centre tile, soft fill on hover.
    blueprint: {name: 'Blueprint', values: {
        'theme': 'tokyo', 'accent-color': '#9fd4ff', 'shape': 'rounded', 'layout': 'grid', 'corner-roundness': 0.06,
        'tile-style': 'outline', 'tile-sheen': false, 'tile-gap': 6.0, 'tile-shadow': 0.0,
        'border-style': 'solid', 'border-width': 1.0, 'border-mode': 'custom', 'border-color': '#d6ecff', 'border-opacity': 0.8,
        'labels': 'auto', 'label-size': 0.8, 'label-font': 'monospace', 'label-case': 'upper', 'show-empty': false,
        'hover-effect': 'fill', 'hover-scale': 1.06, 'running-style': 'dot', 'logo-style': 'clock', 'center-style': 'outline',
        'icon-tint': 'custom', 'icon-tint-color': '#cfe8ff', 'icon-tint-strength': 0.85,
        'blur': true, 'blur-strength': 14.0, 'backdrop-color': '#0a2a5e', 'backdrop-opacity': 0.95,
        'backdrop-pattern': 'grid-paper', 'pattern-opacity': 0.2, 'pattern-spacing': 24.0,
        'search-style': 'square', 'search-prompt': 'none',
        'show-vignette': false, 'open-animation': 'fade', 'ambient-animation': 'none', 'min-scale': 0.4,
    }},
    // Terminal v2: black screen with faint scanlines, phosphor-green corner brackets instead of filled cells, green-tinted icons,
    // monospace uppercase captions with a soft glow, inverse-video hover, ">" prompt in a square search bar, quick rise.
    terminal: {name: 'Terminal', values: {
        'theme': 'emerald', 'accent-color': '#3dff7a', 'shape': 'rounded', 'layout': 'grid', 'corner-roundness': 0.05,
        'tile-style': 'brackets', 'tile-color': '#04130a', 'tile-opacity': 0.6, 'tile-sheen': false, 'tile-gap': 7.0, 'tile-shadow': 0.0,
        'border-style': 'solid', 'border-width': 1.3, 'border-mode': 'accent', 'border-opacity': 0.75,
        'labels': 'auto', 'label-size': 0.85, 'label-font': 'monospace', 'label-case': 'upper', 'label-glow': 0.6, 'show-empty': false,
        'hover-effect': 'invert', 'hover-scale': 1.05, 'running-style': 'glow', 'logo-style': 'clock', 'center-style': 'outline',
        'icon-tint': 'accent', 'icon-tint-color': '', 'icon-tint-strength': 0.9,
        'blur': true, 'blur-strength': 8.0, 'backdrop-color': '#000000', 'backdrop-opacity': 0.97,
        'backdrop-pattern': 'scanlines', 'pattern-opacity': 0.14, 'pattern-spacing': 4.0,
        'search-style': 'square', 'search-prompt': 'chevron',
        'show-vignette': true, 'open-animation': 'rise', 'ambient-animation': 'none', 'min-scale': 0.45,
    }},
    minimal: {name: 'Flat & Minimal', values: {
        'theme': 'mono', 'shape': 'circle', 'layout': 'grid', 'tile-style': 'solid', 'tile-opacity': 0.14,
        'tile-sheen': false, 'border-width': 0.0, 'show-empty': false, 'hover-effect': 'fill',
        'show-vignette': false, 'open-animation': 'fade', 'min-scale': 0.5, 'ambient-animation': 'none',
    }},
};
