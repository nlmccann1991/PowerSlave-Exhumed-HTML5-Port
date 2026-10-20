// Parsers for the KEX text formats shipped in the kpf: definition blocks
// (defs/*.txt), sprite atlases, sprite animations, fonts and localization.

export const TK = { EOF: 0, IDENT: 1, NUMBER: 2, STRING: 3, PUNCT: 4 };

export class Lexer {
    constructor(text, name = '') {
        this.s = text.replace(/\r/g, '');
        this.p = 0;
        this.name = name;
        this.line = 1;
        this.peeked = null;
    }

    skip() {
        const s = this.s;
        for (;;) {
            const c = s[this.p];
            if (c === '\n') { this.line++; this.p++; continue; }
            if (c === ' ' || c === '\t' || c === '\v' || c === '\f') { this.p++; continue; }
            if (c === '/' && s[this.p + 1] === '/') {
                while (this.p < s.length && s[this.p] !== '\n') this.p++;
                continue;
            }
            if (c === '/' && s[this.p + 1] === '*') {
                const e = s.indexOf('*/', this.p + 2);
                const end = e < 0 ? s.length : e + 2;
                for (let i = this.p; i < end; ++i) if (s[i] === '\n') this.line++;
                this.p = end;
                continue;
            }
            break;
        }
    }

    next() {
        if (this.peeked) { const t = this.peeked; this.peeked = null; return t; }
        this.skip();
        const s = this.s;
        if (this.p >= s.length) return { type: TK.EOF, value: null, line: this.line };
        const c = s[this.p];
        const line = this.line;
        if (c === '"') {
            let out = '';
            this.p++;
            while (this.p < s.length && s[this.p] !== '"') {
                if (s[this.p] === '\\' && s[this.p + 1] === 'n') { out += '\n'; this.p += 2; continue; }
                if (s[this.p] === '\\' && s[this.p + 1] === '"') { out += '"'; this.p += 2; continue; }
                if (s[this.p] === '\n') this.line++;
                out += s[this.p++];
            }
            this.p++;
            return { type: TK.STRING, value: out, line };
        }
        if (/[0-9]/.test(c) || ((c === '-' || c === '.' || c === '+') && /[0-9.]/.test(s[this.p + 1] || ''))) {
            const m = /^[-+]?(0x[0-9a-fA-F]+|[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?)f?/.exec(s.slice(this.p, this.p + 40));
            if (m) {
                this.p += m[0].length;
                return { type: TK.NUMBER, value: Number(m[0].replace(/f$/, '')), text: m[0], line };
            }
        }
        if (/[A-Za-z_$#]/.test(c)) {
            const m = /^[#$]?[A-Za-z_0-9.\-]*[A-Za-z_0-9]?/.exec(s.slice(this.p, this.p + 256));
            // identifiers may not contain '-' or '.' unless used as bare paths; keep it simple
            const id = /^[#$]?[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(this.p, this.p + 256))[0];
            void m;
            this.p += id.length;
            return { type: TK.IDENT, value: id, line };
        }
        this.p++;
        return { type: TK.PUNCT, value: c, line };
    }

    peek() {
        if (!this.peeked) this.peeked = this.next();
        return this.peeked;
    }

    expect(v) {
        const t = this.next();
        if (t.value !== v) throw new Error(`${this.name}:${t.line}: expected '${v}' got '${t.value}'`);
        return t;
    }

    restOfLine() {
        const e = this.s.indexOf('\n', this.p);
        const end = e < 0 ? this.s.length : e;
        const out = this.s.slice(this.p, end);
        this.p = end;
        return out;
    }
}

// Generic "Kind Name { key value ... }" definition files with #include/#define.
export class DefSet {
    constructor(kpf) {
        this.kpf = kpf;
        this.defines = new Map();
        this.blocks = new Map();     // kind -> Map(name -> props)
        this.byIndex = new Map();    // kind -> Map(number -> props)
        this.included = new Set();
    }

    resolveValue(tok) {
        if (tok.type === TK.IDENT && this.defines.has(tok.value)) return this.defines.get(tok.value);
        return tok.value;
    }

    loadFile(path) {
        const key = path.toLowerCase();
        const text = this.kpf.text(path);
        if (text == null) { console.warn('defs: missing', path); return; }
        const lx = new Lexer(text, path);
        for (;;) {
            const t = lx.next();
            if (t.type === TK.EOF) break;
            if (t.value === '#include') {
                const f = lx.next().value;
                if (!this.included.has(f.toLowerCase())) {
                    this.included.add(f.toLowerCase());
                    this.loadFile(f);
                }
                continue;
            }
            if (t.value === '#define') {
                const name = lx.next().value;
                const rest = lx.restOfLine().trim();
                const n = Number(rest);
                this.defines.set(name, isNaN(n) ? rest : n);
                continue;
            }
            if (t.type === TK.IDENT) {
                const kind = t.value;
                const nameTok = lx.next();
                const name = nameTok.value;
                const props = this.parseBlock(lx);
                props.__name = name;
                props.__kind = kind;
                if (!this.blocks.has(kind)) { this.blocks.set(kind, new Map()); this.byIndex.set(kind, new Map()); }
                this.blocks.get(kind).set(name, props);
                const idx = this.defines.get(name);
                if (typeof idx === 'number') {
                    props.__index = idx;
                    this.byIndex.get(kind).set(idx, props);
                }
                continue;
            }
        }
        this.included.add(key);
    }

    parseBlock(lx) {
        lx.expect('{');
        const props = {};
        for (;;) {
            const k = lx.next();
            if (k.type === TK.EOF || k.value === '}') break;
            const v = lx.next();
            props[k.value] = this.resolveValue(v);
        }
        return props;
    }

    get(kind, nameOrIndex) {
        if (typeof nameOrIndex === 'number') return this.byIndex.get(kind)?.get(nameOrIndex) || null;
        return this.blocks.get(kind)?.get(nameOrIndex) || null;
    }

    all(kind) { return this.blocks.get(kind) ? [...this.blocks.get(kind).values()] : []; }
}

// Accessors mirroring kexDict::GetFloat/GetInt/GetBool/GetString/GetVector
export const dict = {
    float(d, k, def = 0) { if (!d || d[k] === undefined) return def; const n = Number(d[k]); return isNaN(n) ? def : n; },
    int(d, k, def = 0) { if (!d || d[k] === undefined) return def; const n = Number(d[k]); return isNaN(n) ? def : Math.trunc(n); },
    bool(d, k, def = false) { if (!d || d[k] === undefined) return def; return Number(d[k]) !== 0 || d[k] === 'true'; },
    str(d, k, def = null) { if (!d || d[k] === undefined) return def; return String(d[k]); },
    vec(d, k) {
        if (!d || d[k] === undefined) return null;
        const p = String(d[k]).trim().split(/\s+/).map(Number);
        return [p[0] || 0, p[1] || 0, p[2] || 0];
    },
    has(d, k) { return !!d && d[k] !== undefined; },
};

// Quoted-key blocks: "textures/foo.png" { key value ... }
export function parseKeyedBlocks(text, name) {
    const lx = new Lexer(text, name);
    const out = new Map();
    let disabled = 0;
    for (;;) {
        const t = lx.next();
        if (t.type === TK.EOF) break;
        if (t.value === '#if') { const v = lx.next(); if (Number(v.value) === 0) disabled++; continue; }
        if (t.value === '#endif') { if (disabled) disabled--; continue; }
        if (t.type !== TK.STRING) continue;
        lx.expect('{');
        const props = {};
        for (;;) {
            const k = lx.next();
            if (k.type === TK.EOF || k.value === '}') break;
            props[k.value] = lx.next().value;
        }
        if (!disabled) out.set(t.value.toLowerCase(), props);
    }
    return out;
}

// sprites/<dir>/<name>_sprite.txt
export function parseSpriteAtlas(text, name) {
    const lx = new Lexer(text, name);
    const atlas = { texture: null, sprites: [] };
    for (;;) {
        const t = lx.next();
        if (t.type === TK.EOF) break;
        if (t.value === 'texture') atlas.texture = lx.next().value;
        else if (t.value === 'sprite') {
            const i = lx.next().value, x = lx.next().value, y = lx.next().value, w = lx.next().value, h = lx.next().value;
            atlas.sprites[i] = { x, y, w, h };
        }
    }
    return atlas;
}

const ROTATIONS = { N: 0, NE: 1, E: 2, ES: 3, S: 4, SW: 5, W: 6, WN: 7 };

// sprites/<dir>/<name>_anim.txt -> Map("dir/name" -> anim)
export function parseSpriteAnims(text, dir, name) {
    const lx = new Lexer(text, name);
    const anims = new Map();
    const parseSpriteSet = (frame, rot) => {
        lx.expect('{');
        for (;;) {
            const t = lx.next();
            if (t.type === TK.EOF || t.value === '}') break;
            if (t.value === '{') {
                const sprite = lx.next().value; lx.expect(',');
                const index = lx.next().value; lx.expect(',');
                const x = lx.next().value; lx.expect(',');
                const y = lx.next().value; lx.expect(',');
                const flip = lx.next().value; lx.expect('}');
                frame.spriteSet[rot].push({ sprite, index, x, y, flipped: flip !== 0 });
            }
        }
    };
    const parseAction = () => {
        const fn = lx.next().value;
        const args = [];
        lx.expect('(');
        for (;;) {
            const t = lx.next();
            if (t.type === TK.EOF || t.value === ')') break;
            if (t.value === ',') continue;
            if (t.value === '-' && lx.peek().type === TK.NUMBER) { args.push(-lx.next().value); continue; }
            args.push(t.value);
        }
        return { name: fn, args };
    };
    const parseFrame = (frame) => {
        lx.expect('{');
        for (;;) {
            const t = lx.next();
            if (t.type === TK.EOF || t.value === '}') break;
            switch (t.value) {
            case 'delay': frame.delay = lx.next().value; break;
            case 'fullbright': frame.fullbright = true; break;
            case 'goto': frame.nextFrame = lx.next().value; break;
            case 'refire': frame.refireFrame = lx.next().value; break;
            case 'sprites': parseSpriteSet(frame, 0); break;
            case 'action': frame.actions.push(parseAction()); break;
            default:
                if (typeof t.value === 'string' && t.value.startsWith('rotation_')) {
                    const r = ROTATIONS[t.value.slice(9)];
                    frame.hasRotations = true;
                    lx.expect('{');
                    for (;;) {
                        const u = lx.next();
                        if (u.type === TK.EOF || u.value === '}') break;
                        if (u.value === 'sprites') parseSpriteSet(frame, r);
                    }
                }
            }
        }
    };
    for (;;) {
        const t = lx.next();
        if (t.type === TK.EOF) break;
        if (t.type !== TK.IDENT) continue;
        const anim = { name: `${dir}/${t.value}`, frames: [] };
        lx.expect('{');
        for (;;) {
            const u = lx.next();
            if (u.type === TK.EOF || u.value === '}') break;
            if (u.value === 'frame') {
                const frame = {
                    delay: 1, fullbright: false, nextFrame: null, refireFrame: null, actions: [],
                    hasRotations: false, spriteSet: [[], [], [], [], [], [], [], []],
                };
                parseFrame(frame);
                if (frame.delay < 0) frame.delay = 0xffff;
                anim.frames.push(frame);
            }
        }
        anims.set(anim.name.toLowerCase(), anim);
    }
    return anims;
}

export function parseKFont(text) {
    const lx = new Lexer(text, 'font');
    const font = { texture: null, scale: 1, padwidth: 0, chars: new Map() };
    for (;;) {
        const t = lx.next();
        if (t.type === TK.EOF) break;
        if (t.value === 'texture') font.texture = lx.next().value;
        else if (t.value === 'scale') font.scale = lx.next().value;
        else if (t.value === 'padwidth') font.padwidth = lx.next().value;
        else if (t.value === 'mapchar') {
            lx.expect('{');
            for (;;) {
                const c = lx.next();
                if (c.type === TK.EOF || c.value === '}') break;
                const x = lx.next().value, y = lx.next().value, w = lx.next().value, h = lx.next().value, o = lx.next().value;
                font.chars.set(c.value, { x, y, w, h, o });
            }
        }
    }
    return font;
}

export function parseLocalization(text) {
    const map = new Map();
    for (const line of text.replace(/\r/g, '').split('\n')) {
        const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(line);
        if (m) map.set(m[1], m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
    return map;
}
