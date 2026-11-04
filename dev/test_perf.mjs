// Pure tests for perf.js:  node dev/test_perf.mjs
import assert from 'node:assert/strict';
import {PerfLog, Series, percentile, trimLog, JANK_MS, IDLE_GAP_MS} from '../perf.js';

let n = 0;
const test = (name, fn) => { fn(); n++; };
let t = 1000;
const clock = () => t;
const tick = (log, dt, f = {}) => { t += dt; log.frame({work: 1, map: 0.5, flags: ['pan'], ...f}); };

test('percentile and Series: totals cover every sample, percentiles the latest window', () => {
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4], 100), 4);
    const s = new Series(4);
    for (const v of [1, 2, 3, 4, 100, 5]) s.push(v);
    s.push(NaN);
    const st = s.stats();
    assert.equal(st.n, 6); assert.equal(st.max, 100); assert.equal(st.total, 115);
    assert.equal(s.win.length, 4);
});
test('nothing is recorded outside a session and end() without a session is empty', () => {
    const log = new PerfLog(clock);
    log.frame({work: 1}); log.phase('x', 5); log.count('c'); log.note('n');
    assert.equal(log.end(), ''); assert.equal(log.active, false);
});
test('frames: interval stats, jank/hitch, idle gaps are not frames, worst frames keep their context', () => {
    const log = new PerfLog(clock); log.begin({when: 'now', shell: '49'}, {shape: 'hexagon'});
    for (let i = 0; i < 100; i++) tick(log, 16.7);
    tick(log, 40, {work: 12, flags: ['lift', 'edit'], drawMs: 9, draws: 14});
    tick(log, 80, {work: 30, flags: ['open-anim']});
    tick(log, IDLE_GAP_MS + 500);        // the loop was idle: not a slow frame
    const s = log.session;
    assert.equal(s.frames, 103); assert.equal(s.idleGaps, 1); assert.equal(s.jank, 2); assert.equal(s.hitch, 1);
    assert.equal(s.worst[0].interval, 80); assert.deepEqual(s.worst[1].flags, ['lift', 'edit']);
    assert.ok(s.byState.get('lift').frames === 1 && s.byState.get('pan').frames === 101);
    const text = log.end();
    assert.match(text, /=== Hive perf session #1 · now/); assert.match(text, /env: shell=49/); assert.match(text, /settings: shape=hexagon/);
    assert.match(text, /jank\(>25ms\) 2 {2}hitch\(>50ms\) 1/); assert.match(text, /slowest frames:/); assert.match(text, /\[lift,edit\]/);
});
test('phases, counters, gauges, notes, scene, process samples all reach the report', () => {
    const log = new PerfLog(clock); log.begin(); t = 5000;
    log.phase('rebuild', 40); log.phase('rebuild', 20); log.phase('applyLayout', 3);
    log.count('rebuilds'); log.count('rebuilds'); log.gauge('cells', 271); log.gauge('cells', 100);
    log.scene({apps: 87}); log.note('drag start');
    log.proc({rssKb: 200 * 1024, cpuMs: 0}); t += 4000; log.proc({rssKb: 260 * 1024, cpuMs: 2400});
    t += 10;
    const text = log.end();
    assert.match(text, /rebuild +n= +2 +avg +30\.00/); assert.match(text, /counters: rebuilds=2/); assert.match(text, /max cells=271/);
    assert.match(text, /scene: apps=87/); assert.match(text, /events:\n {2}t\+[\d.]+s {2}drag start/);
    assert.match(text, /RSS 200\.0 -> 260\.0 MB \(peak 260\.0\) {2}shell CPU while open 60\.0%/);
    assert.match(text, /Memory: the shell process grew by 60 MB/); assert.match(text, /CPU: the shell process used 60%/);
});
test('hints name the likely hotspot: callback-bound vs paint-bound vs painting cost vs slow opening', () => {
    const run = (frame, extra = () => {}) => {
        t = 0; const log = new PerfLog(clock); log.begin();
        for (let i = 0; i < 60; i++) { t += frame.interval; log.frame({flags: ['pan'], ...frame}); }
        extra(log); return log.end();
    };
    assert.match(run({interval: 16.7, work: 1}), /Smoothness: fine/);
    assert.match(run({interval: 40, work: 20}), /optimise _tick/);
    assert.match(run({interval: 40, work: 1}), /painting \/ compositing \/ the GPU/);
    assert.match(run({interval: 16.7, work: 1, drawMs: 7, draws: 30}), /cache the tile drawing/);
    assert.match(run({interval: 16.7, work: 1, repaints: 80}), /Repaint churn/);
    t = 0; const log = new PerfLog(clock); log.begin(); t += 600; log.frame({work: 1}); log.phase('desktopCapture', 410);
    const text = log.end(); assert.match(text, /first frame after 600 ms/); assert.match(text, /Phase "desktopCapture" peaked at 410 ms/); assert.match(text, /Too few frames/);
});
test('sessions are numbered and a new begin() starts clean; trimLog keeps the newest whole sessions', () => {
    const log = new PerfLog(clock);
    log.begin(); log.count('a'); log.end(); log.begin(); assert.equal(log.session.no, 2); assert.equal(log.session.counters.size, 0);
    const big = Array.from({length: 40}, (_, i) => `=== Hive perf session #${i} ===\n${'x'.repeat(500)}\n`).join('');
    const trimmed = trimLog(big, 8000);
    assert.ok(trimmed.length < big.length && trimmed.startsWith('=== Hive perf session'));
    assert.equal(trimLog('short', 8000), 'short');
    assert.ok(JANK_MS < 50);
});
test('system facts, pressure samples, repaint reasons and tier hints reach the report', () => {
    const log = new PerfLog(clock); log.begin({when: 'now'}); t = 9000;
    log.sys({cpu: 'Test CPU', threads: 16, tier: 'lite', tierReason: 'cpu pressure 55%'});
    log.pressure({cpu: 55, io: 3, mem: 0, load: 9.5, gpu: -1}, 'open');
    log.pressure({cpu: 20, io: 1, mem: 0, load: 4, gpu: 70}, 'close');
    log.reason('theme', 80); log.reason('hover', 3); log.reason('theme', 2);
    for (let i = 0; i < 40; i++) tick(log, 16.7);
    const text = log.end();
    assert.match(text, /system: cpu=Test CPU · threads=16 · tier=lite/);
    assert.match(text, /pressure \(PSI some-avg10/); assert.match(text, /open +cpu 55\.0 +io 3\.0/); assert.match(text, /gpu 70/);
    assert.match(text, /repaint reasons: theme=82 {2}hover=3/);
    assert.match(text, /Quality tier: "lite"/); assert.match(text, /under pressure during this session/);
    const calm = new PerfLog(clock); calm.begin(); calm.sys({tier: 'full'}); calm.pressure({cpu: 1, io: 0, mem: 0, load: 0.2, gpu: -1}, 'open');
    for (let i = 0; i < 40; i++) tick(calm, 16.7);
    const t2 = calm.end();
    assert.doesNotMatch(t2, /Quality tier/); assert.doesNotMatch(t2, /under pressure/);
    // nothing outside a session
    const off = new PerfLog(clock); off.sys({a: 1}); off.pressure({cpu: 1}); off.reason('x');
    assert.equal(off.end(), '');
});
console.log(`perf: all ${n} tests passed`);
