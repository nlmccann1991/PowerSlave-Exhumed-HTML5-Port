// Top-level game: owns assets, the world, game objects and the fixed 60 Hz
// tick loop. Mirrors kexGameLocal/kexPlayLoop from the GPL source.

import { Renderer } from './render.js';
import { DefSet, dict } from './defs.js';
import { SpriteManager, AnimManager, Font, Strings, loadAnimPics } from './assets.js';
import { parseMap, SF, FF } from './mapfile.js';
import { World } from './world.js';
import { CModel } from './cmodel.js';
import { Actions } from './actions.js';
import { ScriptRuntime } from './script/runtime.js';
import { Sound } from './sound.js';
import { Input } from './input.js';
import { Actor, GameObject } from './actor.js';
import { AI } from './ai.js';
import { Projectile, FireballSpawner, FireballFactory, LaserBeam } from './projectile.js';
import * as P from './pickups.js';
import { Player, Puppet } from './player.js';
import { MOVER_CLASSES } from './movers.js';
import { AF, PF, NUMPLAYERWEAPONS, WS } from './actorflags.js';
import { Vec3, deg2rad } from './math.js';
import { rand } from './random.js';
import { SceneDrawer } from './draw.js';
import { Hud } from './hud.js';
import { Menus } from './menus.js';

const TICK = 1000 / 60;

const ACTOR_CLASSES = {
    kexSlaveActor: Actor, kexActor: Actor,
    kexSlaveAI: AI, kexAI: AI,
    kexSlavePuppet: Puppet, kexPuppet: Puppet,
    kexSlaveProjectile: Projectile, kexProjectile: Projectile,
    kexSlavePickupWeapon: P.WeaponPickup, kexSlavePickupAmmo: P.AmmoPickup, kexSlavePickupHealth: P.HealthPickup,
    kexSlavePickupPower: P.PowerPickup, kexSlavePickupMaxHealth: P.MaxHealthPickup, kexSlavePickupKey: P.KeyPickup,
    kexSlavePickupArtifact: P.ArtifactPickup, kexSlavePickupQuest: P.QuestPickup,
    kexSlavePickupTeamDoll: P.TeamDollPickup, kexSlavePickupMap: P.MapPickup,
    kexSlaveTravelObject: P.TravelObject, kexSlaveCheckpoint: P.Checkpoint,
    kexSlaveFireballSpawner: FireballSpawner, kexSlaveLaserBeam: LaserBeam,
};

// Dynamic light attached to an actor (kexDLight).
class DLight extends GameObject {
    tick() {
        const t = this.target;
        if (t) {
            if (t.removing) this.target = null;
            else this.origin.copy(t.origin);
        }
        if (this.fadeTime > -1) {
            this.fade -= 1 / Math.max(1, this.fadeTime * 2);
            if (this.fade <= 0) this.remove();
        } else if (!this.target) {
            this.remove();
        }
    }
}

export class Game {
    constructor(canvas, data) {
        this.canvas = canvas;
        this.data = data;
        this.kpf = data.kpf;
        this.ticks = 0;
        this.objects = [];
        this.world = null;
        this.view = null;
        this.state = 'boot';
        this.settings = Object.assign({
            difficulty: 0, autoAim: true, crosshair: false, sensitivity: 5, invertY: false,
            sfxVolume: 0.8, musicVolume: 0.6, fov: 64, colorScale: 2.0, language: 'english',
            originalOverworld: false,
        }, this.loadJSON('psx_settings') || {});
        this.languageID = 0;
        this.stats = { kills: 0 };
        this.godMode = false;
        this.noTarget = false;
        this.automap = { enabled: false, mapAll: false, zoom: 2048 };
        this.flashes = { damage: 0, pickup: 0, electrocute: 0, teleport: 0 };
        this.fade = 0;
        this.fadeOut = null;
    }

    async init(progress) {
        const kpf = this.kpf;
        progress?.('renderer');
        this.renderer = new Renderer(this.canvas, kpf);
        this.textures = this.renderer.textures;
        progress?.('definitions');
        this.defs = new DefSet(kpf);
        for (const f of kpf.list('defs/actors/')) this.defs.loadFile(f);
        this.defs.loadFile('defs/weaponInfo.txt');
        this.defs.loadFile('defs/mapInfo.txt');
        this.animPicDefs = loadAnimPics(kpf);
        this.strings = new Strings(kpf);
        this.strings.setLanguage(this.settings.language);
        progress?.('sprites');
        this.sprites = new SpriteManager(kpf, this.textures);
        this.anims = new AnimManager(kpf, this.sprites);
        this.smallFont = new Font(kpf, this.textures, 'smallfont');
        this.bigFont = new Font(kpf, this.textures, 'bigfont');
        this.initWeaponInfo();
        this.initMapInfo();
        this.cmodel = new CModel(this);
        this.actions = new Actions(this);
        this.sound = new Sound(this, this.data);
        this.sound.setVolumes(this.settings.sfxVolume, this.settings.musicVolume);
        this.input = new Input(this, this.canvas);
        this.input.sensitivity = this.settings.sensitivity;
        this.input.invertY = this.settings.invertY;
        this.player = new Player(this);
        this.hud = new Hud(this);
        this.drawer = new SceneDrawer(this);
        progress?.('scripts');
        this.scripts = new ScriptRuntime(this);
        this.scripts.loadCore();
        this.actions.setScriptModule(this.scripts.core);
        this.menus = new Menus(this);
        this.persistent = this.loadJSON('psx_persistent');
        this.mapUnlocks = this.loadJSON('psx_unlocks') || new Array(this.mapInfo.length).fill(false);
        this.selectedMap = this.loadJSON('psx_selected') ?? 0;
        await this.textures.flush();
        this.state = 'title';
        this.menus.openTitle();
        this.lastTime = performance.now();
        this.accum = 0;
        requestAnimationFrame((t) => this.frame(t));
    }

    initWeaponInfo() {
        this.weaponInfo = [];
        for (let i = 0; i < NUMPLAYERWEAPONS; ++i) {
            const d = this.defs.get('Weapon', i);
            const A = (k) => (d && d[k] ? this.anims.get(d[k]) : null);
            this.weaponInfo.push({
                persistent: dict.bool(d, 'persistant'),
                disableUnderwater: dict.bool(d, 'disableUnderwater'),
                maxAmmo: dict.int(d, 'maxAmmo', 1),
                offsetX: dict.float(d, 'offsetX', 0),
                offsetY: dict.float(d, 'offsetY', 0),
                idle: A('idleAnim'), raise: A('raiseAnim'), lower: A('lowerAnim'), fire: A('fireAnim'), flame: A('flameAnim'),
                ammoIdle: [A('ammoIdle_Full'), A('ammoIdle_Half'), A('ammoIdle_Zero')],
                ammoLower: [A('ammoLower_Full'), A('ammoLower_Half'), A('ammoLower_Zero')],
                ammoRaise: [A('ammoRaise_Full'), A('ammoRaise_Half'), A('ammoRaise_Zero')],
                ammoFire: [A('ammoFire_Full'), A('ammoFire_Half'), A('ammoFire_Zero')],
            });
        }
    }

    initMapInfo() {
        this.mapInfo = [];
        for (const d of this.defs.all('Map')) {
            const i = d.__index;
            this.mapInfo[i] = {
                index: i,
                map: dict.str(d, 'map'),
                title: dict.str(d, 'title', ''),
                saveTitle: dict.str(d, 'saveTitle', ''),
                musicTrack: dict.str(d, 'musicTrack'),
                script: dict.str(d, 'script'),
                overworldX: dict.float(d, 'overworld_x'),
                overworldY: dict.float(d, 'overworld_y'),
                transmitter: dict.int(d, 'transmitter', -1),
                next: ['nextmap_north', 'nextmap_east', 'nextmap_south', 'nextmap_west'].map((k) => dict.int(d, k, -1)),
            };
        }
    }

    // language suffix of the localized cutscenes (intro-en.ogv, goodend-de.ogv, ...)
    movieLang() {
        return { german: 'de', french: 'fr', spanish: 'es' }[this.settings.language] || 'en';
    }

    actorDef(typeOrName) {
        return this.defs.get('Actor', typeOrName);
    }

    // ------------------------------------------------------------- settings

    loadJSON(key) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
    }
    saveJSON(key, v) {
        try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* storage unavailable */ }
    }
    saveSettings() {
        this.saveJSON('psx_settings', this.settings);
        this.sound.setVolumes(this.settings.sfxVolume, this.settings.musicVolume);
        this.input.sensitivity = this.settings.sensitivity;
        this.input.invertY = this.settings.invertY;
    }

    // ---------------------------------------------------------------- spawning

    construct(className) {
        const C = ACTOR_CLASSES[className];
        if (!C) { console.warn('unknown class', className); return new Actor(this); }
        return new C(this);
    }

    spawnActor(typeOrName, x, y, z, yaw = 0, sector = -1) {
        let def = null, type = -1;
        if (typeof typeOrName === 'number') {
            type = typeOrName;
            def = this.actorDef(type);
        } else {
            def = this.actorDef(typeOrName);
            if (def) type = def.__index ?? -1;
            else { console.warn('spawnActor: unknown actor', typeOrName); return null; }
        }
        let className = def ? dict.str(def, 'classname', 'kexSlaveActor') : (type === 0 ? 'kexSlavePuppet' : 'kexSlaveActor');
        if (this.noMonsters && className === 'kexSlaveAI') return null;
        const a = this.construct(className);
        a.def = def;
        a.origin.set(x, y, z);
        a.yaw = yaw;
        a.type = type;
        if (sector == null || sector <= -1) a.findSector(a.origin);
        else a.setSector(sector);
        if (!a.sector) { a.findSector(a.origin); if (!a.sector) return null; }
        a.prevOrigin.copy(a.origin);
        this.objects.push(a);
        a.spawn();
        return a;
    }

    spawnFromActor(name, x, y, z, source, yaw) {
        if (!source) return null;
        const a = this.spawnActor(name, source.origin.x, source.origin.y, source.origin.z, yaw, source.sectorIndex());
        if (!a) return null;
        const start = source.origin.clone();
        const end = new Vec3(start.x + x, start.y + y, start.z + z);
        const cm = this.cmodel;
        cm.trace(source, source.sector, start, end);
        a.origin.copy(start.lerp(end, cm.fraction));
        if (cm.contactSector) a.setSector(cm.contactSector);
        a.prevOrigin.copy(a.origin);
        if (!cm.checkActorPosition(a, a.sector)) {
            a.origin.x = source.origin.x;
            a.origin.y = source.origin.y;
            a.setSector(source.sector);
        }
        return a;
    }

    spawnMover(className, type, sector) {
        const w = this.world;
        if (sector <= -1 || sector >= w.sectors.length) return null;
        const sec = w.sectors[sector];
        if (sec.flags & SF.SPECIAL) return null;
        const C = MOVER_CLASSES[className];
        if (!C) return null;
        const m = new C(this);
        m.type = type;
        m.setSector(sec);
        this.objects.push(m);
        m.spawn();
        return m;
    }

    spawnFireballFactory(ma) {
        if (ma.sector <= -1 || ma.sector >= this.world.sectors.length) return null;
        const f = new FireballFactory(this);
        f.fireballType = ma.type;
        f.setSector(this.world.sectors[ma.sector]);
        this.objects.push(f);
        f.spawn();
        return f;
    }

    spawnDynamicLight(source, radius, color, fadeTime = -1, _passes = 0) {
        if (!source || source.removing) return null;
        if (this.objects.filter((o) => o instanceof DLight).length >= 24) return null;
        const l = new DLight(this);
        l.origin.copy(source.origin);
        l.radius = radius;
        l.color = color;
        l.fadeTime = fadeTime;
        l.fade = 1;
        l.target = source;
        this.objects.push(l);
        return l;
    }

    actorFromMapActor(idx) {
        for (const o of this.objects) if (o.mapActor && o.mapActor.index === idx && !o.removing) return o;
        return null;
    }

    // ------------------------------------------------------------- messages

    print(msg, ...args) { this.hud.addMessage(this.strings.t(msg, ...args)); }
    damageFlash() { this.flashes.damage = 128; }
    pickupFlash() { this.flashes.pickup = 96; }
    electrocuteFlash() { this.flashes.electrocute = 200; }
    teleportFlash() { this.flashes.teleport = 200; }
    showArtifact(bit) { this.menus.showArtifact(bit); }
    showTransmitter() {
        let n = 0;
        for (let b = 0; b < 8; ++b) if (this.player.questItems & (1 << b)) n++;
        this.print('$str_072');
        if (n >= 8) this.print('$str_073');
        else this.print('$str_074', n);
    }

    // Map objects that are used up (broken vases, pickups, kills) are recorded so a
    // checkpoint restart doesn't bring them back (A_MarkCheckpoint / MarkCheckpoint()).
    markActorUsed(actor) {
        if (actor && actor.mapActor) this.levelMarks.add(actor.mapActor.index);
    }

    saveCheckpoint(actor) {
        const p = this.player;
        this.savePersistentData();
        this.checkpoint = {
            map: this.activeMap?.index,
            origin: [actor.origin.x, actor.origin.y, actor.origin.z + 1],
            yaw: p.actor ? p.actor.yaw : 0,
            marks: [...this.levelMarks],
            keys: p.keys,
            persistent: this.persistent,
        };
        this.saveGame();
        this.print('$str_150');
    }

    // ---------------------------------------------------------- level flow

    newGame() {
        this.player.reset();
        this.mapUnlocks = new Array(this.mapInfo.length).fill(false);
        this.selectedMap = 0;
        this.checkpoint = null;
        this.savePersistentData();
        this.saveGame();
        this.startMap(0);
    }

    savePersistentData() {
        const p = this.player;
        this.persistent = {
            ammo: p.ammo.slice(), weapons: p.weapons.slice(), ankahs: p.ankahs, ankahFlags: p.ankahFlags,
            artifacts: p.artifacts, questItems: p.questItems, teamDolls: p.teamDolls, abilities: p.abilities,
            health: p.actor ? p.actor.health : p.health, currentWeapon: p.currentWeapon,
        };
    }

    restorePersistentData() {
        const d = this.persistent;
        if (!d) return;
        const p = this.player;
        p.ammo = d.ammo.slice();
        p.weapons = d.weapons.slice();
        p.ankahs = d.ankahs;
        p.ankahFlags = d.ankahFlags;
        p.artifacts = d.artifacts;
        p.questItems = d.questItems;
        p.teamDolls = d.teamDolls;
        p.abilities = d.abilities;
        p.health = Math.max(1, d.health);
        p.pendingWeapon = d.currentWeapon;
        p.changeWeapon();
    }

    saveGame() {
        this.saveJSON('psx_persistent', this.persistent);
        this.saveJSON('psx_unlocks', this.mapUnlocks);
        this.saveJSON('psx_selected', this.selectedMap);
        this.saveJSON('psx_checkpoint', this.checkpoint || null);
        this.saveJSON('psx_hasSave', true);
    }

    hasSave() { return !!this.loadJSON('psx_hasSave'); }

    continueGame() {
        this.persistent = this.loadJSON('psx_persistent');
        this.mapUnlocks = this.loadJSON('psx_unlocks') || this.mapUnlocks;
        this.selectedMap = this.loadJSON('psx_selected') ?? 0;
        this.checkpoint = this.loadJSON('psx_checkpoint');
        this.player.reset();
        this.restorePersistentData();
        this.menus.openOverworld();
    }

    startMap(index, warp = null) {
        const info = this.mapInfo[index];
        if (!info) return;
        this.selectedMap = index;
        this.mapUnlocks[index] = true;
        this.pendingLevel = { index, warp };
        this.state = 'loading';
    }

    travelTo(mapIndex, destPos) {
        this.savePersistentData();
        this.mapUnlocks[mapIndex] = true;
        this.selectedMap = mapIndex;
        this.saveGame();
        this.beginFadeOut(() => this.startMap(mapIndex, destPos ? new Vec3(destPos[0], destPos[1], destPos[2]) : null));
    }

    changeMapFromScript(path) {
        const idx = this.mapInfo.findIndex((m) => m && m.map && m.map.toLowerCase() === path.toLowerCase());
        if (idx >= 0) this.travelTo(idx, null);
    }

    requestExitToOverworld() {
        this.savePersistentData();
        this.saveGame();
        this.beginFadeOut(() => { this.unloadLevel(); this.menus.openOverworld(); });
    }

    requestEnding(good) {
        this.savePersistentData();
        this.saveGame();
        this.beginFadeOut(() => { this.unloadLevel(); this.menus.openEnding(good); });
    }

    openTravelMenu(camel) {
        this.menus.openTravel(camel);
    }

    // kexMenuTravel's "yes": unlock this map and the destination, select it on the overworld
    travelToOverworld(nextMap) {
        this.savePersistentData();
        this.selectedMap = nextMap;
        if (this.activeMap) this.mapUnlocks[this.activeMap.index] = true;
        this.mapUnlocks[nextMap] = true;
        this.saveGame();
        this.beginFadeOut(() => { this.unloadLevel(); this.menus.openOverworld(); });
    }

    beginFadeOut(cb) {
        if (this.fadeOut) return;
        this.fadeOut = { t: 0, cb };
    }

    restartLevel() {
        const idx = this.activeMap.index;
        const cp = this.checkpoint && this.checkpoint.map === idx ? this.checkpoint : null;
        if (cp && cp.persistent) this.persistent = cp.persistent;
        this.restorePersistentData();
        this.pendingCheckpoint = cp;
        this.startMap(idx, cp ? new Vec3(cp.origin[0], cp.origin[1], cp.origin[2]) : null);
    }

    unloadLevel() {
        for (const o of this.objects) o.removing = true;
        this.objects = [];
        this.sound.stopAll();
        this.sound.stopMusic();
        this.scripts.destroyLevel();
        this.world = null;
        this.player.actor = null;
    }

    async loadLevel({ index, warp }) {
        const info = this.mapInfo[index];
        this.unloadLevel();
        this.activeMap = info;
        rand.seed((performance.now() * 1000) >>> 0);
        const bytes = this.kpf.bytes(info.map);
        if (!bytes) throw new Error(`missing map ${info.map}`);
        const map = parseMap(bytes);
        const world = new World(this, map);
        this.world = world;
        this.cmodel.setup(world);
        world.setupAnimPics(this.animPicDefs, this.textures);
        world.setupEvents();
        this.renderer.setWorld(world);
        this.water = new Water();
        this.automap.mapAll = false;
        this.stats = { kills: 0 };
        const cp = this.pendingCheckpoint && this.pendingCheckpoint.map === index ? this.pendingCheckpoint : null;
        this.pendingCheckpoint = null;
        if (!cp && this.checkpoint && this.checkpoint.map !== index) this.checkpoint = null;
        this.levelMarks = new Set(cp ? cp.marks : []);
        for (const ma of map.actors) {
            if (ma.sector < 0 || ma.type <= -1) continue;
            if (this.levelMarks.has(ma.index)) continue;
            // per-difficulty monster placement (SpawnMapActor): params1 bit 0 = not on
            // Normal, bit 1 = not on Hard, bit 2 = not on Pharaoh
            const def = this.actorDef(ma.type);
            if (def && def.classname === 'kexSlaveAI') {
                const mask = [1, 2, 4][this.settings.difficulty] || 1;
                if (ma.params1 & mask) continue;
            }
            const an = deg2rad((360 - ma.angle) + 90);
            const a = this.spawnActor(ma.type, ma.x, ma.y, ma.z, an, ma.sector);
            if (a) a.mapActor = ma;
        }
        // projectile spawners that start active
        for (const ma of map.actors) {
            if ((ma.type === 25 || ma.type === 126 || ma.type === 128) && ma.params1 === -1 && ma.sector >= 0) {
                const sec = world.sectors[ma.sector];
                if (!(sec.flags & SF.SPECIAL)) this.spawnFireballFactory(ma);
            }
        }
        const p = this.player;
        if (!p.actor) throw new Error('map has no player start');
        if (warp) {
            p.actor.origin.copy(warp);
            p.actor.findSector(p.actor.origin);
        }
        p.ready();
        if (cp) {
            p.keys = cp.keys || 0;
            p.actor.yaw = cp.yaw || 0;
        }
        if (this.warpYaw != null) { p.actor.yaw = this.warpYaw; this.warpYaw = null; }
        this.scripts.loadLevel(info.script);
        this.scripts.callDelayedMapScript(0, p.actor, 0);
        this.hud.reset();
        this.sound.playMusic(info.musicTrack, true);
        await this.textures.flush();
        this.levelTicks = 0;
        this.fade = 255;
        this.restartDelay = 60;
        this.paused = false;
        this.state = 'level';
    }

    // ------------------------------------------------------------- main loop

    wantsPointerLock() { return this.state === 'level' && !this.menus.active; }

    // mouse support for menus, in 320x240 virtual coordinates
    toVirtual(e) {
        const d = this.drawer, c = this.canvas;
        return [(e.clientX / c.clientWidth) * d.vw - d.ox, (e.clientY / c.clientHeight) * 240];
    }

    onMouseClick(e) {
        if (!this.menus.active || !this.drawer.vw) return;
        const [x, y] = this.toVirtual(e);
        const m = this.menus.top;
        if (m.kind === 'overworld') { this.menus.onClickOverworld(x, y); return; }
        if (m.kind === 'credits') { this.menus.closeCredits(); return; }
        for (const h of m.hit || []) {
            if (y >= h.y - 2 && y <= h.y + 11) {
                m.sel = h.i;
                const it = m.items[h.i];
                if (it.right && !it.act) { if (x < 160) it.left(); else it.right(); }
                else it.act?.();
                return;
            }
        }
        if (m.kind === 'inventory') this.menus.pop();
    }

    onMouseMove(e) {
        if (!this.menus.active || !this.drawer.vw || document.pointerLockElement) return;
        const [, y] = this.toVirtual(e);
        const m = this.menus.top;
        for (const h of m.hit || []) if (y >= h.y - 2 && y <= h.y + 11) m.sel = h.i;
    }

    frame(t) {
        requestAnimationFrame((tt) => this.frame(tt));
        const dt = Math.min(250, t - this.lastTime);
        this.lastTime = t;
        if (this.state === 'loading' && this.pendingLevel && !this.loadingStarted) {
            this.loadingStarted = true;
            const pl = this.pendingLevel;
            this.loadLevel(pl).catch((e) => {
                console.error(e);
                this.state = 'title';
                this.menus.openTitle();
                this.menus.error = String(e.message || e);
            }).finally(() => { this.pendingLevel = null; this.loadingStarted = false; });
        }
        this.accum += dt;
        let n = 0;
        while (this.accum >= TICK && n < 8) {
            this.tick();
            this.accum -= TICK;
            n++;
        }
        if (n === 8) this.accum = 0;
        try {
            this.draw();
        } catch (e) {
            console.error(e);
        }
    }

    tick() {
        this.ticks++;
        const inp = this.input;
        inp.pollGamepad();
        const pressed = inp.consumePressed();
        this.menus.tickToast();
        if (this.menus.active || this.state !== 'level') {
            this.menus.tick(pressed);
            inp.mouseDX = inp.mouseDY = 0;
            if (this.state !== 'level') return;
            if (this.menus.blocksGame) return;
        }
        if (this.state !== 'level') return;
        for (const a of pressed) {
            if (a === 'menu' || a === 'nav_Escape') { this.menus.openPause(); return; }
            if (a === 'automap') this.automap.enabled = !this.automap.enabled;
            if (a === 'inventory') this.menus.openInventory();
            if (a.startsWith('weapon') && a.length === 7) this.player.selectWeapon(Number(a[6]));
        }
        inp.pressedThisTick = pressed;
        inp.buildCmd(this.player.cmd, document.pointerLockElement === this.canvas || !!inp.pad);
        if (this.levelTicks <= 4) inp.scripted && inp.scripted.length && inp.scripted[0].ticks++;
        this.playLoopTick();
    }

    playLoopTick() {
        const p = this.player;
        if (this.fadeOut) {
            this.fadeOut.t += 4;
            if (this.fadeOut.t >= 255) {
                const cb = this.fadeOut.cb;
                this.fadeOut = null;
                cb();
            }
            return;
        }
        if (p.actor.playerFlags & PF.DEAD) {
            if (--this.restartDelay <= 0) {
                this.beginFadeOut(() => this.restartLevel());
            }
        }
        this.levelTicks++;
        if (this.levelTicks <= 4) return;
        this.world.updateAnimPics();
        this.updateGameObjects();
        if (!this.world) return;
        p.tick();
        this.hud.update();
        this.water.update();
        this.world.updateWaterShading(this.water);
        this.waterBubbles();
        if ((this.levelTicks & 7) === 0) this.markVisibleFaces();
        this.scripts.update();
        for (const k of Object.keys(this.flashes)) {
            if (this.flashes[k] > 0) this.flashes[k] = Math.max(0, this.flashes[k] - (k === 'damage' || k === 'pickup' ? 8 : 4));
        }
        if (p.cmd.buttons & 0x800) this.automap.zoom = Math.max(1024, this.automap.zoom - 64);
        if (p.cmd.buttons & 0x1000) this.automap.zoom = Math.min(8192, this.automap.zoom + 64);
        this.sound.update();
    }

    updateGameObjects() {
        const list = this.objects;
        for (let i = 0; i < list.length; ++i) {
            const o = list[i];
            if (o.removing) continue;
            if (o === this.player.actor) continue;
            o.tick();
        }
        // puppet ticks with the rest of the objects in the original order
        const pa = this.player.actor;
        if (pa && !pa.removing) pa.tick();
        let w = 0;
        for (let i = 0; i < list.length; ++i) {
            const o = list[i];
            if (o.removing) { o.onRemove(); continue; }
            list[w++] = o;
        }
        list.length = w;
    }

    // automap: faces near the player become "mapped" (the original marks drawn faces)
    markVisibleFaces() {
        const pa = this.player.actor, w = this.world;
        if (!pa || !pa.sector) return;
        for (const s of w.floodFill(pa.origin, pa.sector, 2048)) {
            for (let i = s.faceStart; i <= s.faceEnd; ++i) {
                const f = w.faces[i];
                f.flags |= FF.MAPPED;
                f.flags &= ~FF.HIDDEN;
            }
        }
    }

    waterBubbles() {
        if ((this.levelTicks & 63) !== 0) return;
        const pa = this.player.actor;
        if (!pa || !pa.sector || !(pa.sector.flags & SF.WATER)) return;
        const w = this.world;
        const near = w.floodFill(pa.origin, pa.sector, 1024).filter((s) => s.flags & SF.WATER);
        if (!near.length) return;
        const sector = near[rand.max(near.length)];
        const face = sector.floorFace;
        if (face.polyStart < 0) return;
        const poly = w.polys[face.polyStart + rand.max(face.polyEnd - face.polyStart + 1)];
        const o = w.vec(face.vertStart + poly.indices[0]).add(w.vec(face.vertStart + poly.indices[1])).add(w.vec(face.vertStart + poly.indices[2])).scale(1 / 3);
        this.spawnActor(125, o.x, o.y, o.z + 16, 0, sector.index);
    }

    draw() {
        const r = this.renderer;
        if (this.state === 'level' && this.world && this.player.actor) {
            this.drawer.drawLevel();
        } else {
            r.resize();
            const gl = r.gl;
            gl.viewport(0, 0, r.width, r.height);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        }
        this.drawer.begin2D();
        if (this.state === 'level' && this.world && this.player.actor) this.drawer.drawOverlays();
        this.menus.draw(this.drawer);
        if (this.state === 'loading') this.drawer.drawLoading();
        this.drawer.end2D();
    }
}

// Water surface ripple simulation (kexPlayLoop::InitWater/UpdateWater).
class Water {
    constructor() {
        this.vel = new Int32Array(256);
        this.accel = new Int32Array(256);
        this.maxMagnitude = 1;
        for (let i = 0; i < 256; ++i) {
            const r = (rand.max(255) - 128) << 12;
            this.vel[i] = r;
            this.maxMagnitude = Math.max(this.maxMagnitude, Math.abs(r));
        }
    }
    update() {
        const v = this.vel, a = this.accel;
        for (let i = 0; i < 16; ++i) {
            for (let j = 0; j < 16; ++j) {
                let v1 = v[((i + 1) & 15) * 16 + j] + v[((i - 1) & 15) * 16 + j] + v[i * 16 + ((j + 1) & 15)] + v[i * 16 + ((j - 1) & 15)];
                v1 -= v[i * 16 + j] << 2;
                v1 += a[i * 16 + j];
                a[i * 16 + j] = v1;
            }
        }
        for (let i = 0; i < 256; ++i) v[i] += a[i] >> 9;
    }
    velocityAt(x, y) {
        const ix = x | 0, iy = y | 0;
        const index = ((((ix + iy) >> 4) & 60) + (ix & 960)) >> 2;
        return this.vel[index & 0xff];
    }
}
