// Thin WebGL2 helpers: shader programs and a texture cache fed from the kpf.

export function createProgram(gl, vsSrc, fsSrc, attribs) {
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src);
        }
        return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; ++i) {
        const info = gl.getActiveUniform(p, i);
        uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, u: uniforms };
}

export class Texture {
    constructor(gl, glTex, width, height) {
        this.gl = gl;
        this.tex = glTex;
        this.width = width;
        this.height = height;
        this.ready = !!glTex;
    }
}

export class TextureManager {
    constructor(gl, kpf) {
        this.gl = gl;
        this.kpf = kpf;
        this.cache = new Map();
        this.pending = [];
        this.white = this.fromPixels(1, 1, new Uint8Array([255, 255, 255, 255]));
        this.missing = this.fromPixels(2, 2, new Uint8Array([255, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 255, 255]));
    }

    fromPixels(w, h, pixels, opts = {}) {
        const gl = this.gl;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        this.setParams(opts);
        return new Texture(gl, t, w, h);
    }

    setParams({ clamp = false, filter = false, mips = false } = {}) {
        const gl = this.gl;
        const wrap = clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter ? gl.LINEAR : gl.NEAREST);
        if (mips) {
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR);
        } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter ? gl.LINEAR : gl.NEAREST);
        }
    }

    // Returns a Texture immediately; pixels are uploaded once decoded.
    get(path, opts = {}) {
        if (!path) return this.missing;
        const key = path.toLowerCase() + JSON.stringify(opts);
        let t = this.cache.get(key);
        if (t) return t;
        t = new Texture(this.gl, null, 0, 0);
        this.cache.set(key, t);
        const blob = this.kpf.blob(path, 'image/png');
        if (!blob) {
            console.warn('missing texture', path);
            t.tex = this.missing.tex; t.width = 2; t.height = 2; t.ready = true; t.missingFile = true;
            return t;
        }
        const job = createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then((img) => {
            const gl = this.gl;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            this.setParams({ mips: opts.mips ?? !opts.clamp, ...opts });
            t.tex = tex; t.width = img.width; t.height = img.height; t.ready = true;
            if (t.onload) t.onload(t);
            img.close();
        }).catch((e) => {
            console.warn('texture decode failed', path, e);
            t.tex = this.missing.tex; t.width = 2; t.height = 2; t.ready = true;
        });
        this.pending.push(job);
        return t;
    }

    // DXT1 .dds (e.g. gfx/overworld.dds). Uploaded compressed when the GPU supports S3TC
    // and the size limit allows it, otherwise decoded on the CPU (halved until it fits).
    getDDS(path, opts = {}) {
        const key = path.toLowerCase() + JSON.stringify(opts);
        let t = this.cache.get(key);
        if (t) return t;
        t = new Texture(this.gl, null, 0, 0);
        this.cache.set(key, t);
        const fail = (why) => {
            console.warn('dds', path, why);
            t.tex = this.missing.tex; t.width = 2; t.height = 2; t.ready = true; t.missingFile = true;
        };
        if (!this.kpf.has(path)) { fail('missing'); return t; }
        const job = this.kpf.bytesAsync(path).then((b) => {
            const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
            const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
            const fourCC = String.fromCharCode(b[84], b[85], b[86], b[87]);
            if (dv.getUint32(0, true) !== 0x20534444 || fourCC !== 'DXT1') { fail('unsupported ' + fourCC); return; }
            const data = b.subarray(128, 128 + Math.ceil(w / 4) * Math.ceil(h / 4) * 8);
            const gl = this.gl;
            const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
            const ext = gl.getExtension('WEBGL_compressed_texture_s3tc');
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            if (ext && w <= maxSize && h <= maxSize) {
                gl.compressedTexImage2D(gl.TEXTURE_2D, 0, ext.COMPRESSED_RGB_S3TC_DXT1_EXT, w, h, 0, data);
            } else {
                let shift = 0;
                while (!(w >> shift <= maxSize && h >> shift <= maxSize) && shift < 2) shift++;
                const px = decodeDXT1(data, w, h, shift);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w >> shift, h >> shift, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
            }
            this.setParams({ ...opts, mips: false });
            t.tex = tex; t.width = w; t.height = h; t.ready = true;
        }).catch((e) => fail(e));
        this.pending.push(job);
        return t;
    }

    async flush() {
        while (this.pending.length) {
            const jobs = this.pending;
            this.pending = [];
            await Promise.all(jobs);
        }
    }

    bind(t, unit = 0) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t && t.ready ? t.tex : this.white.tex);
    }
}

// DXT1 blocks -> RGBA, downscaled by 2^shift (0..2) by averaging the decoded texels.
function decodeDXT1(data, w, h, shift) {
    const ow = w >> shift, oh = h >> shift, step = 1 << shift;
    const out = new Uint8Array(ow * oh * 4);
    const sum = new Uint32Array(ow * oh * 3);
    const pal = new Uint8Array(12);
    const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
    let o = 0;
    for (let by = 0; by < bh; ++by) {
        for (let bx = 0; bx < bw; ++bx, o += 8) {
            const c0 = data[o] | (data[o + 1] << 8), c1 = data[o + 2] | (data[o + 3] << 8);
            pal[0] = ((c0 >> 11) & 31) * 255 / 31; pal[1] = ((c0 >> 5) & 63) * 255 / 63; pal[2] = (c0 & 31) * 255 / 31;
            pal[3] = ((c1 >> 11) & 31) * 255 / 31; pal[4] = ((c1 >> 5) & 63) * 255 / 63; pal[5] = (c1 & 31) * 255 / 31;
            for (let k = 0; k < 3; ++k) {
                if (c0 > c1) {
                    pal[6 + k] = (2 * pal[k] + pal[3 + k]) / 3;
                    pal[9 + k] = (pal[k] + 2 * pal[3 + k]) / 3;
                } else {
                    pal[6 + k] = (pal[k] + pal[3 + k]) / 2;
                    pal[9 + k] = 0;
                }
            }
            for (let y = 0; y < 4; ++y) {
                const row = data[o + 4 + y];
                const py = (by * 4 + y) >> shift;
                if (py >= oh) continue;
                for (let x = 0; x < 4; ++x) {
                    const px = (bx * 4 + x) >> shift;
                    if (px >= ow) continue;
                    const idx = ((row >> (x * 2)) & 3) * 3, d = (py * ow + px) * 3;
                    sum[d] += pal[idx]; sum[d + 1] += pal[idx + 1]; sum[d + 2] += pal[idx + 2];
                }
            }
        }
    }
    const n = step * step;
    for (let i = 0, j = 0; i < ow * oh; ++i, j += 3) {
        out[i * 4] = sum[j] / n; out[i * 4 + 1] = sum[j + 1] / n; out[i * 4 + 2] = sum[j + 2] / n; out[i * 4 + 3] = 255;
    }
    return out;
}
