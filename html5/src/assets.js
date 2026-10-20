// Sprite atlases, sprite animations, bitmap fonts and localized strings.

import { parseSpriteAtlas, parseSpriteAnims, parseKFont, parseLocalization, parseKeyedBlocks } from './defs.js';

export class SpriteManager {
    constructor(kpf, textures) {
        this.kpf = kpf;
        this.textures = textures;
        this.sprites = new Map();
    }

    get(name) {
        const key = name.toLowerCase();
        let s = this.sprites.get(key);
        if (s !== undefined) return s;
        const path = `sprites/${name}_sprite.txt`;
        const text = this.kpf.text(path);
        if (text == null) { this.sprites.set(key, null); return null; }
        const atlas = parseSpriteAtlas(text, path);
        s = { name, texture: this.textures.get(atlas.texture, { clamp: true, mips: false }), infos: atlas.sprites };
        this.sprites.set(key, s);
        return s;
    }
}

export class AnimManager {
    constructor(kpf, sprites) {
        this.anims = new Map();
        for (const f of kpf.list('sprites/')) {
            if (!f.toLowerCase().endsWith('_anim.txt')) continue;
            const dir = f.split('/')[1];
            for (const [k, v] of parseSpriteAnims(kpf.text(f), dir, f)) this.anims.set(k, v);
        }
        // resolve sprite references once
        for (const a of this.anims.values()) {
            for (const fr of a.frames) {
                for (const set of fr.spriteSet) for (const s of set) s.atlas = sprites.get(s.sprite);
            }
        }
        this.defaultAnim = {
            name: '_default',
            frames: [{ delay: 0, fullbright: false, nextFrame: null, refireFrame: null, actions: [], hasRotations: false, spriteSet: [[], [], [], [], [], [], [], []] }],
        };
    }

    get(name) {
        if (!name) return null;
        return this.anims.get(name.toLowerCase()) || null;
    }
}

export class Font {
    constructor(kpf, textures, name) {
        const f = parseKFont(kpf.text(`fonts/${name}.kfont`));
        this.def = f;
        this.texture = textures.get(f.texture, { clamp: true, mips: false, filter: true });
        this.scale = f.scale;
        this.pad = f.padwidth || 0;
        let h = 0;
        for (const c of f.chars.values()) h = Math.max(h, c.h);
        this.height = h * this.scale;
    }

    char(code) {
        return this.def.chars.get(code) || this.def.chars.get(code >= 97 && code <= 122 ? code - 32 : -1) || null;
    }

    width(text, scale = 1) {
        let w = 0;
        for (const ch of text) {
            const c = this.char(ch.codePointAt(0));
            if (c) w += (c.w + this.pad) * this.scale * scale;
            else w += 6 * this.scale * scale;
        }
        return w;
    }

    draw(r, text, x, y, scale = 1, color = [255, 255, 255, 255], center = false) {
        const tex = this.texture;
        if (!tex.ready || !tex.width) return;
        if (center) x -= this.width(text, scale) / 2;
        const s = this.scale * scale;
        for (const ch of text) {
            const c = this.char(ch.codePointAt(0));
            if (!c) { x += 6 * s; continue; }
            r.image(tex, x, y + c.o * s, c.w * s, c.h * s,
                c.x / tex.width, c.y / tex.height, (c.x + c.w) / tex.width, (c.y + c.h) / tex.height,
                color[0], color[1], color[2], color[3]);
            x += (c.w + this.pad) * s;
        }
    }
}

export class Strings {
    constructor(kpf) {
        this.kpf = kpf;
        this.setLanguage('english');
    }

    setLanguage(lang) {
        this.lang = lang;
        this.map = parseLocalization(this.kpf.text(`localization/loc_${lang}.txt`) || '');
        if (lang !== 'english') {
            const en = parseLocalization(this.kpf.text('localization/loc_english.txt') || '');
            for (const [k, v] of en) if (!this.map.has(k)) this.map.set(k, v);
        }
    }

    // "$str_092" -> translated text
    t(s, ...args) {
        if (typeof s !== 'string') return String(s);
        let out = s.startsWith('$') ? (this.map.get(s.slice(1)) ?? s) : s;
        if (args.length) out = out.replace(/\$\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
        return out;
    }
}

export function loadAnimPics(kpf) {
    return parseKeyedBlocks(kpf.text('defs/animPicInfo.txt') || '', 'animPicInfo');
}
