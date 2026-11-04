// 1.10 look details drawn by shapes.js, exercised against a recording cairo context (no GNOME needed):
//   node --import ./dev/register.mjs dev/test_look.mjs
import assert from 'node:assert/strict';
const S = await import('../shapes.js');
const {G, configure, drawCell, drawVignette, drawBackdropPattern, bracketHalf} = S;
let n = 0;
const test = (name, fn) => { fn(); n++; };

function fakeCr() {
    const calls = [];
    const cr = new Proxy({}, {
        get(_t, name) {
            if (name === '$dispose') return () => {};
            if (name === 'textExtents') return () => ({width: 10, height: 8, xBearing: 0, yBearing: -8});
            if (name === 'calls') return calls;
            return (...a) => { calls.push([String(name), ...a]); return undefined; };
        },
    });
    return {cr, calls};
}
const area = (w = 128, h = 128) => { const f = fakeCr(); return {area: {get_context: () => f.cr, get_surface_size: () => [w, h]}, calls: f.calls}; };
const base = () => ({
    shape: 'rounded', layout: 'grid', logo: 'ring', labels: 'auto', theme: 'tokyo', accent: '', systemAccent: '', tileSize: 1, gap: 5, iconScale: 1, minScale: 0.3, zoom: 1,
    tileStyle: 'gradient', tileOpacity: 0.85, tileColor: '', sheen: true, hoverEffect: 'glow', hoverScale: 1.16, corner: 0.2, runningStyle: 'both', borderWidth: 1.3,
    borderStyle: 'solid', borderMode: 'accent', borderColor: '', borderOpacity: 0.3, animSpeed: 1, widget: 'logo', vignette: true,
});
const cell = (kind, extra = {}) => ({kind, hover: 0, pulse: 1, running: false, hue: 0.3, ld: [0, -1], ...extra});

test('every tile style x hover effect x centre style draws without throwing', () => {
    for (const style of ['gradient', 'solid', 'glass', 'neon', 'soft', 'holo', 'outline', 'accent', 'brackets'])
        for (const hv of ['glow', 'fill', 'shine', 'none', 'invert'])
            for (const cs of ['filled', 'outline', 'transparent']) {
                configure({...base(), tileStyle: style, hoverEffect: hv, centerStyle: cs});
                for (const kind of ['app', 'logo', 'empty'])
                    for (const hover of [0, 1]) {
                        const a = area();
                        assert.doesNotThrow(() => drawCell(cell(kind, {hover, running: hover === 1}), a.area), `${style}/${hv}/${cs}/${kind}`);
                        assert.ok(a.calls.length > 0);
                    }
            }
});
test('brackets: four corner ticks, no full outline; the ticks sit inside every shape', () => {
    for (const shape of ['hexagon', 'circle', 'rounded', 'squircle', 'diamond', 'octagon']) {
        configure({...base(), shape, tileStyle: 'brackets'});
        const a = bracketHalf(shape, G.HEX_R);
        assert.ok(a > 0 && a <= G.HEX_R, `${shape}: ${a}`);
        const {area: ar, calls} = area();
        drawCell(cell('app'), ar);
        const lineTos = calls.filter(c => c[0] === 'lineTo');
        assert.ok(lineTos.length >= 8, `${shape}: corner ticks drawn`);
    }
});
test('inverse-video hover fills with the accent, glow does not', () => {
    configure({...base(), tileStyle: 'solid', hoverEffect: 'invert'});
    const inv = area(); drawCell(cell('app', {hover: 1}), inv.area);
    assert.ok(inv.calls.some(c => c[0] === 'setSourceRGBA' && Math.abs(c[4] - 0.92) < 1e-9), 'opaque accent fill');
    configure({...base(), tileStyle: 'solid', hoverEffect: 'none'});
    const none = area(); drawCell(cell('app', {hover: 1}), none.area);
    assert.ok(!none.calls.some(c => c[0] === 'setSourceRGBA' && Math.abs(c[4] - 0.92) < 1e-9));
});
test('centre tile: outline / transparent never paint the loud accent slab', () => {
    configure({...base(), centerStyle: 'filled'});
    const f = area(); drawCell(cell('logo'), f.calls && f.area);
    assert.ok(f.calls.some(c => c[0] === 'setSource'), 'filled uses the accent gradient');
    for (const cs of ['outline', 'transparent']) {
        configure({...base(), centerStyle: cs});
        const o = area(); drawCell(cell('logo'), o.area);
        assert.ok(!o.calls.some(c => c[0] === 'setSource'), `${cs}: no gradient slab`);
    }
});
test('backdrop pattern: bounded primitive counts, nothing for none, vignette optional', () => {
    const count = (kind, w, h, sp) => { const f = fakeCr(); drawBackdropPattern(f.cr, w, h, kind, 0.2, sp, [1, 1, 1]); return f.calls.filter(c => c[0] === 'moveTo' || c[0] === 'arc').length; };
    assert.equal(count('none', 1920, 1080, 24), 0);
    const grid = count('grid-paper', 1920, 1080, 24); assert.ok(grid > 100 && grid < 400, `grid ${grid}`);
    assert.ok(count('grid-paper', 1920, 1080, 24) > count('grid-paper', 1920, 1080, 48));
    assert.ok(count('scanlines', 1920, 1080, 4) > 200 && count('scanlines', 1920, 1080, 4) < 600);
    assert.ok(count('grid-paper', 3840, 2160, 1) < 1500, 'a tiny spacing is clamped, never millions of lines');
    assert.ok(count('dots', 3840, 2160, 1) < 40000, 'dots are clamped too');
    configure({...base(), pattern: 'scanlines', patternSpacing: 4, patternOpacity: 0.14, vignette: false});
    let a = area(1920, 1080); drawVignette(a.area);
    assert.ok(a.calls.some(c => c[0] === 'moveTo') && !a.calls.some(c => c[0] === 'rectangle'), 'pattern only, no vignette');
    configure({...base(), pattern: 'none', vignette: true});
    a = area(1920, 1080); drawVignette(a.area);
    assert.ok(a.calls.some(c => c[0] === 'rectangle') && !a.calls.some(c => c[0] === 'moveTo'), 'vignette only');
});
test('configure reads the new options with safe defaults and clamps', () => {
    configure({...base()});
    assert.equal(G.CENTER_STYLE, 'filled'); assert.equal(G.PATTERN, 'none'); assert.equal(G.LABEL_UPPER, false);
    configure({...base(), patternOpacity: 9, patternSpacing: -3, labelCase: 'upper', pattern: 'dots'});
    assert.equal(G.PATTERN_A, 0.6); assert.equal(G.PATTERN_SP, 2); assert.equal(G.LABEL_UPPER, true); assert.equal(G.PATTERN, 'dots');
});
{
    const {createTintEffect} = await import('../tint.js');
    test('tint.js: original = no effect; mono / accent / custom give an effect and never throw', () => {
        assert.equal(createTintEffect('original', [1, 1, 1]), null);
        for (const m of ['mono', 'accent', 'custom'])
            assert.doesNotThrow(() => createTintEffect(m, [0.2, 1, 0.5]));
        assert.ok(createTintEffect('accent', [0.2, 1, 0.5]));
        assert.doesNotThrow(() => createTintEffect('accent', [9, -3, NaN]), 'out-of-range colours are clamped');
    });
}
console.log(`look: all ${n} tests passed`);
