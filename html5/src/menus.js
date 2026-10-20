// Title screen, overworld map, pause/options, inventory and ending screens.

import { PA } from './actorflags.js';
import { parseCredits } from './credits.js';

const ARTIFACT_NAMES = ['$str_100', '$str_101', '$str_102', '$str_103', '$str_104', '$str_105'];

export class Menus {
    constructor(game) {
        this.game = game;
        this.stack = [];
        this.toast = null;
        this.error = null;
    }

    get active() { return this.stack.length > 0; }
    get top() { return this.stack[this.stack.length - 1]; }
    get blocksGame() { return this.active; }

    push(m) {
        this.stack.push(m);
        if (document.pointerLockElement) document.exitPointerLock();
    }
    pop() { this.stack.pop(); }
    clear() { this.stack = []; }

    // --------------------------------------------------------------- screens

    openTitle() {
        const g = this.game;
        this.clear();
        g.sound.playMusic('music/title.ogg', true);
        const items = [];
        if (g.hasSave()) items.push({ label: '$m_load_game', act: () => { this.clear(); g.continueGame(); } });
        items.push({ label: '$m_new_game', act: () => this.push(this.difficultyMenu()) });
        items.push({ label: '$m_options', act: () => this.push(this.optionsMenu()) });
        items.push({ label: 'Controls', act: () => this.push(this.controlsMenu()) });
        items.push({ label: '$m_about', act: () => this.openCredits() });
        this.push({ kind: 'title', items, sel: 0, cancel: () => {} });
    }

    difficultyMenu() {
        const g = this.game;
        const pick = (d) => () => {
            g.settings.difficulty = d;
            g.saveSettings();
            this.clear();
            g.newGame();
        };
        return {
            kind: 'list', title: '$m_select_difficulty', sel: 0,
            items: [
                { label: '$m_difficulty_normal', act: pick(0) },
                { label: '$m_difficulty_hard', act: pick(1) },
                { label: '$m_difficulty_pharaoh', act: pick(2) },
            ],
        };
    }

    openPause() {
        const g = this.game;
        this.push({
            kind: 'list', title: '$m_game_paused', sel: 0, pause: true,
            items: [
                { label: '$m_resume', act: () => this.closePause() },
                { label: '$m_options', act: () => this.push(this.optionsMenu()) },
                { label: 'Controls', act: () => this.push(this.controlsMenu()) },
                ...(g.checkpoint && g.activeMap && g.checkpoint.map === g.activeMap.index
                    ? [{ label: '$m_reload_last_checkpoint', act: () => { this.clear(); g.restartLevel(); } }] : []),
                { label: '$m_restart_level', act: () => { this.clear(); g.checkpoint = null; g.restartLevel(); } },
                { label: '$m_overworldScreen', act: () => { this.clear(); g.unloadLevel(); g.saveGame(); this.openOverworld(); } },
                { label: '$m_exit_title_screen', act: () => { this.clear(); g.unloadLevel(); this.openTitle(); g.state = 'title'; } },
            ],
            cancel: () => this.closePause(),
        });
    }

    closePause() {
        this.clear();
        this.game.input.mouseDX = this.game.input.mouseDY = 0;
    }

    optionsMenu() {
        const g = this.game, s = g.settings;
        const num = (label, key, min, max, step, fmt = (v) => v.toFixed(1)) => ({
            label, value: () => fmt(s[key]),
            left: () => { s[key] = Math.max(min, +(s[key] - step).toFixed(3)); g.saveSettings(); },
            right: () => { s[key] = Math.min(max, +(s[key] + step).toFixed(3)); g.saveSettings(); },
        });
        const bool = (label, key) => ({
            label, value: () => (s[key] ? 'On' : 'Off'),
            act: () => { s[key] = !s[key]; g.saveSettings(); },
            left: () => { s[key] = !s[key]; g.saveSettings(); },
            right: () => { s[key] = !s[key]; g.saveSettings(); },
        });
        return {
            kind: 'list', title: '$m_options', sel: 0,
            items: [
                num('$m_msens_x', 'sensitivity', 1, 20, 0.5),
                bool('Invert Mouse', 'invertY'),
                num('$m_sound_volume', 'sfxVolume', 0, 1, 0.1),
                num('$m_music_volume', 'musicVolume', 0, 1, 0.1),
                num('$m_fov', 'fov', 50, 110, 2, (v) => String(v | 0)),
                num('$m_brightness', 'colorScale', 1, 3, 0.1),
                bool('Auto Aim', 'autoAim'),
                bool('Crosshair', 'crosshair'),
                { ...bool('Overworld Map', 'originalOverworld'), value: () => (s.originalOverworld ? g.strings.t('$m_original') : 'HD') },
                { label: '$m_go_back', act: () => this.pop() },
            ],
        };
    }

    controlsMenu() {
        return {
            kind: 'info', title: 'Controls',
            lines: [
                'W A S D - Move      Mouse - Look',
                'Left Click / Ctrl - Attack',
                'Space - Jump / Swim up',
                'E / F / Right Click - Use, open doors',
                '1-8 / Mouse Wheel - Weapons',
                'Tab - Automap   + / - Zoom map',
                'Shift / I - Inventory',
                'Esc - Pause   Gamepads supported',
            ],
            items: [{ label: 'Back', act: () => this.pop() }],
            sel: 0,
        };
    }

    // kexMenuTravel: the camel's facing picks the overworld neighbour (N, E, S, W)
    openTravel(camel) {
        const g = this.game;
        const info = g.activeMap && g.mapInfo[g.activeMap.index];
        if (!info) return;
        const deg = camel ? camel.yaw * 180 / Math.PI : 0;
        const next = info.next[((Math.round(deg / 90) % 4) + 4) % 4];
        if (next < 0 || !g.mapInfo[next]) {
            console.warn(`No linked map has been found for ${g.strings.t(info.title)}`);
            return;
        }
        this.push({
            kind: 'list', title: g.strings.t('$m_travel', g.strings.t(g.mapInfo[next].title)), sel: 0,
            items: [
                { label: '$m_yes', act: () => { this.clear(); g.travelToOverworld(next); } },
                { label: '$m_no', act: () => this.closePause() },
            ],
            cancel: () => this.closePause(),
        });
    }

    openInventory() {
        this.push({ kind: 'inventory', items: [], sel: 0, cancel: () => this.pop(), closeOn: ['inventory'] });
    }

    showArtifact(bit) {
        this.toast = { text: ARTIFACT_NAMES[bit] || '', pic: `gfx/menu/menuartifact_${bit}.png`, ticks: 240 };
    }

    openOverworld() {
        const g = this.game;
        g.state = 'overworld';
        this.clear();
        g.sound.playMusic('music/overworld.ogg', true);
        const info = g.mapInfo[g.selectedMap] || g.mapInfo[0];
        this.push({
            kind: 'overworld', sel: info.index, items: [], cancel: () => this.openPauseOverworld(),
            camX: info.overworldX, camY: info.overworldY, pan: 1, zoom: 0, travelling: false,
        });
    }

    openPauseOverworld() {
        const g = this.game;
        this.push({
            kind: 'list', title: 'Menu', sel: 0,
            items: [
                { label: '$m_resume', act: () => this.pop() },
                { label: '$m_options', act: () => this.push(this.optionsMenu()) },
                { label: '$m_exit_title_screen', act: () => { this.clear(); g.state = 'title'; this.openTitle(); } },
            ],
        });
    }

    // Game state 8: every line starts 16px below the previous one off the bottom of the
    // screen and rises 0.25px a tick; once the last line is gone it's back to the title.
    // onDone runs when the roll ends or is skipped (the endings continue to their screen)
    async openCredits(onDone = null) {
        const g = this.game;
        if (!this.creditLines) {
            this.toast = { text: 'Loading credits...', ticks: 600 };
            const exe = await g.data.exeBytes();
            this.toast = null;
            this.creditLines = exe && parseCredits(exe);
            if (!this.creditLines) {
                this.error = 'The credits are read from anubis_Shipping_Galaxy_x64.exe, which wasn\'t found';
                setTimeout(() => { this.error = null; }, 5000);
                onDone?.();
                return;
            }
        }
        const lines = this.creditLines;
        g.sound.playMusic('music/credu1.ogg', false);
        g.input.consumePressed(); // the key that skipped the ending movie mustn't skip the roll too
        this.push({
            kind: 'credits', items: [], lines,
            ys: lines.map((_, i) => 240 + i * 16),
            cancel: () => this.closeCredits(),
            onDone,
        });
    }

    closeCredits() {
        const m = this.top;
        this.pop();
        if (m && m.onDone) { m.onDone(); return; }
        if (this.top && this.top.kind === 'title') this.game.sound.playMusic('music/title.ogg', true);
    }

    creditsTick(m) {
        for (let i = 0; i < m.ys.length; ++i) {
            m.ys[i] -= 0.25;
            if (m.ys[i] < -16) {
                m.ys[i] = -16;
                if (i === m.ys.length - 1) { this.closeCredits(); return; }
            }
        }
    }

    drawCredits(d, m) {
        d.fillScreen(0, 0, 0, 255);
        m.lines.forEach((line, i) => {
            const y = m.ys[i];
            if (line && y < 240 && y > -16) d.text(line, 160, y, { center: true });
        });
    }

    openEnding(good) {
        const g = this.game;
        g.state = 'ending';
        this.clear();
        g.sound.stopMusic();
        // like the remaster, the ending movie goes into the credits; the port then adds
        // its own closing screen
        g.data.playMovie(good ? 'goodend' : 'badend', g.movieLang()).then(() => this.openCredits(() => {
            g.sound.stopMusic();
            this.push({
                kind: 'info', title: good ? 'The End' : 'Game Over',
                lines: good
                    ? ['Ramses is free and Egypt is saved.', 'Thank you for playing', 'PowerSlave Exhumed.']
                    : ['You defeated the Kilmaat queen,', 'but not every transmitter part', 'was found. Find all eight', 'to see the true ending.'],
                items: [{ label: 'Title Screen', act: () => { this.clear(); g.state = 'title'; this.openTitle(); } }],
                sel: 0,
            });
        }));
    }

    // ------------------------------------------------------------------ input

    // runs every game tick, also during play, so pickup banners time out
    tickToast() {
        if (this.toast && --this.toast.ticks <= 0) this.toast = null;
    }

    tick(pressed) {
        const g = this.game;
        const m = this.top;
        if (!m) return;
        if (m.kind === 'overworld') this.overworldTick(m);
        if (m.kind === 'credits') {
            if (pressed.some((a) => a === 'nav_Escape' || a === 'nav_Enter' || a === 'menu')) this.closeCredits();
            else this.creditsTick(m);
            return;
        }
        for (const a of pressed) {
            if (m.kind === 'overworld') { this.overworldInput(m, a); continue; }
            const items = m.items || [];
            if (m.closeOn && m.closeOn.includes(a)) { this.pop(); return; }
            switch (a) {
            case 'nav_ArrowUp':
                if (items.length) m.sel = (m.sel + items.length - 1) % items.length;
                g.sound.play('sounds/menu_highlight.wav', null);
                break;
            case 'nav_ArrowDown':
                if (items.length) m.sel = (m.sel + 1) % items.length;
                g.sound.play('sounds/menu_highlight.wav', null);
                break;
            case 'nav_ArrowLeft':
                items[m.sel]?.left?.();
                break;
            case 'nav_ArrowRight':
                items[m.sel]?.right?.();
                break;
            case 'nav_Enter': {
                const it = items[m.sel];
                if (it && it.act) { g.sound.play('sounds/menu_select.wav', null); it.act(); return; }
                if (m.kind === 'inventory') { this.pop(); return; }
                break;
            }
            case 'nav_Escape':
                if (m.cancel) m.cancel(); else this.pop();
                return;
            default: break;
            }
        }
    }

    // ----------------------------------------------------------- overworld
    // kexSlaveOverworldLocal (tick 0x1401cf000, input 0x1401cfcd0, draw 0x1401cf1e0)

    useOriginalOverworld() { return !!this.game.settings.originalOverworld; }

    overworldTick(m) {
        const g = this.game;
        let info = g.mapInfo[m.sel];
        if (!info || info.next.every((n) => n < 0)) { m.sel = 0; info = g.mapInfo[0]; }
        if (info.transmitter >= 0 && !(g.player.questItems & (1 << info.transmitter)) && (g.ticks & 63) === 0) {
            g.sound.play('sounds/om_transmitter.wav', null);
        }
        m.zoom = m.travelling ? Math.min(1, m.zoom + 1 / 60) : Math.max(0, m.zoom - 1 / 60);
        if (m.pan < 1) m.pan = Math.min(1, m.pan + 1 / 120);
        const e = 0.5 - Math.cos(m.pan * Math.PI) * 0.5;
        m.camX += (info.overworldX - m.camX) * e;
        m.camY += (info.overworldY - m.camY) * e;
        // keep the view inside the map: the original screen is exactly 640 wide,
        // the HD one has extra margin on both sides
        const k = this.useOriginalOverworld() ? 120 * (4 / 3) : 20 * (16 / 9);
        m.camX = Math.min(640 - k, Math.max(k, m.camX));
        m.camY = Math.min(392, Math.max(120, m.camY));
        if (m.travelling && m.zoom >= 1 && !m.started) {
            m.started = true;
            this.clear();
            g.startMap(m.sel);
        }
    }

    overworldInput(m, a) {
        const g = this.game;
        if (m.travelling) return;
        const info = g.mapInfo[m.sel];
        const go = (dir) => {
            const n = info && info.next[dir];
            if (!(n >= 0 && g.mapUnlocks[n])) return;
            m.sel = n;
            m.pan = m.pan < 0.25 ? 0.125 : 0;
            g.sound.play('sounds/menu_highlight.wav', null);
        };
        switch (a) {
        case 'nav_ArrowUp': go(0); break;
        case 'nav_ArrowRight': go(1); break;
        case 'nav_ArrowDown': go(2); break;
        case 'nav_ArrowLeft': go(3); break;
        case 'nav_Enter':
            if (!info) break;
            g.sound.play('sounds/menu_select.wav', null);
            m.travelling = true;
            m.zoom = 0;
            break;
        case 'nav_Escape': m.cancel(); break;
        default: break;
        }
    }

    // map space (640x512) -> 320x240 screen space
    owView(m) {
        const z = 2 - (0.5 - Math.cos((1 - m.zoom) * Math.PI) * 0.5);
        return { z, tx: (x) => (x - m.camX) * z + 160, ty: (y) => (y - m.camY) * z + 120 };
    }

    onClickOverworld(x, y) {
        const m = this.top;
        if (!m || m.kind !== 'overworld' || m.travelling) return;
        const g = this.game, v = this.owView(m);
        let best = -1, bd = 24 * 24;
        g.mapInfo.forEach((info, i) => {
            if (!info || !g.mapUnlocks[i] || info.next.every((n) => n < 0)) return;
            // centre of the eye cursor, which hangs right/down from the map point
            const d = (v.tx(info.overworldX + 19) - x) ** 2 + (v.ty(info.overworldY + 7) - y) ** 2;
            if (d < bd) { bd = d; best = i; }
        });
        if (best < 0) return;
        if (best === m.sel) this.overworldInput(m, 'nav_Enter');
        else { m.sel = best; m.pan = m.pan < 0.25 ? 0.125 : 0; g.sound.play('sounds/menu_highlight.wav', null); }
    }

    // FUN_1401d0460: one frame of a sprite anim, frame picked from the global tick
    drawOverworldAnim(d, v, name, x, y, c) {
        const hd = !this.useOriginalOverworld();
        const anim = this.game.anims.get(`misc/${name}${hd ? '_hd' : ''}`);
        if (!anim || !anim.frames.length) return;
        const frame = anim.frames[(this.game.ticks >> 1) % anim.frames.length];
        const div = hd ? 4 : 1;
        for (const s of frame.spriteSet[0]) {
            const inf = s.atlas && s.atlas.infos[s.index], tex = s.atlas && s.atlas.texture;
            if (!inf || !tex.ready || !tex.width) continue;
            d.img(tex, v.tx(x + s.x), v.ty(y + s.y), inf.w / div * v.z, inf.h / div * v.z,
                inf.x / tex.width, inf.y / tex.height, (inf.x + inf.w) / tex.width, (inf.y + inf.h) / tex.height, c, c, c, 255);
        }
    }

    // ------------------------------------------------------------------- draw

    draw(d) {
        const g = this.game;
        for (const m of this.stack) {
            if (m !== this.top && m.kind !== 'title' && m.kind !== 'overworld') continue;
            switch (m.kind) {
            case 'title': this.drawTitle(d, m); break;
            case 'overworld': this.drawOverworld(d, m); break;
            case 'credits': this.drawCredits(d, m); break;
            case 'inventory': this.drawInventory(d); break;
            default: this.drawList(d, m); break;
            }
        }
        if (this.toast) {
            const t = this.toast;
            const a = Math.round(255 * Math.min(1, t.ticks / 30)); // fade out over the last half second
            const tex = t.pic && d.pic(t.pic, -1000, -1000);
            if (tex && tex.ready && tex.width) d.img(tex, 160 - tex.width / 2, 60, tex.width, tex.height, 0, 0, 1, 1, 255, 255, 255, a);
            d.text(t.text, 160, 112, { center: true, big: true, color: [255, 255, 255, a] });
        }
        if (this.error) d.text(this.error, 160, 228, { center: true, color: [255, 96, 96, 255] });
        void g;
    }

    drawTitle(d, m) {
        const g = this.game;
        const back = g.textures.get('gfx/title_backdrop.png', { clamp: true, mips: true, filter: true });
        if (back.ready && back.width) {
            const h = 240, w = h * back.width / back.height;
            d.img(back, 160 - w / 2, 0, w, h);
        }
        d.pic('gfx/title.png', 0, 0, 320, 240);
        // keep the last item clear of the copyright line baked into title.png
        if (this.top === m) this.drawItems(d, m, 160, Math.min(168, 206 - m.items.length * 14));
        d.text('HTML5 port - press Enter or click to select', 160, 228, { center: true, color: [200, 180, 140, 255], scale: 0.8 });
    }

    drawItems(d, m, cx, y0) {
        const pulse = (Math.sin(this.game.ticks * 0.1) * 48 + 207) | 0;
        m.hit = [];
        m.items.forEach((it, i) => {
            const sel = i === m.sel;
            const label = it.value ? `${this.game.strings.t(it.label)}: ${it.value()}` : this.game.strings.t(it.label);
            const y = y0 + i * 14;
            d.text(label, cx, y, { center: true, big: false, color: sel ? [255, pulse, 64, 255] : [220, 220, 220, 255] });
            m.hit.push({ y, i });
        });
    }

    // Splits text into lines no wider than maxWidth in the given font.
    wrapText(font, text, maxWidth) {
        const lines = [];
        let line = '';
        for (const word of text.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (line && font.width(next) > maxWidth) { lines.push(line); line = word; } else line = next;
        }
        if (line) lines.push(line);
        return lines;
    }

    drawList(d, m) {
        const g = this.game;
        d.fillScreen(0, 0, 0, m.pause ? 140 : 200);
        const bg = g.textures.get('gfx/menu/menu_bg.png', { clamp: false, mips: false });
        // headings use the big font; anything too long for the box (e.g. the camel's
        // "Will you travel to ...?") drops to the small font, wrapped
        const title = g.strings.t(m.title || '');
        const maxW = 224;
        const big = g.bigFont.width(title) <= maxW;
        const titleLines = big ? [title] : this.wrapText(g.smallFont, title, maxW);
        const titleH = big ? 28 : titleLines.length * 12 + 10;
        // body text (e.g. the ending screens) is drawn at 0.9 scale, wrapped to the box
        const body = [];
        for (const l of m.lines || []) body.push(...this.wrapText(g.smallFont, g.strings.t(l), maxW / 0.9));
        const h = titleH + 12 + (body.length ? body.length * 11 + 6 : 0) + m.items.length * 14;
        const y0 = Math.max(10, 120 - h / 2);
        if (bg.ready && bg.width) d.img(bg, 40, y0 - 8, 240, h + 16, 0, 0, 240 / bg.width, (h + 16) / bg.height, 200, 200, 200, 255);
        titleLines.forEach((l, i) => d.text(l, 160, y0 + i * 12, { center: true, big }));
        let y = y0 + titleH;
        if (body.length) {
            for (const l of body) { d.text(l, 160, y, { center: true, scale: 0.9 }); y += 11; }
            y += 6;
        }
        this.drawItems(d, m, 160, y);
    }

    drawOverworld(d, m) {
        const g = this.game;
        const info = g.mapInfo[m.sel];
        d.fillScreen(0, 0, 0, 255);
        if (!info) return;
        const v = this.owView(m);
        const orig = this.useOriginalOverworld();
        const bg = orig
            ? g.textures.get('gfx/overworld_orig.png', { clamp: true, mips: true, filter: true })
            : g.textures.getDDS('gfx/overworld.dds', { clamp: true, filter: true });
        if (bg.ready && bg.width) {
            const w = bg.width / bg.height * 512, x0 = -(w * 0.5 - 320);
            d.img(bg, v.tx(x0), v.ty(0), w * v.z, 512 * v.z);
        }
        const x = info.overworldX, y = info.overworldY;
        this.drawOverworldAnim(d, v, 'mapcursor', x, y, 255);
        // unlocked neighbours get a bobbing, pulsing ankh arrow; locked ones a grey fixed one
        const bob = Math.cos((16 - (g.ticks & 31)) * 256 * (Math.PI / 180) ** 2) * 16;
        const pulse = ((bob * 14) | 0) + 31 & 255;
        const arrows = [
            ['maparrow_up', x, y - (bob + 8), x, y - 16],
            ['maparrow_right', x + bob + 16, y, x + 32, y],
            ['maparrow_down', x, y + bob + 8, x, y + 16],
            ['maparrow_left', x - (bob + 16), y, x - 32, y],
        ];
        arrows.forEach(([name, ux, uy, lx, ly], dir) => {
            const n = info.next[dir];
            if (n < 0) return;
            if (g.mapUnlocks[n]) this.drawOverworldAnim(d, v, name, ux, uy, pulse);
            else this.drawOverworldAnim(d, v, name, lx, ly, 128);
        });
        d.text(info.title, 160, 32, { center: true, big: true });
        if (m.zoom > 0 && m.travelling) d.fillScreen(0, 0, 0, Math.round(m.zoom * m.zoom * 255));
    }

    drawInventory(d) {
        const g = this.game, p = g.player;
        d.fillScreen(0, 0, 0, 180);
        d.text('Inventory', 160, 8, { center: true, big: true });
        d.text('Artifacts', 80, 34, { center: true });
        for (let i = 0; i < 6; ++i) {
            const has = p.artifacts & (1 << i);
            const x = 20 + (i % 3) * 42, y = 48 + Math.floor(i / 3) * 52;
            const t = d.pic(`gfx/menu/menuartifact_${i}.png`, -1000, -1000);
            if (t.ready && t.width) {
                const sc = Math.min(40 / t.width, 44 / t.height);
                d.img(t, x + 20 - t.width * sc / 2, y, t.width * sc, t.height * sc, 0, 0, 1, 1, has ? 255 : 50, has ? 255 : 50, has ? 255 : 50, 255);
            }
        }
        d.text('Weapons', 240, 34, { center: true });
        for (let i = 0; i < 8; ++i) {
            const has = p.weaponOwned(i);
            const x = 180 + (i % 2) * 64, y = 48 + Math.floor(i / 2) * 34;
            const t = d.pic(`gfx/menu/menuweapon_${i}.png`, -1000, -1000);
            if (t.ready && t.width) {
                const sc = Math.min(56 / t.width, 30 / t.height);
                d.img(t, x + 28 - t.width * sc / 2, y, t.width * sc, t.height * sc, 0, 0, 1, 1, has ? 255 : 50, has ? 255 : 50, has ? 255 : 50, 255);
            }
        }
        d.text('Keys', 80, 160, { center: true });
        for (let i = 0; i < 4; ++i) d.pic(`gfx/menu/menukey_${i}_${p.checkKey(i) ? 1 : 0}.png`, 46 + i * 18, 172, 16, 15);
        let dolls = 0;
        for (let b = 0; b < 32; ++b) if (p.teamDolls & (1 << b)) dolls++;
        let tx = 0;
        for (let b = 0; b < 8; ++b) if (p.questItems & (1 << b)) tx++;
        d.text(`Team Dolls: ${dolls}   Transmitter parts: ${tx}/8`, 160, 200, { center: true });
        d.text(`Kills: ${g.stats.kills}`, 160, 214, { center: true, scale: 0.9 });
        void PA;
    }
}
