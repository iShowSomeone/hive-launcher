import assert from 'node:assert/strict';
import {parsePressure, parseLoadavg, parseCpuInfo, OpenHistory, decideTier, tierProfile, applyTier, livePause, TIERS} from '../governor.js';

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('parsePressure reads real PSI text', () => {
    const p = parsePressure('some avg10=12.50 avg60=3.00 avg300=1.00 total=99\nfull avg10=2.00 avg60=0.00 avg300=0.00 total=5\n');
    assert.equal(p.some.avg10, 12.5);
    assert.equal(p.full.avg10, 2);
    assert.equal(p.some.total, 99);
});
t('parsePressure survives garbage', () => {
    for (const bad of [undefined, null, 5, '', 'nonsense', 'some avg10=abc', 'some avg10=', 'weird x=1']) {
        const p = parsePressure(bad);
        assert.equal(p.some.avg10, 0);
        assert.equal(p.full.avg10, 0);
    }
});
t('parseLoadavg + parseCpuInfo', () => {
    assert.deepEqual(parseLoadavg('0.52 0.58 0.59 1/1234 56789'), {l1: 0.52, l5: 0.58, l15: 0.59});
    assert.deepEqual(parseLoadavg('x'), {l1: 0, l5: 0, l15: 0});
    const c = parseCpuInfo('processor\t: 0\nmodel name\t: AMD Ryzen 7 5700G\nprocessor\t: 1\nmodel name\t: AMD Ryzen 7 5700G\n');
    assert.equal(c.threads, 2);
    assert.equal(c.model, 'AMD Ryzen 7 5700G');
    assert.deepEqual(parseCpuInfo(undefined), {model: 'unknown', threads: 0});
});
t('OpenHistory median is bounded and ignores junk', () => {
    const h = new OpenHistory(3);
    for (const v of [10, NaN, -5, 100, 200, 300, 400]) h.push(v);
    assert.equal(h.size, 3);
    assert.equal(h.median(), 300);
});
const idle = {cpu: parsePressure('some avg10=0.5'), io: parsePressure('some avg10=0'), mem: parsePressure('some avg10=0')};
t('manual modes are respected', () => {
    for (const m of TIERS) assert.equal(decideTier({mode: m, psi: idle}).tier, m);
    assert.equal(decideTier({mode: 'full', psi: {cpu: parsePressure('some avg10=99')}}).reason, 'manual');
});
t('auto: idle machine = full; pressure steps down with reasons', () => {
    assert.equal(decideTier({mode: 'auto', psi: idle}).tier, 'full');
    const bal = decideTier({mode: 'auto', psi: {...idle, cpu: parsePressure('some avg10=20')}});
    assert.equal(bal.tier, 'balanced');
    assert.match(bal.reason, /cpu pressure/);
    const lite = decideTier({mode: 'auto', psi: {...idle, io: parsePressure('some avg10=45')}});
    assert.equal(lite.tier, 'lite');
    assert.match(lite.reason, /io pressure/);
    assert.equal(decideTier({mode: 'auto', psi: idle, gpuBusy: 97}).tier, 'lite');
    assert.equal(decideTier({mode: 'auto', psi: idle, gpuBusy: -1}).tier, 'full');
    assert.equal(decideTier({mode: 'auto', psi: idle, load: {l1: 20}, threads: 8}).tier, 'lite');
});
t('auto: hysteresis keeps a heavy tier until pressure really falls', () => {
    const mid = {...idle, cpu: parsePressure('some avg10=32')}; // below 40 (enter lite) but above 0.7*40 = 28
    assert.equal(decideTier({mode: 'auto', psi: mid, prev: 'full'}).tier, 'balanced');
    assert.equal(decideTier({mode: 'auto', psi: mid, prev: 'lite'}).tier, 'lite');
    const low = {...idle, cpu: parsePressure('some avg10=12')}; // below 15 but above 0.7*15 = 10.5
    assert.equal(decideTier({mode: 'auto', psi: low, prev: 'full'}).tier, 'full');
    assert.equal(decideTier({mode: 'auto', psi: low, prev: 'balanced'}).tier, 'balanced');
});
t('auto: slow recent opens count as evidence (needs 3 samples)', () => {
    const h = new OpenHistory();
    h.push(900); h.push(900);
    assert.equal(decideTier({mode: 'auto', psi: idle, history: h}).tier, 'full');
    h.push(900);
    assert.equal(decideTier({mode: 'auto', psi: idle, history: h}).tier, 'lite');
});
t('unknown mode falls back to auto; bad inputs never throw', () => {
    assert.equal(decideTier({mode: 'nonsense', psi: idle}).tier, 'full');
    assert.equal(decideTier({mode: 'auto'}).tier, 'full');
    assert.equal(decideTier({}).tier, 'full');
});
t('applyTier never touches the original object and strips the right things', () => {
    const o = {animations: true, ambient: 'float', refraction: true, openAnim: 'materialize', blur: true};
    const copy = JSON.stringify(o);
    const full = applyTier(o, 'full');
    assert.equal(full.refraction, true); assert.equal(full.ambient, 'float'); assert.equal(full.openAnim, 'materialize');
    const bal = applyTier(o, 'balanced');
    assert.equal(bal.refraction, false); assert.equal(bal.ambient, 'none'); assert.equal(bal.openAnim, 'pop'); assert.equal(bal.animations, true);
    assert.equal(applyTier({...o, openAnim: 'fade'}, 'balanced').openAnim, 'fade');
    const lite = applyTier(o, 'lite');
    assert.equal(lite.animations, false); assert.equal(lite.tierBlur, false); assert.equal(lite.tierWidgets, false); assert.equal(lite.tierDeferLabels, true);
    assert.equal(JSON.stringify(o), copy);
    assert.equal(tierProfile('bogus').ambient, null);
});
t('livePause only reacts to real pressure', () => {
    assert.equal(livePause(idle, 5), false);
    assert.equal(livePause({...idle, cpu: parsePressure('some avg10=30')}, 0), true);
    assert.equal(livePause(idle, 80), true);
    assert.equal(livePause(undefined, undefined), false);
});
console.log(`governor: all ${n} tests passed`);
