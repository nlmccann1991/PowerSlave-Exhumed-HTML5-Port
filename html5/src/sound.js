// WebAudio sound system. Sounds attached to game objects are panned and
// attenuated like kexGameObject::GetSoundParameters (2048 unit range).

import { clampAngle } from './math.js';

const SOUND_DISTANCE = 2048 * 2048;
const MAX_SOURCES = 48;

export class Sound {
    constructor(game, data) {
        this.game = game;
        this.data = data;
        this.ctx = null;
        this.buffers = new Map();
        this.sources = [];
        this.music = null;
        this.musicPath = null;
        this.sfxVolume = 0.8;
        this.musicVolume = 0.6;
    }

    // Must be called from a user gesture.
    unlock() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            this.ctx = new AC();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.sfxVolume;
            this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (this.music && this.music.paused && this.musicWanted) this.music.play().catch(() => {});
    }

    setVolumes(sfx, music) {
        this.sfxVolume = sfx;
        this.musicVolume = music;
        if (this.master) this.master.gain.value = sfx;
        if (this.music) this.music.volume = music;
    }

    load(path) {
        const key = path.toLowerCase();
        let p = this.buffers.get(key);
        if (p) return p;
        p = (async () => {
            if (!this.ctx) return null;
            const bytes = this.game.kpf.bytes(path);
            if (!bytes) { console.warn('missing sound', path); return null; }
            const copy = bytes.slice().buffer;
            try {
                return await this.ctx.decodeAudioData(copy);
            } catch (e) {
                console.warn('sound decode failed', path, e);
                return null;
            }
        })();
        this.buffers.set(key, p);
        return p;
    }

    params(obj) {
        const g = this.game;
        const player = g.player && g.player.actor;
        if (!obj || obj === player || !g.view) return { volume: 1, pan: 0, ok: true };
        const lo = g.view.origin;
        const dx = obj.origin.x - lo.x, dy = obj.origin.y - lo.y, dz = obj.origin.z - lo.z;
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist > SOUND_DISTANCE) return { volume: 0, pan: 0, ok: false };
        const volume = 1 - dist / SOUND_DISTANCE;
        const ang = Math.atan2(dx, dy);
        const pan = Math.max(-1, Math.min(1, clampAngle(ang - g.view.yaw) / (Math.PI / 2)));
        return { volume, pan, ok: true };
    }

    play(path, obj, looping = false) {
        if (!this.ctx || !path) return;
        if (looping && obj && this.sources.some((s) => s.obj === obj && s.looping)) return;
        const prm = this.params(obj);
        if (!prm.ok) return;
        if (this.sources.length >= MAX_SOURCES) {
            const victim = this.sources.find((s) => !s.looping) || this.sources[0];
            this.stopSource(victim);
        }
        const entry = { obj, looping, path, node: null, gain: null, pan: null, dead: false };
        this.sources.push(entry);
        this.load(path).then((buf) => {
            if (!buf || entry.dead) { this.removeEntry(entry); return; }
            const ctx = this.ctx;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.loop = looping;
            const gain = ctx.createGain();
            gain.gain.value = prm.volume;
            let out = gain;
            if (ctx.createStereoPanner) {
                const pan = ctx.createStereoPanner();
                pan.pan.value = prm.pan;
                gain.connect(pan);
                entry.pan = pan;
                out = pan;
            }
            out.connect(this.master);
            src.connect(gain);
            src.onended = () => this.removeEntry(entry);
            entry.node = src;
            entry.gain = gain;
            src.start();
        });
    }

    playLooping(path, obj) { this.play(path, obj, true); }

    removeEntry(e) {
        e.dead = true;
        const i = this.sources.indexOf(e);
        if (i >= 0) this.sources.splice(i, 1);
    }

    stopSource(e) {
        e.dead = true;
        if (e.node) { try { e.node.stop(); } catch (_) { /* already stopped */ } }
        this.removeEntry(e);
    }

    stopObject(obj) {
        for (const s of this.sources.slice()) if (s.obj === obj) this.stopSource(s);
    }

    stopLooping(obj) {
        for (const s of this.sources.slice()) if (s.obj === obj && s.looping) this.stopSource(s);
    }

    stopAll() {
        for (const s of this.sources.slice()) this.stopSource(s);
    }

    update() {
        for (const s of this.sources) {
            if (!s.obj || !s.gain) continue;
            const p = this.params(s.obj);
            s.gain.gain.value = p.ok ? p.volume : 0;
            if (s.pan) s.pan.pan.value = p.pan;
        }
    }

    // ------------------------------------------------------------------ music

    async playMusic(path, loop = true) {
        if (!path) return;
        const name = path.replace(/^.*\//, '');
        if (this.music && this.musicPath === name && !this.music.paused) return;
        this.stopMusic();
        this.musicPath = name;
        this.musicWanted = true;
        const url = await this.data.musicURL(name);
        if (!url || this.musicPath !== name) return;
        const a = new Audio(url);
        a.loop = loop;
        a.volume = this.musicVolume;
        this.music = a;
        a.play().catch(() => { /* waits for unlock() */ });
    }

    stopMusic() {
        this.musicWanted = false;
        if (this.music) { this.music.pause(); this.music.src = ''; this.music = null; }
        this.musicPath = null;
    }
}
