// SPDX-FileCopyrightText: 2026 iShowSomeone
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Real-time refraction for the liquid-glass tiles.
//
// How it works
//   * When the Hive opens, the desktop is captured once (Shell.Screenshot → a GPU texture, no CPU copy).
//   * Every glass tile contains a clip container that shows that snapshot, shifted/scaled each frame so the
//     right piece of the desktop appears exactly under the tile as it moves, grows or shrinks (fisheye, pan).
//   * A GLSL fragment shader on that container bends the image like a thick lens: samples near the edge are
//     pulled in from outside the tile (strong at the rim, none in the middle), the middle is magnified a
//     little, red/green/blue are split slightly (chromatic fringing), and a small blur frosts the result.
//     The tile outline is a superellipse evaluated in the shader, so edges are anti-aliased with no mask.
//   * The Cairo-rendered highlights (rim light, crescents, shadow) sit on top as a separate image.
//
// Costs are bounded: tiles smaller than a threshold, hidden or off-screen skip the effect; Clutter caches the
// offscreen render of a tile that did not move, so a still Hive is nearly free.
//
// If anything here fails (no shader support, capture error) the Hive silently falls back to plain glass.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const LOG = '[hive-launcher]';


const NAMES = ['hx', 'hy', 'nExp', 'aaw', 'strength', 'frost', 'chroma', 'vibrance', 'tintR', 'tintG', 'tintB', 'tintA', 'edge', 'glow'];

const UNIFORMS = NAMES.map(n => `uniform float ${n};`).join('\n');

// The lens itself, independent of how the shader gets attached. HIVE_TEX(uv) samples the tile's offscreen image.
const CORE = `
vec3 hiveTap(vec2 uv) {
    vec3 c = HIVE_TEX(uv).rgb;
    c += HIVE_TEX(uv + vec2( frost, 0.0)).rgb;
    c += HIVE_TEX(uv + vec2(-frost, 0.0)).rgb;
    c += HIVE_TEX(uv + vec2(0.0,  frost)).rgb;
    c += HIVE_TEX(uv + vec2(0.0, -frost)).rgb;
    return c * 0.2;
}

vec4 hiveRefract(vec2 uv) {
    vec2 p = uv - vec2(0.5);
    vec2 q = vec2(abs(p.x) / hx, abs(p.y) / hy);
    float r = pow(pow(q.x, nExp) + pow(q.y, nExp), 1.0 / nExp);
    float mask = 1.0 - smoothstep(1.0 - aaw, 1.0, r);
    if (mask <= 0.0)
        return vec4(0.0);

    float depth = clamp(1.0 - r, 0.0, 1.0);
    float rim = pow(1.0 - clamp(depth / max(edge, 0.05), 0.0, 1.0), 2.0);

    // outward direction = gradient of the superellipse
    vec2 g = vec2(sign(p.x) * pow(q.x + 1e-4, nExp - 1.0) / hx,
                  sign(p.y) * pow(q.y + 1e-4, nExp - 1.0) / hy);
    vec2 dir = g / (length(g) + 1e-5);

    // gentle magnification in the middle, strong bending at the rim
    vec2 base = vec2(0.5) + p * (1.0 - 0.035 * smoothstep(0.0, 1.0, depth));
    vec2 suv = base + dir * rim * strength;
    vec2 dc = dir * rim * chroma;

    vec3 col;
    col.r = hiveTap(suv + dc).r;
    col.g = hiveTap(suv).g;
    col.b = hiveTap(suv - dc).b;

    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, vibrance);
    col = mix(col, vec3(tintR, tintG, tintB), tintA);
    col += vec3(glow * rim);   // light caught in the lens rim
    return vec4(col * mask, mask);
}
`;

const DEFAULTS = {
    hx: 0.43, hy: 0.43, nExp: 5, aaw: 0.02, strength: 0.08, frost: 0.02, chroma: 0.01,
    vibrance: 1.25, tintR: 0, tintG: 0, tintB: 0, tintA: 0, edge: 0.5, glow: 0,
};

// ---- strategy A: Clutter.ShaderEffect with set_shader_source() (older shells) ----------------------------------
const SOURCE_A = `
#define HIVE_TEX(uv) texture2D(tex, uv)
uniform sampler2D tex;
uniform float alpha;
${UNIFORMS}
${CORE}
void main() {
    cogl_color_out = hiveRefract(cogl_tex_coord_in[0].xy) * alpha;
}
`;

function makeClassA() {
    return GObject.registerClass(
    class HiveRefractEffectA extends Clutter.ShaderEffect {
        _init() {
            if (Clutter.ShaderType?.FRAGMENT_SHADER !== undefined)
                super._init({shader_type: Clutter.ShaderType.FRAGMENT_SHADER});
            else
                super._init();
            this._u = {...DEFAULTS, alpha: 1};
            this._logged = false;
            this.set_shader_source(SOURCE_A);
        }

        setUniforms(values) {
            Object.assign(this._u, values);
            this.queue_repaint();
        }

        vfunc_paint_target(node, paintContext) {
            try {
                // sampler index must reach GLSL as an int; floats must be non-integers so GJS boxes them as doubles
                this.set_uniform_value('tex', 0);
                const actor = this.get_actor();
                this._u.alpha = Math.max(actor ? actor.get_paint_opacity() / 255 : 1, 0.001);
                for (const [name, value] of Object.entries(this._u))
                    this.set_uniform_value(name, value + 1e-6);
                if (!this._logged) {
                    this._logged = true;
                }
            } catch (e) {
                console.error(`${LOG} refraction uniforms failed: ${e}`);
            }
            super.vfunc_paint_target(node, paintContext);
        }
    });
}

// ---- strategies B/C: a pipeline-snippet effect (Shell.GLSLEffect, or the newer Clutter.ShaderEffect that replaced it)
function snippetHook() {
    for (const ns of [Shell, Clutter, Cogl]) {
        const h = ns?.SnippetHook;
        if (h && h.FRAGMENT !== undefined)
            return h.FRAGMENT;
    }
    return undefined;
}

function makeSnippetClass(Base, label) {
    return GObject.registerClass(
    class HiveRefractEffectSnippet extends Base {
        _init() {
            super._init();
            this._u = {...DEFAULTS};
            this._loc = null;
            this._dirty = true;
            this._logged = false;
        }

        vfunc_build_pipeline() {
            const decl = `#define HIVE_TEX(uv) texture2D(cogl_sampler0, uv)\n${UNIFORMS}\n${CORE}`;
            // runs after the default lookup, so cogl_color_out.a already carries the actor's paint opacity
            const code = 'cogl_color_out = hiveRefract(cogl_tex_coord_in[0].xy) * cogl_color_out.a;';
            const hook = snippetHook();
            if (typeof this.add_glsl_snippet === 'function') {
                this.add_glsl_snippet(hook, decl, code, false);
            } else if (Cogl?.Snippet) {
                const snip = typeof Cogl.Snippet.new === 'function' ? Cogl.Snippet.new(hook, decl, code) : new Cogl.Snippet(hook, decl, code);
                this.get_pipeline().add_snippet(snip);
            } else {
                throw new Error('no way to attach a GLSL snippet');
            }
            this._loc = null;
            this._dirty = true;
        }

        _locations() {
            if (this._loc)
                return this._loc;
            const loc = {};
            for (const n of NAMES) {
                let l;
                if (typeof this.get_uniform_location === 'function')
                    l = this.get_uniform_location(n);
                else
                    l = this.get_pipeline().get_uniform_location(n);
                if (l === undefined || l === null || l < 0)
                    throw new Error(`uniform ${n} not found`);
                loc[n] = l;
            }
            this._loc = loc;
            return loc;
        }

        _push() {
            try {
                const loc = this._locations();
                for (const n of NAMES)
                    this.set_uniform_float(loc[n], 1, [this._u[n] + 1e-6]);
                this._dirty = false;
            } catch (e) {
                if (!this._warned) {
                    this._warned = true;
                    console.warn(`${LOG} refraction (${label}): cannot set uniforms yet: ${e}`);
                }
            }
        }

        setUniforms(values) {
            Object.assign(this._u, values);
            this._dirty = true;
            this.queue_repaint();
        }

        vfunc_paint_target(node, paintContext) {
            if (this._dirty)
                this._push();
            if (!this._logged) {
                this._logged = true;
            }
            super.vfunc_paint_target(node, paintContext);
        }
    });
}

// ---- strategy D: plain Clutter.OffscreenEffect + a Cogl snippet attached to its pipeline ---------------------------
// (newer Mutter has no ShaderEffect source API and no overridable shader vfuncs, so we do it by hand)
function makeOffscreenClass() {
    return GObject.registerClass(
    class HiveRefractEffectOffscreen extends Clutter.OffscreenEffect {
        _init() {
            super._init();
            this._u = {...DEFAULTS};
            this._ready = false;
            this._pipe = null;
            this._loc = null;
            this._poll = 0;
            this._tries = 0;
            this._warned = false;
        }

        /** Attach the shader to the effect's pipeline once that exists; returns true when it is in place. */
        ensure() {
            if (this._ready)
                return true;
            try {
                const pipe = this.get_pipeline();
                if (!pipe)
                    throw new Error('pipeline not created yet');
                const loc = {};
                for (const n of NAMES)
                    loc[n] = pipe.get_uniform_location(n);
                const decl = `#define HIVE_TEX(uv) texture2D(cogl_sampler0, uv)\n${UNIFORMS}\n${CORE}`;
                // runs after the default texture lookup, so cogl_color_out.a already carries the paint opacity
                const code = 'cogl_color_out = hiveRefract(cogl_tex_coord_in[0].xy) * cogl_color_out.a;';
                const snip = typeof Cogl.Snippet.new === 'function'
                    ? Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, code)
                    : new Cogl.Snippet(Cogl.SnippetHook.FRAGMENT, decl, code);
                pipe.add_snippet(snip);
                this._pipe = pipe;
                this._loc = loc;
                this._ready = true;
                this._push();
            } catch (e) {
                if (!this._warned) {
                    this._warned = true;
                    console.warn(`${LOG} refraction: shader not attached yet (will retry): ${e}`);
                }
                this._startPoll();
            }
            return this._ready;
        }

        _startPoll() {
            if (this._poll || this._ready)
                return;
            this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._tries++;
                if (this.ensure() || this._tries > 300 || (!this.get_actor() && this._tries > 5)) {
                    this._poll = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }

        _push() {
            if (!this._ready)
                return;
            try {
                for (const n of NAMES)
                    this._pipe.set_uniform_1f(this._loc[n], this._u[n] + 1e-6);
                this.queue_repaint();
            } catch (e) {
                console.warn(`${LOG} refraction: cannot set uniforms: ${e}`);
            }
        }

        setUniforms(values) {
            Object.assign(this._u, values);
            if (this._ready)
                this._push();
            else
                this.ensure();
        }
    });
}

let _cls = null;      // {Class, mode} once resolved

function resolveClass() {
    if (_cls)
        return _cls;
    const attempts = [];
    if (typeof Clutter.ShaderEffect === 'function' && typeof Clutter.ShaderEffect.prototype.set_shader_source === 'function')
        attempts.push(['ShaderEffect', makeClassA]);
    if (typeof Shell.GLSLEffect === 'function')
        attempts.push(['GLSLEffect', () => makeSnippetClass(Shell.GLSLEffect, 'GLSLEffect')]);
    if (Cogl?.Snippet && Cogl?.SnippetHook && typeof Clutter.OffscreenEffect === 'function')
        attempts.push(['OffscreenEffect+snippet', makeOffscreenClass]);
    for (const [mode, make] of attempts) {
        try {
            const Class = make();
            const probe = new Class(); // throws if this strategy does not work in this shell
            if (probe) {
                _cls = {Class, mode};
                return _cls;
            }
        } catch (e) {
            console.warn(`${LOG} refraction: ${mode} strategy failed: ${e}\n${e.stack ?? ''}`);
        }
    }
    return null;
}

/** A fresh refraction effect, or null when this shell offers no usable shader API. */
export function createRefractEffect() {
    const c = resolveClass();
    return c ? new c.Class() : null;
}

/** Can we create the effect at all? (Shader compilation itself happens on first paint.) */
export function refractionSupported() {
    const ok = !!resolveClass();
    if (!ok)
        console.warn(`${LOG} refraction: no usable shader API in this shell, using plain glass`);
    return ok;
}

/**
 * Capture the whole stage as a texture-backed Clutter.Content. The Hive must be hidden while this runs.
 * Resolves with the content, or rejects if the shell refuses.
 */
export function captureStage() {
    return new Promise((resolve, reject) => {
        try {
            const shot = new Shell.Screenshot();
            shot.screenshot_stage_to_content((_obj, res) => {
                try {
                    const out = shot.screenshot_stage_to_content_finish(res);
                    const content = Array.isArray(out) ? out[0] : out;
                    resolve(content);
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}
