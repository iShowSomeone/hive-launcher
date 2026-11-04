// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Load governor for the Hive (pure: no imports; tested in dev/test_governor.mjs).
//
// The Hive runs inside gnome-shell's single JavaScript thread, so when the machine is under heavy CPU / disk / memory / GPU
// pressure it cannot be made literally immune. What it CAN do is make its own cost small when the machine is busy.
// This module decides, at open time (and now and then while open), which quality TIER to use:
//
//   full      everything the user configured
//   balanced  no ambient animation, no live refraction, only cheap opening animations
//   lite      no animations at all (instant), no refraction, no blur, no ambient, no widget timer, captions after the first frame
//
// Inputs are plain numbers read by hive.js from Linux PSI (/proc/pressure/*, readable without root), the GPU busy counter
// (amdgpu only, optional) and the Hive's own recent open timings.

export const TIERS = ['full', 'balanced', 'lite'];
export const TIER_MODES = ['auto', ...TIERS];

/** "some avg10=1.23 avg60=0.50 avg300=0.10 total=123456" lines -> {some: {avg10, avg60, avg300, total}, full: {...}} (never throws). */
export function parsePressure(text) {
    const out = {some: {avg10: 0, avg60: 0, avg300: 0, total: 0}, full: {avg10: 0, avg60: 0, avg300: 0, total: 0}};
    if (typeof text !== 'string')
        return out;
    for (const line of text.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const kind = parts[0];
        if (kind !== 'some' && kind !== 'full')
            continue;
        for (const kv of parts.slice(1)) {
            const [k, v] = kv.split('=');
            const n = Number(v);
            if (k in out[kind] && Number.isFinite(n))
                out[kind][k] = n;
        }
    }
    return out;
}

/** "0.52 0.58 0.59 1/1234 56789" -> {l1, l5, l15} (zeros when unreadable). */
export function parseLoadavg(text) {
    const p = typeof text === 'string' ? text.trim().split(/\s+/) : [];
    const n = i => (Number.isFinite(Number(p[i])) ? Number(p[i]) : 0);
    return {l1: n(0), l5: n(1), l15: n(2)};
}

/** /proc/cpuinfo text -> {model, threads}. */
export function parseCpuInfo(text) {
    let model = '';
    let threads = 0;
    if (typeof text === 'string') {
        for (const line of text.split('\n')) {
            if (/^processor\s*:/.test(line))
                threads++;
            else if (!model && /^model name\s*:/.test(line))
                model = line.slice(line.indexOf(':') + 1).trim();
        }
    }
    return {model: model || 'unknown', threads};
}

/** A small ring of recent first-frame timings (ms): the Hive's own evidence that it is opening slowly. */
export class OpenHistory {
    constructor(cap = 6) {
        this.cap = cap;
        this.v = [];
    }

    push(ms) {
        if (!Number.isFinite(ms) || ms < 0)
            return;
        this.v.push(ms);
        if (this.v.length > this.cap)
            this.v.shift();
    }

    get size() {
        return this.v.length;
    }

    median() {
        if (!this.v.length)
            return 0;
        const s = [...this.v].sort((a, b) => a - b);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
}

// pressure thresholds (percent of time some task was stalled, avg10) for stepping up to a lower tier
export const LIMITS = {
    balanced: {cpu: 15, io: 12, mem: 8, gpu: 65, loadPerCore: 1.0, openMs: 220},
    lite: {cpu: 40, io: 30, mem: 20, gpu: 92, loadPerCore: 2.0, openMs: 450},
};
const HYSTERESIS = 0.7; // to leave a tier the pressure must fall below 70% of the threshold that entered it

const rank = t => Math.max(0, TIERS.indexOf(t));

/**
 * @param {object} i
 * @param {string} i.mode        'auto' | 'full' | 'balanced' | 'lite'
 * @param {object} [i.psi]       {cpu, io, mem}: each the parsePressure() result (the `some` avg10 value is used)
 * @param {number} [i.gpuBusy]   0..100 or undefined/-1 when unknown
 * @param {object} [i.load]      {l1} load average
 * @param {number} [i.threads]   CPU threads (for load per core)
 * @param {OpenHistory} [i.history]
 * @param {string} [i.prev]      the tier used last time (hysteresis)
 * @returns {{tier: string, reason: string}}
 */
export function decideTier(i) {
    const mode = TIER_MODES.includes(i.mode) ? i.mode : 'auto';
    if (mode !== 'auto')
        return {tier: mode, reason: 'manual'};
    const cpu = i.psi?.cpu?.some?.avg10 ?? 0;
    const io = i.psi?.io?.some?.avg10 ?? 0;
    const mem = i.psi?.mem?.some?.avg10 ?? 0;
    const gpu = Number.isFinite(i.gpuBusy) && i.gpuBusy >= 0 ? i.gpuBusy : 0;
    const lpc = i.threads > 0 && i.load ? i.load.l1 / i.threads : 0;
    const open = i.history && i.history.size >= 3 ? i.history.median() : 0;
    const prev = TIERS.includes(i.prev) ? i.prev : 'full';

    const test = (name, scale) => {
        const L = LIMITS[name];
        const why = [];
        if (cpu >= L.cpu * scale)
            why.push(`cpu pressure ${cpu.toFixed(0)}%`);
        if (io >= L.io * scale)
            why.push(`io pressure ${io.toFixed(0)}%`);
        if (mem >= L.mem * scale)
            why.push(`memory pressure ${mem.toFixed(0)}%`);
        if (gpu >= L.gpu * scale)
            why.push(`gpu busy ${gpu.toFixed(0)}%`);
        if (lpc >= L.loadPerCore * scale)
            why.push(`load ${lpc.toFixed(1)}/core`);
        if (open >= L.openMs * scale)
            why.push(`recent opens ${open.toFixed(0)} ms`);
        return why;
    };
    // staying in a heavier tier is easier than entering it (hysteresis), so the tier does not flap
    const liteWhy = test('lite', rank(prev) >= 2 ? HYSTERESIS : 1);
    if (liteWhy.length)
        return {tier: 'lite', reason: liteWhy.join(', ')};
    const balWhy = test('balanced', rank(prev) >= 1 ? HYSTERESIS : 1);
    if (balWhy.length)
        return {tier: 'balanced', reason: balWhy.join(', ')};
    return {tier: 'full', reason: 'machine is idle enough'};
}

const CHEAP_OPEN = new Set(['pop', 'fade', 'rise', 'zoom']);

/** What a tier takes away (the user's settings are never changed: the profile is applied on top of them in memory). */
export function tierProfile(tier) {
    switch (tier) {
    case 'lite':
        return {animations: false, ambient: 'none', refraction: false, blur: false, widgetTimer: false, deferLabels: true, cheapOpen: true};
    case 'balanced':
        return {animations: true, ambient: 'none', refraction: false, blur: true, widgetTimer: true, deferLabels: false, cheapOpen: true};
    default:
        return {animations: true, ambient: null, refraction: null, blur: true, widgetTimer: true, deferLabels: false, cheapOpen: false};
    }
}

/** Returns a copy of the options with the tier's restrictions applied (null in the profile = leave the user's value). */
export function applyTier(opts, tier) {
    const p = tierProfile(tier);
    const o = {...opts};
    if (!p.animations)
        o.animations = false;
    if (p.ambient !== null)
        o.ambient = p.ambient;
    if (p.refraction === false)
        o.refraction = false;
    if (p.cheapOpen && !CHEAP_OPEN.has(o.openAnim))
        o.openAnim = 'pop';
    o.tierBlur = p.blur;
    o.tierWidgets = p.widgetTimer;
    o.tierDeferLabels = p.deferLabels;
    o.tier = tier;
    return o;
}

/** Skip the live checks while open when the tier is manual; otherwise re-check at most this often. */
export const LIVE_CHECK_MS = 4000;

/** Live (while open) pressure check: only ever lowers quality (ambient / widget timer pause), never rebuilds anything. */
export function livePause(psi, gpuBusy) {
    const cpu = psi?.cpu?.some?.avg10 ?? 0;
    const io = psi?.io?.some?.avg10 ?? 0;
    const gpu = Number.isFinite(gpuBusy) && gpuBusy >= 0 ? gpuBusy : 0;
    return cpu >= LIMITS.balanced.cpu || io >= LIMITS.balanced.io || gpu >= LIMITS.balanced.gpu;
}
