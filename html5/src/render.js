// WebGL2 renderer: world geometry batched per texture, the Saturn-style sky
// dome (ported from progs/SlaveSkyDome.shader), billboard sprites and a 2D
// batch for the HUD and menus.

import { createProgram, TextureManager } from './gl.js';
import { mat4 } from './math.js';
import { FF, SF } from './mapfile.js';

const WORLD_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aColor;
uniform mat4 uMVP;
uniform float uColorScale;
uniform vec3 uViewOrg;
out vec2 vUV;
out vec4 vColor;
out vec3 vPos;
void main() {
    vUV = aUV;
    vColor = vec4(aColor.rgb * uColorScale, aColor.a);
    vPos = aPos;
    gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const WORLD_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
in vec3 vPos;
uniform sampler2D uTex;
uniform vec4 uTint;
uniform vec4 uFlash;
uniform float uAlphaRef;
uniform int uNumLights;
uniform vec4 uLightPos[8];
uniform vec3 uLightColor[8];
out vec4 frag;
void main() {
    vec4 c = texture(uTex, vUV);
    if (c.a <= uAlphaRef) discard;
    vec3 dyn = vec3(0.0);
    for (int i = 0; i < 8; ++i) {
        if (i >= uNumLights) break;
        float d = distance(vPos, uLightPos[i].xyz);
        float f = clamp(1.0 - d / uLightPos[i].w, 0.0, 1.0);
        dyn += uLightColor[i] * (f * f * (3.0 - 2.0 * f)) * 0.6;
    }
    vec4 o = c * vec4(vColor.rgb + dyn, vColor.a) * uTint;
    o.rgb = clamp(o.rgb + uFlash.rgb * uFlash.a, 0.0, 1.0);
    frag = o;
}`;

const SKY_VS = `#version 300 es
layout(location=0) in vec2 aPos;
uniform float uYaw;
uniform float uPitch;
out vec2 vTex;
out mat3 vRot;
mat3 lookRot(float yaw, float pitch) {
    vec2 s = vec2(sin(pitch), sin(yaw));
    vec2 c = vec2(cos(pitch), cos(yaw));
    // HLSL-style M(row, col) assignment, transposed for GLSL column-major
    return mat3(c.y, s.y * s.x, s.y * c.x,
                0.0, c.x, -s.x,
                -s.y, c.y * s.x, c.y * c.x);
}
void main() {
    vTex = aPos * 0.5 + 0.5;
    vRot = transpose(lookRot(-uYaw, uPitch));
    gl_Position = vec4(aPos, 0.9999, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vTex;
in mat3 vRot;
uniform sampler2D uTex;
uniform float uFOV;
uniform float uAspect;
uniform vec4 uTint;
out vec4 frag;
#define PI 3.14159265359
vec3 calcPrimaryRay(vec2 screen, float fovy, float aspect) {
    float d = 1.0 / tan(fovy / 2.0);
    return normalize(vec3(screen.x * aspect, screen.y, -d));
}
float myAtan2(float y, float x) {
    if (x > 0.0) return atan(y / x);
    else if (y > 0.0) return PI / 2.0 - atan(x / y);
    else if (y < 0.0) return -PI / 2.0 - atan(x / y);
    else if (x < 0.0) return atan(y / x) + PI;
    return 0.0;
}
vec2 dirToDomeUv(vec3 d) {
    vec2 uv = vec2(myAtan2(d.z, d.x) / (2.0 * PI) + 0.5, acos(-d.y) / PI);
    uv.y = uv.y * 2.0 - 1.0;
    return uv;
}
void main() {
    const vec2 offset = vec2(0.125, 0.725);
    vec2 scr = vTex * 2.0 - 1.0;
    // the KEX view space is y-down; flip so the dome is upright
    scr.y = -scr.y;
    vec3 rd = normalize(vRot * calcPrimaryRay(scr, uFOV, uAspect));
    vec2 skyUv = (dirToDomeUv(rd) + offset) * vec2(4.0, 0.7);
    if (skyUv.y < 0.0 || skyUv.y > 1.0) skyUv = vec2(0.0);
    frag = vec4(textureLod(uTex, skyUv, 0.0).rgb, 1.0) * uTint;
}`;

const SPRITE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aColor;
uniform mat4 uMVP;
out vec2 vUV;
out vec4 vColor;
void main() {
    vUV = aUV;
    vColor = aColor;
    gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTex;
uniform float uAlphaRef;
uniform float uAdditive;
out vec4 frag;
void main() {
    vec4 c = texture(uTex, vUV);
    if (c.a <= uAlphaRef) discard;
    vec4 o = c * vColor;
    if (uAdditive > 0.5) o.rgb *= o.a;
    frag = o;
}`;

// Vertex stride for sprite/2D batches: pos(3f) uv(2f) color(4ub) = 24 bytes
const BATCH_STRIDE = 24;

class Batch {
    constructor(gl, maxQuads = 16384) {
        this.gl = gl;
        this.max = maxQuads;
        this.data = new ArrayBuffer(maxQuads * 4 * BATCH_STRIDE);
        this.f32 = new Float32Array(this.data);
        this.u8 = new Uint8Array(this.data);
        this.count = 0;
        this.vao = gl.createVertexArray();
        this.vbo = gl.createBuffer();
        this.ibo = gl.createBuffer();
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, BATCH_STRIDE, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, BATCH_STRIDE, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, BATCH_STRIDE, 20);
        const idx = new Uint32Array(maxQuads * 6);
        for (let i = 0; i < maxQuads; ++i) {
            idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        this.draws = [];
    }

    reset() { this.count = 0; this.draws.length = 0; }

    // p: four [x,y,z] corners ordered TL, TR, BL, BR
    quad(tex, p, u1, v1, u2, v2, r, g, b, a, state = 0) {
        if (this.count >= this.max) return;
        const base = this.count * 4;
        const uvs = [u1, v1, u2, v1, u1, v2, u2, v2];
        for (let i = 0; i < 4; ++i) {
            const o = (base + i) * (BATCH_STRIDE / 4);
            this.f32[o] = p[i][0]; this.f32[o + 1] = p[i][1]; this.f32[o + 2] = p[i][2];
            this.f32[o + 3] = uvs[i * 2]; this.f32[o + 4] = uvs[i * 2 + 1];
            const c = (base + i) * BATCH_STRIDE + 20;
            this.u8[c] = r; this.u8[c + 1] = g; this.u8[c + 2] = b; this.u8[c + 3] = a;
        }
        const last = this.draws[this.draws.length - 1];
        if (last && last.tex === tex && last.state === state) last.count++;
        else this.draws.push({ tex, state, first: this.count, count: 1 });
        this.count++;
    }

    upload() {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.u8, 0, this.count * 4 * BATCH_STRIDE);
    }
}

export class Renderer {
    constructor(canvas, kpf) {
        const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
        if (!gl) throw new Error('WebGL2 is required');
        this.gl = gl;
        this.canvas = canvas;
        this.textures = new TextureManager(gl, kpf);
        this.worldProg = createProgram(gl, WORLD_VS, WORLD_FS, ['aPos', 'aUV', 'aColor']);
        this.skyProg = createProgram(gl, SKY_VS, SKY_FS, ['aPos']);
        this.spriteProg = createProgram(gl, SPRITE_VS, SPRITE_FS, ['aPos', 'aUV', 'aColor']);
        this.sprites = new Batch(gl, 8192);
        this.ui = new Batch(gl, 8192);
        this.skyVao = gl.createVertexArray();
        gl.bindVertexArray(this.skyVao);
        const sb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, sb);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.fov = 64 * Math.PI / 180;
        this.colorScale = 2.0;
        this.flash = [0, 0, 0, 0];
        this.tint = [1, 1, 1, 1];
        this.time = 0;
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w; this.canvas.height = h;
        }
        this.width = w; this.height = h;
    }

    // ------------------------------------------------------------------ world

    setWorld(world, gammaInfo) {
        const gl = this.gl;
        const map = world.map;
        this.world = world;
        this.worldTextures = map.textures.map((t) => (t ? this.textures.get(t, { mips: true }) : null));
        this.gammaInfo = gammaInfo || {};
        this.skyTexture = map.sky ? this.textures.get(map.sky, { clamp: false, mips: false }) : null;

        // one render vertex per poly corner (texcoords are per-poly)
        let nv = 0;
        for (const poly of map.polys) {
            if (poly.faceRef < 0) continue;
            for (let k = 0; k < 4; ++k) if (poly.indices[k] !== 0xff && poly.tcoords[k] !== -1) nv++;
        }
        this.vertCount = nv;
        this.vdata = new ArrayBuffer(nv * BATCH_STRIDE);
        this.vf32 = new Float32Array(this.vdata);
        this.vu8 = new Uint8Array(this.vdata);
        this.vsrc = new Int32Array(nv);          // render vertex -> map vertex
        this.polyFirst = new Int32Array(map.polys.length).fill(-1);
        this.polyCount = new Uint8Array(map.polys.length);
        let v = 0;
        for (let pi = 0; pi < map.polys.length; ++pi) {
            const poly = map.polys[pi];
            if (poly.faceRef < 0) continue;
            const face = map.faces[poly.faceRef];
            const idx = [], tc = [];
            for (let k = 0; k < 4; ++k) {
                if (poly.indices[k] === 0xff || poly.tcoords[k] === -1) continue;
                idx.push(poly.indices[k]); tc.push(poly.tcoords[k]);
            }
            this.polyFirst[pi] = v;
            this.polyCount[pi] = idx.length;
            for (let k = idx.length - 1; k >= 0; --k) {
                const mv = face.vertStart + idx[k];
                this.vsrc[v] = mv;
                const o = v * 6;
                this.vf32[o + 3] = map.uv[tc[k] * 2];
                this.vf32[o + 4] = 1.0 - map.uv[tc[k] * 2 + 1];
                v++;
            }
        }
        // map vertex -> render vertices (CSR) for incremental updates
        const nmv = map.vxyz.length / 3;
        this.mvStart = new Int32Array(nmv + 1);
        for (let v = 0; v < nv; ++v) this.mvStart[this.vsrc[v] + 1]++;
        for (let i = 0; i < nmv; ++i) this.mvStart[i + 1] += this.mvStart[i];
        this.mvList = new Int32Array(nv);
        const fillPos = this.mvStart.slice(0, nmv);
        for (let v = 0; v < nv; ++v) this.mvList[fillPos[this.vsrc[v]]++] = v;
        this.refreshVertices();

        this.worldVao = gl.createVertexArray();
        this.worldVbo = gl.createBuffer();
        this.worldIbo = gl.createBuffer();
        gl.bindVertexArray(this.worldVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.worldVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.vu8, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, BATCH_STRIDE, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, BATCH_STRIDE, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, BATCH_STRIDE, 20);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.worldIbo);
        gl.bindVertexArray(null);
        this.indexData = new Uint32Array(map.polys.length * 6);
        // polygons per sector, so a frame only submits the sectors the portal flood reached
        this.sectorPolys = world.sectors.map(() => []);
        for (let pi = 0; pi < map.polys.length; ++pi) {
            const poly = map.polys[pi];
            if (poly.faceRef < 0) continue;
            const owner = map.faces[poly.faceRef].sectorOwner;
            if (owner >= 0) this.sectorPolys[owner].push(pi);
        }
        this.vis = null;
        this.visSerial = -1;
        this.rebuildIndices();
        world.vertsDirty = false;
        world.polysDirty = false;
    }

    // Copies map vertex positions/colors into the render buffer.
    refreshVertices(only = null) {
        const map = this.world.map;
        const xyz = map.vxyz, rgba = map.vrgba;
        const shade = this.world.vertexShade;   // optional water shading
        const list = only ? [] : null;
        if (only) for (const mv of only) for (let k = this.mvStart[mv]; k < this.mvStart[mv + 1]; ++k) list.push(this.mvList[k]);
        const n = only ? list.length : this.vertCount;
        for (let i = 0; i < n; ++i) {
            const v = only ? list[i] : i;
            const mv = this.vsrc[v];
            const o = v * 6;
            this.vf32[o] = xyz[mv * 3];
            this.vf32[o + 1] = xyz[mv * 3 + 1];
            this.vf32[o + 2] = xyz[mv * 3 + 2];
            const c = v * BATCH_STRIDE + 20;
            if (shade && shade[mv] !== 0) {
                const s = shade[mv];
                this.vu8[c] = Math.max(0, Math.min(255, rgba[mv * 4] + s));
                this.vu8[c + 1] = Math.max(0, Math.min(255, rgba[mv * 4 + 1] + s));
                this.vu8[c + 2] = Math.max(0, Math.min(255, rgba[mv * 4 + 2] + s));
            } else {
                this.vu8[c] = rgba[mv * 4];
                this.vu8[c + 1] = rgba[mv * 4 + 1];
                this.vu8[c + 2] = rgba[mv * 4 + 2];
            }
            this.vu8[c + 3] = 255;
        }
    }

    // Groups polygon triangles by texture; water faces go to a blended pass. With a
    // portal visibility set only the visible sectors' polygons are included.
    rebuildIndices() {
        const map = this.world.map;
        const groups = new Map();
        const water = [];
        const vis = this.vis;
        const add = (pi) => {
            const n = this.polyCount[pi];
            if (n < 3) return;
            const poly = map.polys[pi];
            const face = map.faces[poly.faceRef];
            if (face.polyStart < 0) return;   // exploded walls
            const f = this.polyFirst[pi];
            const tris = n === 4 ? [f, f + 2, f + 1, f, f + 3, f + 2] : [f, f + 2, f + 1];
            if (face.flags & FF.WATER) { water.push({ tex: poly.texture, tris }); return; }
            let g = groups.get(poly.texture);
            if (!g) groups.set(poly.texture, g = []);
            g.push(...tris);
        };
        if (vis) {
            for (const si of vis.list) for (const pi of this.sectorPolys[si]) add(pi);
        } else {
            for (let pi = 0; pi < map.polys.length; ++pi) add(pi);
        }
        let n = 0;
        this.batches = [];
        for (const [tex, list] of groups) {
            this.indexData.set(list, n);
            this.batches.push({ tex, first: n, count: list.length });
            n += list.length;
        }
        this.waterBatches = [];
        water.sort((a, b) => a.tex - b.tex);
        for (const w of water) {
            const last = this.waterBatches[this.waterBatches.length - 1];
            this.indexData.set(w.tris, n);
            if (last && last.tex === w.tex) last.count += w.tris.length;
            else this.waterBatches.push({ tex: w.tex, first: n, count: w.tris.length });
            n += w.tris.length;
        }
        const gl = this.gl;
        gl.bindVertexArray(this.worldVao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.worldIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexData.subarray(0, n), gl.DYNAMIC_DRAW);
        gl.bindVertexArray(null);
    }

    // ------------------------------------------------------------------ frame

    beginFrame(view) {
        const gl = this.gl;
        this.resize();
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.view = view;
        const aspect = this.width / this.height;
        this.proj = mat4.perspective(view.fov ?? this.fov, aspect, 4, 32768);
        this.viewMtx = mat4.view(view.origin, view.yaw, view.pitch, view.roll || 0);
        this.mvp = mat4.multiply(this.proj, this.viewMtx);
    }

    drawSky() {
        if (!this.skyTexture) return;
        const gl = this.gl, view = this.view, p = this.skyProg;
        gl.useProgram(p.program);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
        gl.uniform1f(p.u.uYaw, -view.yaw);
        gl.uniform1f(p.u.uPitch, -view.pitch);
        gl.uniform1f(p.u.uFOV, view.fov ?? this.fov);
        gl.uniform1f(p.u.uAspect, this.width / this.height);
        gl.uniform4fv(p.u.uTint, this.tint);
        gl.uniform1i(p.u.uTex, 0);
        this.textures.bind(this.skyTexture);
        gl.bindVertexArray(this.skyVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.depthMask(true);
    }

    drawWorld() {
        const gl = this.gl, world = this.world, p = this.worldProg;
        if (world.vertsDirty || world.dirtyList.length) {
            if (world.vertsDirty) this.refreshVertices();
            else this.refreshVertices(world.dirtyList);
            for (const mv of world.dirtyList) world.dirtyMark[mv] = 0;
            world.dirtyList.length = 0;
            gl.bindBuffer(gl.ARRAY_BUFFER, this.worldVbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vu8);
            world.vertsDirty = false;
        }
        const serial = this.vis ? this.vis.serial : -1;
        if (world.polysDirty || serial !== this.visSerial) {
            this.rebuildIndices();
            world.polysDirty = false;
            this.visSerial = serial;
        }

        gl.useProgram(p.program);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.frontFace(gl.CCW);
        gl.uniformMatrix4fv(p.u.uMVP, false, this.mvp);
        gl.uniform1f(p.u.uColorScale, this.colorScale);
        gl.uniform4fv(p.u.uTint, this.tint);
        this.setLights(p);
        gl.uniform4fv(p.u.uFlash, this.flash);
        gl.uniform1f(p.u.uAlphaRef, 0.0);
        gl.uniform1i(p.u.uTex, 0);
        gl.bindVertexArray(this.worldVao);
        const texList = world.currentTextures || this.worldTextures;
        for (const b of this.batches) {
            this.textures.bind(texList[b.tex]);
            gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, b.first * 4);
        }
        gl.bindVertexArray(null);
    }

    setLights(p) {
        const gl = this.gl;
        const lights = this.lights || [];
        const n = Math.min(8, lights.length);
        gl.uniform1i(p.u.uNumLights, n);
        if (!n) return;
        const pos = new Float32Array(32), col = new Float32Array(24);
        for (let i = 0; i < n; ++i) {
            const l = lights[i];
            pos[i * 4] = l.x; pos[i * 4 + 1] = l.y; pos[i * 4 + 2] = l.z; pos[i * 4 + 3] = l.radius;
            col[i * 3] = l.r; col[i * 3 + 1] = l.g; col[i * 3 + 2] = l.b;
        }
        gl.uniform4fv(p.u.uLightPos, pos);
        gl.uniform3fv(p.u.uLightColor, col);
    }

    drawWater() {
        if (!this.waterBatches.length) return;
        const gl = this.gl, p = this.worldProg, world = this.world;
        gl.useProgram(p.program);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.uniform4f(p.u.uTint, this.tint[0], this.tint[1], this.tint[2], 0.5);
        gl.bindVertexArray(this.worldVao);
        const texList = world.currentTextures || this.worldTextures;
        for (const b of this.waterBatches) {
            this.textures.bind(texList[b.tex]);
            gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, b.first * 4);
        }
        gl.bindVertexArray(null);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
    }

    // ---------------------------------------------------------------- sprites

    // Camera-facing basis used to expand sprite quads (kexRenderScene::PrepareSprites)
    spriteBasis() {
        const v = this.view;
        let pitch = v.pitch;
        if (pitch > 1.565) pitch = 1.565;
        if (pitch < -1.565) pitch = -1.565;
        const right = [Math.cos(v.yaw), -Math.sin(v.yaw), 0];
        const fwd = [Math.sin(v.yaw) * Math.cos(pitch), Math.cos(v.yaw) * Math.cos(pitch), Math.sin(pitch)];
        const up = [
            right[1] * fwd[2] - right[2] * fwd[1],
            right[2] * fwd[0] - right[0] * fwd[2],
            right[0] * fwd[1] - right[1] * fwd[0],
        ];
        return { right, up, fwd };
    }

    // Draws a list of prepared sprite quads, back to front.
    drawSpriteList(list) {
        const gl = this.gl, p = this.spriteProg, b = this.sprites;
        list.sort((a, c) => c.dist - a.dist);
        b.reset();
        for (const s of list) for (const q of s.quads) b.quad(q.tex, q.p, q.u1, q.v1, q.u2, q.v2, q.r, q.g, q.b, q.a, q.additive ? 1 : 0);
        if (!b.count) return;
        b.upload();
        gl.useProgram(p.program);
        gl.uniformMatrix4fv(p.u.uMVP, false, this.mvp);
        gl.uniform1i(p.u.uTex, 0);
        gl.uniform1f(p.u.uAlphaRef, 0.0);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.bindVertexArray(b.vao);
        for (const d of b.draws) {
            if (d.state === 1) { gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false); gl.uniform1f(p.u.uAdditive, 1); }
            else { gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(true); gl.uniform1f(p.u.uAdditive, 0); }
            this.textures.bind(d.tex);
            gl.drawElements(gl.TRIANGLES, d.count * 6, gl.UNSIGNED_INT, d.first * 24);
        }
        gl.bindVertexArray(null);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
    }

    // --------------------------------------------------------------------- 2D

    // 2D drawing uses a virtual 320x240-ish canvas scaled to the screen height.
    begin2D() {
        this.ui.reset();
    }

    image(tex, x, y, w, h, u1 = 0, v1 = 0, u2 = 1, v2 = 1, r = 255, g = 255, b = 255, a = 255, additive = false) {
        this.ui.quad(tex, [[x, y, 0], [x + w, y, 0], [x, y + h, 0], [x + w, y + h, 0]], u1, v1, u2, v2, r, g, b, a, additive ? 1 : 0);
    }

    fill(x, y, w, h, r, g, b, a) {
        this.image(this.textures.white, x, y, w, h, 0, 0, 1, 1, r, g, b, a);
    }

    end2D(vw, vh) {
        const gl = this.gl, p = this.spriteProg, b = this.ui;
        if (!b.count) return;
        b.upload();
        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(p.program);
        gl.uniformMatrix4fv(p.u.uMVP, false, mat4.ortho(0, vw, vh, 0, -1, 1));
        gl.uniform1i(p.u.uTex, 0);
        gl.uniform1f(p.u.uAlphaRef, 0.0);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.bindVertexArray(b.vao);
        for (const d of b.draws) {
            if (d.state === 1) { gl.blendFunc(gl.ONE, gl.ONE); gl.uniform1f(p.u.uAdditive, 1); }
            else { gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(p.u.uAdditive, 0); }
            this.textures.bind(d.tex);
            gl.drawElements(gl.TRIANGLES, d.count * 6, gl.UNSIGNED_INT, d.first * 24);
        }
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
    }
}
