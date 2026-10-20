// Runtime support for compiled game scripts: helper functions, engine API
// bindings (kexSlave* namespaces/globals) and the level script scheduler
// (CallDelayed/Halt/delay/$restart semantics of kexScriptManager).

import { compileScript } from './ascompiler.js';
import { Vec3, Quat, rotateByQuat, clampAngle, deg2rad, rad2deg } from '../math.js';
import { AF, PA, PW, BC, ADT, DIFFICULTY, PAB } from '../actorflags.js';
import { rand } from '../random.js';

function makeConstants() {
    const c = {};
    for (const [k, v] of Object.entries(AF)) c[`AF_${k}`] = v;
    for (const [k, v] of Object.entries(PA)) c[`PA_${k}`] = v;
    for (const [k, v] of Object.entries(PW)) c[`PW_${k}`] = v;
    for (const [k, v] of Object.entries(BC)) c[`BC_${k}`] = v;
    for (const [k, v] of Object.entries(ADT)) c[`ADT_${k}`] = v;
    for (const [k, v] of Object.entries(PAB)) c[`PAB_${k}`] = v;
    for (const [k, v] of Object.entries(DIFFICULTY)) c[`DIFFICULTY_${k}`] = v;
    return new Proxy(c, {
        get(t, k) {
            if (k in t) return t[k];
            console.warn('script: unknown constant', k);
            t[k] = 0;
            return 0;
        },
    });
}

const op = {
    add(a, b) {
        if (a instanceof Vec3) return typeof b === 'number' ? new Vec3(a.x + b, a.y + b, a.z + b) : a.add(b);
        if (b instanceof Vec3) return new Vec3(a + b.x, a + b.y, a + b.z);
        return a + b;
    },
    sub(a, b) {
        if (a instanceof Vec3) return typeof b === 'number' ? new Vec3(a.x - b, a.y - b, a.z - b) : a.sub(b);
        return a - b;
    },
    mul(a, b) {
        if (a instanceof Vec3) {
            if (b instanceof Quat) return rotateByQuat(a, b);
            if (b instanceof Vec3) return new Vec3(a.x * b.x, a.y * b.y, a.z * b.z);
            return a.scale(b);
        }
        if (a instanceof Quat) return a.mul(b);
        if (b instanceof Vec3) return b.scale(a);
        return a * b;
    },
    div(a, b) {
        if (a instanceof Vec3) return b instanceof Vec3 ? new Vec3(a.x / b.x, a.y / b.y, a.z / b.z) : a.scale(1 / b);
        return a / b;
    },
    mod(a, b) { return a % b; },
    neg(a) { return a instanceof Vec3 ? a.neg() : -a; },
    eq(a, b) { return a.x === b.x && a.y === b.y && a.z === b.z && (a.w === b.w); },
};

function clone(v) { return v && typeof v.clone === 'function' ? v.clone() : v; }

export class ScriptRuntime {
    constructor(game) {
        this.game = game;
        this.core = null;
        this.level = null;
        this.pending = [];
        this.current = null;
        this.rtObject = this.makeRT();
    }

    makeRT() {
        const g = this.game;
        const self = this;
        const randomizer = {
            UInt8: () => rand.byte(),
            UInt16: () => rand.int() & 0xffff,
            UInt32: () => rand.int() >>> 0,
            Int8: () => (rand.byte() << 24) >> 24,
            Int16: () => ((rand.int() & 0xffff) << 16) >> 16,
            Int32: () => rand.int(),
            RInt8: () => (rand.byte() << 24) >> 24,
            RInt16: () => ((rand.int() & 0xffff) << 16) >> 16,
            RInt32: () => rand.int() - 0x40000000,
            Float: () => rand.float(),
            RFloat: () => rand.cfloat(),
            FloatVal: (v) => rand.float() * v,
            RFloatVal: (v) => rand.cfloat() * v,
            RFloatMinMax: (a, b) => rand.range(a, b),
            Max: (n) => rand.max(n),
            Size: (n) => rand.max(n),
            Bit: () => rand.int() & 1,
            Dice: () => rand.max(6) + 1,
        };
        const MathNS = {
            Sin: Math.sin, Cos: Math.cos, Tan: Math.tan, ATan2: Math.atan2, ACos: Math.acos, Sqrt: Math.sqrt,
            InvSqrt: (x) => 1 / Math.sqrt(x), Fabs: Math.abs, Abs: (x) => Math.abs(x) | 0, Floor: Math.floor,
            Ceil: Math.ceil, Pow: Math.pow, Log: Math.log, Deg2Rad: deg2rad, Rad2Deg: rad2deg,
            RandFloat: () => rand.float(), RandCFloat: () => rand.cfloat(), RandRange: (a, b) => rand.range(a, b),
            RandMax: (n) => rand.max(n), RandByte: () => rand.byte(), Rand: () => rand.int(), SysRand: () => rand.int(),
            Lerp: (a, b, t) => a + (b - a) * t, Min: Math.min, Max: Math.max,
            IncMax: (v, inc, max) => Math.min(max, v + inc),
            SmoothStep: (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
            HermiteBlend: (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t)),
            CosArc: (x) => Math.cos(x), CosTween: (x) => 0.5 - Math.cos(x * Math.PI) * 0.5,
            Accelerate: (v, target, speed) => v + (target - v) * speed, NLerp: (a, b, t) => a + (b - a) * t,
        };
        const events = {
            FireRemoteEventFromTag: (tag) => g.world.fireRemoteEventFromTag(tag),
            FireActorEventFromTag: (tag) => g.world.fireActorEventFromTag(tag),
            StopMusic: () => g.sound.stopMusic(),
            PlayMusic: (path, loop) => g.sound.playMusic(path, loop !== false),
            PlayMusicNoLoop: (path) => g.sound.playMusic(path, false),
            PlaySound: (path) => g.sound.play(path, null),
            StopAllSounds: () => g.sound.stopAll(),
            MoveScriptedSector: (tag, height, speed, ceiling) => g.world.moveScriptedSector(tag, height, speed, ceiling),
            GetActorFromMapActorIdx: (idx) => g.actorFromMapActor(idx),
            ChangeMap: (path) => g.changeMapFromScript(path),
            EndGame: (good) => g.requestEnding(!!good),
            OpenDoor: (tag) => g.world.fireRemoteEventFromTag(tag),
            CloseDoor: (tag) => g.world.fireRemoteEventFromTag(tag),
            CloseDoorSlow: (tag) => g.world.fireRemoteEventFromTag(tag),
            FloorLower: (tag) => g.world.fireRemoteEventFromTag(tag),
            LiftLowerWaitRaise: (tag) => g.world.fireRemoteEventFromTag(tag),
            LiftRaiseWaitLower: (tag) => g.world.fireRemoteEventFromTag(tag),
        };
        const levelScript = {
            CallDelayed: (num, instigator, delay) => self.callDelayedMapScript(num, instigator, delay),
            Halt: (num) => self.halt(num),
        };
        const objectFactory = {
            SpawnActor: (name, x, y, z, yaw, sector) => {
                if (typeof x === 'object') { sector = z; yaw = y; z = x.z; y = x.y; x = x.x; }
                return g.spawnActor(name, x, y, z, yaw, sector);
            },
        };
        const automap = {
            IsAlreadyMapped: () => g.automap.mapAll,
            ToggleMapAll: (b) => { g.automap.mapAll = !!b; },
        };
        const globals = {
            Player: () => g.player,
            ObjectFactory: () => objectFactory,
            Automap: () => automap,
            GetDifficulty: () => g.settings.difficulty,
            GetLanguageID: () => g.languageID,
            RandomDecision: (a, r) => a.randomDecision(r),
            Print: (s) => g.print(String(s)),
            Warning: (s) => console.warn(s),
            VideoWidth: () => g.renderer.width,
            VideoHeight: () => g.renderer.height,
        };
        return {
            $c: makeConstants(),
            $g: globals,
            $ns: { Math: MathNS, kexSlaveRandomizer: randomizer, kexSlaveEvents: events, kexSlaveLevelScript: levelScript },
            $op: op,
            $clone: clone,
            $ang: (a) => clampAngle(a),
            $idiv: (a, b) => (b === 0 ? 0 : Math.trunc(a / b)),
            $imod: (a, b) => (b === 0 ? 0 : a % b),
            $len: (x) => (x == null ? 0 : x.length),
            $resize: (arr, n) => { arr.length = n; for (let i = 0; i < n; ++i) if (arr[i] === undefined) arr[i] = 0; },
            $newArray: (n = 0, v = 0) => new Array(n).fill(v),
            $construct: (t) => { console.warn('script: cannot construct', t); return null; },
            $rt: { restartScript: (instigator) => self.restartCurrent(instigator) },
            Vec3, Quat,
        };
    }

    compile(entry) {
        const kpf = this.game.kpf;
        const js = compileScript(entry, (p) => kpf.text(p));
        const rt = this.rtObject;
        const names = Object.keys(rt);
        // eslint-disable-next-line no-new-func
        const factory = new Function(...names, js);
        const mod = factory(...names.map((n) => rt[n]));
        mod.init();
        return mod;
    }

    loadCore() {
        this.core = this.compile('scripts/main.txt');
        if (this.core.functions.main) this.core.functions.main();
        return this.core;
    }

    loadLevel(path) {
        this.destroyLevel();
        if (!path) return;
        try {
            this.level = this.compile(path);
        } catch (e) {
            console.error('level script failed to compile', path, e);
            this.level = null;
        }
    }

    destroyLevel() {
        this.level = null;
        this.pending = [];
    }

    callDelayedMapScript(num, instigator, delay) {
        if (!this.level) return;
        if (typeof num === 'string') {
            const m = /mapscript_(\d+)/.exec(num);
            if (!m) return;
            num = Number(m[1]);
        }
        this.pending.push({ num, instigator, delay: delay || 0, gen: null, dirty: false });
    }

    restartCurrent(instigator) {
        if (this.current) this.callDelayedMapScript(this.current.num, instigator, 0);
    }

    halt(num) {
        for (const s of this.pending) if (s.num === num) s.dirty = true;
    }

    update() {
        if (!this.level) return;
        // scripts queued during this update run from the next tick on
        const snapshot = this.pending.slice();
        for (const s of snapshot) {
            if (s.dirty) continue;
            s.delay -= 1 / 60;
            if (s.delay <= 0) this.run(s);
        }
        this.pending = this.pending.filter((s) => !s.dirty);
    }

    run(s) {
        const fn = this.level.scripts[s.num];
        if (!fn) { s.dirty = true; return; }
        const prev = this.current;
        this.current = s;
        try {
            if (!s.gen) s.gen = fn(s.instigator);
            const r = s.gen.next();
            if (r.done) s.dirty = true;
            else s.delay = Number(r.value) || 0;
        } catch (e) {
            console.error(`map script ${s.num} failed`, e);
            s.dirty = true;
        }
        this.current = prev;
    }
}
