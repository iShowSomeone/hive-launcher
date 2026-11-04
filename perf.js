// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Performance log for the Hive (pure: no imports; tested in dev/test_perf.mjs).
//
// Turned on with the `perf-log` setting. hive.js feeds it frame timings, timings of its own phases (rebuild, layout, theme,
// desktop capture, edit actions ...), counters and process samples; at close it formats ONE text report per open session
// (appended to ~/.cache/hive-launcher/perf.log). The report ends with "hints": plain-language pointers at the most likely
// hotspot, so a person (or an assistant) reading the log can decide what to optimise first.
//
// All times are milliseconds. A "frame" is one run of the Hive's frame callback; gaps longer than IDLE_GAP_MS are not
// frames in the sense of smoothness (the loop had gone idle) and are counted separately.

export const IDLE_GAP_MS = 250;   // longer than this between two ticks = the loop was idle, not a slow frame
export const JANK_MS = 25;        // a frame slower than ~40 fps
export const HITCH_MS = 50;       // a frame slower than 20 fps
export const WORST_KEPT = 8;

const SERIES_CAP = 1200;

export function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
    return sorted[i];
}

/** Running totals for ALL samples + a bounded window of the latest ones for percentiles. */
export class Series {
    constructor(cap = SERIES_CAP) {
        this.cap = cap;
        this.win = [];
        this.n = 0;
        this.sum = 0;
        this.max = 0;
    }

    push(v) {
        if (!Number.isFinite(v))
            return;
        this.n++;
        this.sum += v;
        if (v > this.max)
            this.max = v;
        if (this.win.length < this.cap)
            this.win.push(v);
        else
            this.win[this.n % this.cap] = v;
    }

    stats() {
        const s = [...this.win].sort((a, b) => a - b);
        return {
            n: this.n, avg: this.n ? this.sum / this.n : 0, total: this.sum, max: this.max,
            p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99),
        };
    }
}

const fixed = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

export class PerfLog {
    /** `nowMs`: monotonic clock in ms (injected so tests control time). */
    constructor(nowMs) {
        this._now = nowMs;
        this._sessionNo = 0;
        this.session = null;
    }

    get active() {
        return this.session !== null;
    }

    /** Start a session (one Hive open). `env` = free-form {key: value} shown in the header. */
    begin(env = {}, settings = {}) {
        this._sessionNo++;
        this.session = {
            no: this._sessionNo, t0: this._now(), env, settings, scene: {},
            interval: new Series(), work: new Series(), map: new Series(), drawMs: new Series(), draws: new Series(), repaints: new Series(),
            frames: 0, idleGaps: 0, jank: 0, hitch: 0, activeMs: 0, lastTick: 0,
            byState: new Map(), phases: new Map(), counters: new Map(), gauges: new Map(), notes: [], worst: [], proc: [],
            firstFrameMs: null, sys: {}, psi: [], reasons: new Map(),
        };
        return this.session;
    }

    /** Settings summary shown in the report header (filled in after the session starts, once the options of this open are known). */
    describe(obj) {
        if (this.session)
            Object.assign(this.session.settings, obj);
    }

    scene(obj) {
        if (this.session)
            Object.assign(this.session.scene, obj);
    }

    /** Time of a discrete piece of work (rebuild, applyLayout, desktop capture, a drop ...). */
    phase(name, ms) {
        const s = this.session;
        if (!s)
            return;
        let ser = s.phases.get(name);
        if (!ser) {
            ser = new Series(400);
            s.phases.set(name, ser);
        }
        ser.push(ms);
    }

    count(name, n = 1) {
        const s = this.session;
        if (s)
            s.counters.set(name, (s.counters.get(name) ?? 0) + n);
    }

    /** Keeps the maximum seen (cells, actors ...). */
    gauge(name, v) {
        const s = this.session;
        if (s)
            s.gauges.set(name, Math.max(s.gauges.get(name) ?? 0, v));
    }

    note(text) {
        const s = this.session;
        if (s && s.notes.length < 60)
            s.notes.push({t: this._now() - s.t0, text});
    }

    /** {rssKb, cpuMs}: process sample (resident memory, accumulated CPU time of the shell process). */
    proc(sample) {
        const s = this.session;
        if (s && s.proc.length < 400)
            s.proc.push({t: this._now() - s.t0, ...sample});
    }

    /** Static facts about the machine / governor for this session (cpu model, threads, tier, why ...). */
    sys(obj) {
        if (this.session)
            Object.assign(this.session.sys, obj);
    }

    /** Pressure sample: {cpu, io, mem} = PSI "some avg10" percentages, load = 1-minute load average, gpu = busy % or -1. */
    pressure(sample, label = '') {
        const s = this.session;
        if (s && s.psi.length < 200)
            s.psi.push({t: this._now() - s.t0, label, ...sample});
    }

    /** Why a tile repaint was queued (theme, hover, running, pulse ...): shows what causes paint spikes. */
    reason(name, n = 1) {
        const s = this.session;
        if (s)
            s.reasons.set(name, (s.reasons.get(name) ?? 0) + n);
    }

    /**
     * One frame callback. `f` = {work: ms spent in the callback, map: ms of the per-tile mapping part, flags: [state names],
     * repaints: tile repaints queued, draws: tile paints since the last frame, drawMs: time spent in them}.
     */
    frame(f) {
        const s = this.session;
        if (!s)
            return;
        const t = this._now();
        const interval = s.lastTick ? t - s.lastTick : 0;
        s.lastTick = t;
        s.frames++;
        s.work.push(f.work);
        if (f.map !== undefined)
            s.map.push(f.map);
        s.repaints.push(f.repaints ?? 0);
        s.draws.push(f.draws ?? 0);
        s.drawMs.push(f.drawMs ?? 0);
        const flags = f.flags?.length ? f.flags : ['idle-ambient'];
        const smooth = interval > 0 && interval <= IDLE_GAP_MS;
        if (interval > IDLE_GAP_MS)
            s.idleGaps++;
        if (smooth) {
            s.interval.push(interval);
            s.activeMs += interval;
            if (interval > JANK_MS)
                s.jank++;
            if (interval > HITCH_MS)
                s.hitch++;
        }
        for (const fl of flags) {
            let st = s.byState.get(fl);
            if (!st) {
                st = {frames: 0, interval: new Series(600), work: new Series(600), jank: 0};
                s.byState.set(fl, st);
            }
            st.frames++;
            st.work.push(f.work);
            if (smooth) {
                st.interval.push(interval);
                if (interval > JANK_MS)
                    st.jank++;
            }
        }
        if (smooth && interval > JANK_MS) { // remember the worst few, with what was going on
            s.worst.push({at: t - s.t0, interval, work: f.work, map: f.map, drawMs: f.drawMs ?? 0, draws: f.draws ?? 0, flags});
            s.worst.sort((a, b) => b.interval - a.interval);
            if (s.worst.length > WORST_KEPT)
                s.worst.length = WORST_KEPT;
        }
        if (s.firstFrameMs === null)
            s.firstFrameMs = t - s.t0;
    }

    /** Finish the session and return the formatted report (or '' when there was none). */
    end() {
        const s = this.session;
        if (!s)
            return '';
        s.durationMs = this._now() - s.t0;
        this.session = null;
        return formatSession(s);
    }
}

const row = (name, st, w = 22) => `  ${name.padEnd(w)} n=${String(st.n).padStart(5)}  avg ${fixed(st.avg, 2).padStart(7)}  p95 ${fixed(st.p95, 2).padStart(7)}  max ${fixed(st.max, 2).padStart(7)}  total ${fixed(st.total, 1).padStart(8)}`;

/** Plain-language pointers at the likely hotspots (thresholds are deliberately conservative). */
export function hints(s, stats) {
    const out = [];
    const f = stats;
    if (f.frames >= 30) {
        if (f.interval.p95 > JANK_MS)
            out.push(`Smoothness: 5% of frames took longer than ${fixed(f.interval.p95, 1)} ms (target 16.7 ms)${f.work.p95 > 8 ? ' and the Hive\'s own callback is a big part of it (work p95 ' + fixed(f.work.p95, 1) + ' ms): optimise _tick.' : '; the callback itself is cheap (work p95 ' + fixed(f.work.p95, 1) + ' ms), so the time goes to painting / compositing / the GPU.'}`);
        else
            out.push(`Smoothness: fine (frame interval p95 ${fixed(f.interval.p95, 1)} ms).`);
        if (f.drawMs.avg > 4)
            out.push(`Painting: tile repaints cost ${fixed(f.drawMs.avg, 1)} ms per frame on average (${fixed(f.draws.avg, 1)} tiles/frame): cache the tile drawing or repaint fewer tiles.`);
        if (f.repaints.avg > 40)
            out.push(`Repaint churn: ${fixed(f.repaints.avg, 0)} tile repaints are queued per frame on average; only tiles whose look changed need one.`);
        if (f.work.avg > 4)
            out.push(`Per-frame work averages ${fixed(f.work.avg, 1)} ms: the lens/layout mapping or actor updates are worth a profile.`);
    } else {
        out.push('Too few frames to judge smoothness (open the Hive and interact for a few seconds).');
    }
    if (s.firstFrameMs !== null && s.firstFrameMs > 250)
        out.push(`Opening: first frame after ${fixed(s.firstFrameMs, 0)} ms (feels sluggish above ~200 ms); see the phase table for the biggest contributor.`);
    const slow = [...s.phases].map(([n, ser]) => [n, ser.stats()]).filter(([, st]) => st.max > 40).sort((a, b) => b[1].max - a[1].max);
    for (const [n, st] of slow.slice(0, 3))
        out.push(`Phase "${n}" peaked at ${fixed(st.max, 0)} ms (avg ${fixed(st.avg, 1)} ms over ${st.n}x): a candidate to cache, defer or split.`);
    const procs = s.proc;
    if (procs.length >= 2) {
        const a = procs[0];
        const b = procs[procs.length - 1];
        const wall = b.t - a.t;
        if (wall > 1500 && b.cpuMs !== undefined && a.cpuMs !== undefined) {
            const cpu = (b.cpuMs - a.cpuMs) / wall * 100;
            if (cpu > 35)
                out.push(`CPU: the shell process used ${fixed(cpu, 0)}% of a core while the Hive was open (animations that never idle? check ambient / widget settings).`);
        }
        if (a.rssKb && b.rssKb && b.rssKb - a.rssKb > 30 * 1024)
            out.push(`Memory: the shell process grew by ${fixed((b.rssKb - a.rssKb) / 1024, 0)} MB during this session; compare with the next sessions to see whether it is released.`);
    }
    const sysI = s.sys ?? {};
    if (sysI.tier && sysI.tier !== 'full')
        out.push(`Quality tier: "${sysI.tier}" was used for this open (${sysI.tierReason ?? 'no reason recorded'}); animations / refraction / blur may have been reduced on purpose.`);
    const worstPsi = (s.psi ?? []).reduce((m, p) => Math.max(m, p.cpu ?? 0, p.io ?? 0, p.mem ?? 0), 0);
    if (worstPsi >= 15)
        out.push(`The machine was under pressure during this session (worst PSI some-avg10 ${fixed(worstPsi, 0)}%): slow frames here say more about the load than about the Hive. Compare with an idle session.`);
    if (s.firstFrameMs !== null && s.firstFrameMs > 50 && worstPsi < 15)
        out.push(`Target check: first frame ${fixed(s.firstFrameMs, 0)} ms on an idle machine (goal <= 50 ms); see the phase table (applyOptions / rebuild / applyTheme / present:*).`);
    if (f.idleGaps > 0 && f.frames > 0 && f.activeMs < 1500 && s.durationMs > 6000)
        out.push('The frame loop went idle between interactions (good: nothing runs while nothing moves).');
    return out;
}

export function formatSession(s) {
    const lines = [];
    const dur = s.durationMs;
    const stamp = s.env.when ?? '';
    lines.push(`=== Hive perf session #${s.no}${stamp ? ` · ${stamp}` : ''} · open ${fixed(dur / 1000, 1)} s ===`);
    const env = Object.entries(s.env).filter(([k]) => k !== 'when').map(([k, v]) => `${k}=${v}`).join(' · ');
    if (env)
        lines.push(`env: ${env}`);
    const set = Object.entries(s.settings).map(([k, v]) => `${k}=${v}`).join(' ');
    if (set)
        lines.push(`settings: ${set}`);
    const sy = Object.entries(s.sys ?? {}).map(([k, v]) => `${k}=${v}`).join(' · ');
    if (sy)
        lines.push(`system: ${sy}`);
    const sc = Object.entries(s.scene).map(([k, v]) => `${k}=${v}`).join(' ');
    const gg = [...s.gauges].map(([k, v]) => `max ${k}=${v}`).join(' ');
    if (sc || gg)
        lines.push(`scene: ${[sc, gg].filter(Boolean).join(' ')}`);

    const stats = {
        frames: s.frames, idleGaps: s.idleGaps, activeMs: s.activeMs,
        interval: s.interval.stats(), work: s.work.stats(), map: s.map.stats(), drawMs: s.drawMs.stats(), draws: s.draws.stats(), repaints: s.repaints.stats(),
    };
    lines.push('');
    lines.push(`open: first frame ${s.firstFrameMs === null ? '-' : `${fixed(s.firstFrameMs, 0)} ms after open()`}`);
    const fps = stats.activeMs > 0 ? (s.interval.n / (stats.activeMs / 1000)) : 0;
    lines.push(`frames: ${s.frames} total, ${fixed(stats.activeMs / 1000, 1)} s of continuous animation (${fixed(fps, 1)} fps), ${s.idleGaps} idle gaps`);
    lines.push(`  interval ms  p50 ${fixed(stats.interval.p50)}  p95 ${fixed(stats.interval.p95)}  p99 ${fixed(stats.interval.p99)}  max ${fixed(stats.interval.max)}   jank(>${JANK_MS}ms) ${s.jank}  hitch(>${HITCH_MS}ms) ${s.hitch}`);
    lines.push(`  callback ms  avg ${fixed(stats.work.avg, 2)}  p95 ${fixed(stats.work.p95, 2)}  max ${fixed(stats.work.max, 2)}   (mapping part avg ${fixed(stats.map.avg, 2)}, p95 ${fixed(stats.map.p95, 2)})`);
    lines.push(`  tile paints  ${fixed(stats.draws.avg, 1)} per frame, ${fixed(stats.drawMs.avg, 2)} ms per frame (p95 ${fixed(stats.drawMs.p95, 2)}); repaints queued ${fixed(stats.repaints.avg, 1)} per frame`);

    if (s.byState.size) {
        lines.push('');
        lines.push('by state (what the Hive was doing):');
        for (const [name, st] of [...s.byState].sort((a, b) => b[1].frames - a[1].frames)) {
            const i = st.interval.stats();
            const w = st.work.stats();
            lines.push(`  ${name.padEnd(14)} frames ${String(st.frames).padStart(5)}  interval p95 ${fixed(i.p95).padStart(6)}  work avg ${fixed(w.avg, 2).padStart(6)} p95 ${fixed(w.p95, 2).padStart(6)}  jank ${st.jank}`);
        }
    }
    if (s.phases.size) {
        lines.push('');
        lines.push('phases (ms):');
        for (const [name, ser] of [...s.phases].sort((a, b) => b[1].sum - a[1].sum))
            lines.push(row(name, ser.stats()));
    }
    if (s.reasons.size)
        lines.push(`repaint reasons: ${[...s.reasons].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    if (s.psi.length) {
        lines.push('pressure (PSI some-avg10 %, load1, gpu busy %):');
        for (const p of s.psi.slice(0, 12))
            lines.push(`  t+${fixed(p.t / 1000, 2)}s ${(p.label ?? '').padEnd(8)} cpu ${fixed(p.cpu ?? NaN, 1)}  io ${fixed(p.io ?? NaN, 1)}  mem ${fixed(p.mem ?? NaN, 1)}  load ${fixed(p.load ?? NaN, 2)}  gpu ${p.gpu === undefined || p.gpu < 0 ? '-' : fixed(p.gpu, 0)}`);
    }
    if (s.counters.size)
        lines.push(`counters: ${[...s.counters].map(([k, v]) => `${k}=${v}`).join('  ')}`);
    if (s.proc.length >= 1) {
        const a = s.proc[0];
        const b = s.proc[s.proc.length - 1];
        const peak = Math.max(...s.proc.map(p => p.rssKb ?? 0));
        const wall = b.t - a.t;
        const cpu = wall > 0 && a.cpuMs !== undefined && b.cpuMs !== undefined ? (b.cpuMs - a.cpuMs) / wall * 100 : NaN;
        lines.push(`process: RSS ${fixed((a.rssKb ?? 0) / 1024, 1)} -> ${fixed((b.rssKb ?? 0) / 1024, 1)} MB (peak ${fixed(peak / 1024, 1)})  shell CPU while open ${fixed(cpu, 1)}%`);
    }
    if (s.worst.length) {
        lines.push('');
        lines.push('slowest frames:');
        for (const w of s.worst)
            lines.push(`  t+${fixed(w.at / 1000, 2)}s  interval ${fixed(w.interval)} ms  callback ${fixed(w.work, 2)} (map ${fixed(w.map ?? NaN, 2)})  paints ${w.draws} (${fixed(w.drawMs, 2)} ms)  [${w.flags.join(',')}]`);
    }
    if (s.notes.length) {
        lines.push('');
        lines.push('events:');
        for (const n of s.notes)
            lines.push(`  t+${fixed(n.t / 1000, 2)}s  ${n.text}`);
    }
    lines.push('');
    lines.push('hints:');
    for (const h of hints(s, stats))
        lines.push(`  - ${h}`);
    lines.push('');
    return lines.join('\n');
}

/** Keep the log bounded: when it passes `max` characters keep the newest part, starting at a session header. */
export function trimLog(text, max = 400 * 1024) {
    if (text.length <= max)
        return text;
    const cut = text.indexOf('=== Hive perf session', text.length - Math.floor(max / 2));
    return cut >= 0 ? text.slice(cut) : text.slice(text.length - Math.floor(max / 2));
}
