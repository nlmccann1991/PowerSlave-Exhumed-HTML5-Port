// Runtime world: sectors, faces, events and sector movement.
// Port of kexWorld (game/world.cpp) from the GPL PowerslaveEX source.

import { FF, SF } from './mapfile.js';
import { Vec3, deg2rad } from './math.js';
import { rand } from './random.js';

export class World {
    constructor(game, map) {
        this.game = game;
        this.map = map;
        this.vxyz = map.vxyz;
        this.vrgba = map.vrgba;
        this.sectors = map.sectors;
        this.faces = map.faces;
        this.polys = map.polys;
        this.events = map.events;
        this.mapActors = map.actors;
        this.vertsDirty = true;
        this.polysDirty = true;
        this.vertexShade = null;
        // map vertices changed since the last render (moving sectors, water shading)
        this.dirtyMark = new Uint8Array(map.vxyz.length / 3);
        this.dirtyList = [];
        this.pvs = new Uint8Array(map.sectors.length);
        this.animPics = [];
        this.currentTextures = null;

        for (const s of this.sectors) {
            s.ceilingFace = this.faces[s.faceEnd + 1];
            s.floorFace = this.faces[s.faceEnd + 2];
        }
        for (const f of this.faces) this.updateFacePlaneAndBounds(f);
        this.buildSectorBounds();
        this.setupEdges();
    }

    // ---------------------------------------------------------------- helpers

    vx(i) { return this.vxyz[i * 3]; }
    vy(i) { return this.vxyz[i * 3 + 1]; }
    vz(i) { return this.vxyz[i * 3 + 2]; }
    vec(i) { return new Vec3(this.vxyz[i * 3], this.vxyz[i * 3 + 1], this.vxyz[i * 3 + 2]); }

    touchVertex(i) {
        if (!this.dirtyMark[i]) { this.dirtyMark[i] = 1; this.dirtyList.push(i); }
    }

    updateFacePlaneAndBounds(face) {
        const b = face.bounds, x = this.vxyz;
        b.min[0] = b.min[1] = b.min[2] = Infinity;
        b.max[0] = b.max[1] = b.max[2] = -Infinity;
        for (let j = 0; j < 4; ++j) {
            const v = (face.vertexStart + j) * 3;
            for (let k = 0; k < 3; ++k) {
                if (x[v + k] < b.min[k]) b.min[k] = x[v + k];
                if (x[v + k] > b.max[k]) b.max[k] = x[v + k];
            }
        }
        const v0 = face.vertexStart * 3;
        const p = face.plane;
        p[3] = x[v0] * p[0] + x[v0 + 1] * p[1] + x[v0 + 2] * p[2];
    }

    updateSectorBounds(sector) {
        const b = sector.bounds, x = this.vxyz;
        b.min[0] = b.min[1] = b.min[2] = Infinity;
        b.max[0] = b.max[1] = b.max[2] = -Infinity;
        for (const f of [sector.ceilingFace, sector.floorFace]) {
            for (let j = 0; j < 4; ++j) {
                const v = (f.vertexStart + j) * 3;
                for (let k = 0; k < 3; ++k) {
                    if (x[v + k] < b.min[k]) b.min[k] = x[v + k];
                    if (x[v + k] > b.max[k]) b.max[k] = x[v + k];
                }
            }
        }
    }

    buildSectorBounds() {
        for (const s of this.sectors) this.updateSectorBounds(s);
    }

    // Edge ids: 0 top (v0->v1), 1 right (v1->v2), 2 bottom (v2->v3), 3 left (v3->v0)
    setupEdges() {
        const EGF_TOPSTEP = 1, EGF_BOTTOMSTEP = 2;
        const z = (f, i) => this.vz(f.vertexStart + (i & 3));
        for (const sector of this.sectors) {
            for (let j = sector.faceStart; j <= sector.faceEnd; ++j) {
                const face = this.faces[j];
                if (face.flags & FF.SOLID) continue;
                if (face.polyStart !== -1 && face.polyEnd !== -1) continue;
                // l1 = left edge (v3->v0), r1 = right edge (v1->v2)
                for (let k = sector.faceStart; k <= sector.faceEnd; ++k) {
                    if (k === j) continue;
                    const f = this.faces[k];
                    if (f.polyStart === -1 || f.polyEnd === -1) continue;
                    // r2->v2 = f.v2, r1->v1 = face.v1, l2->v1 = f.v3, l1->v2 = face.v0
                    if (Math.abs(z(f, 2) - z(face, 1)) <= 0.001 && Math.abs(z(f, 3) - z(face, 0)) <= 0.001) {
                        f.edgeFlags[2] |= EGF_TOPSTEP;
                    }
                    if (Math.abs(z(f, 1) - z(face, 2)) <= 0.001 && Math.abs(z(f, 0) - z(face, 3)) <= 0.001) {
                        f.edgeFlags[0] |= EGF_BOTTOMSTEP;
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------- textures

    setupAnimPics(animPicDefs, textureManager) {
        const map = this.map;
        this.baseTextures = map.textures.map((t) => (t ? textureManager.get(t, { mips: true }) : null));
        this.currentTextures = this.baseTextures.slice();
        this.animPics = map.textures.map((t) => {
            if (!t) return null;
            const d = animPicDefs.get(t.toLowerCase());
            if (!d) return null;
            const frames = [this.baseTextures[map.textures.indexOf(t)]];
            for (let i = 1; d[`texture_${i}`]; ++i) frames.push(textureManager.get(d[`texture_${i}`], { mips: true }));
            return { speed: Number(d.speed) || 1, time: 0, frame: 0, frames };
        });
    }

    updateAnimPics() {
        for (let i = 0; i < this.animPics.length; ++i) {
            const a = this.animPics[i];
            if (!a) continue;
            a.time += 0.5;
            if (a.time >= a.speed) {
                a.time = 0;
                if (++a.frame >= a.frames.length) a.frame = 0;
                this.currentTextures[i] = a.frames[a.frame];
            }
        }
    }

    // --------------------------------------------------------------- events

    setupEvents() {
        const g = this.game;
        for (const ev of this.events) {
            if (ev.sector < 0) continue;
            const s = this.sectors[ev.sector];
            s.event = ev.index;
            let height;
            switch (ev.type) {
            case 1: case 2: case 3: case 4: case 5: case 6: case 7:
                this.makeSectorDynamic(s, true);
                break;
            case 8: case 9:
                this.makeSectorDynamic(s, true);
                this.moveSector(s, true, s.ceilingHeight - s.floorHeight);
                break;
            case 21: case 22:
                this.makeSectorDynamic(s, false);
                height = this.getHighestSurroundingFloor(s);
                this.moveSector(s, false, -(s.floorFace.plane[3] - height));
                break;
            case 23:
                height = s.floorHeight + 16;
                this.makeSectorDynamic(s, false);
                this.moveSector(s, false, -(s.floorFace.plane[3] - height));
                break;
            case 24:
                height = this.getLowestSurroundingFloor(s);
                this.makeSectorDynamic(s, false);
                this.moveSector(s, false, -(s.floorFace.plane[3] - height));
                break;
            case 25:
                this.makeSectorDynamic(s, false);
                g.spawnMover('kexFloor', ev.type, ev.sector);
                break;
            case 41: case 43: case 44: case 45: case 46: case 47: case 60: case 65: case 68:
                this.setupFloatingPlatforms(ev, s, 'kexFloatingPlatform');
                break;
            case 48:
                this.setupFloatingPlatforms(ev, s, 'kexDropPad');
                break;
            default:
                break;
            }
        }
        for (const f of this.faces) {
            if (this.eventIsASwitch(f.tag)) f.flags |= FF.DYNAMIC;
            if (f.flags & (FF.WATER | FF.TOGGLE | FF.FORCEFIELD)) f.flags |= FF.DYNAMIC;
        }
    }

    setupFloatingPlatforms(ev, sector, className) {
        sector.event = -1;
        this.sectors[ev.params].event = ev.index;
        ev.sector = ev.params;
        ev.params = sector.index;
        const s = this.sectors[ev.sector];
        s.linkedSector = ev.params;
        s.objectThinker = this.game.spawnMover(className, ev.type, ev.sector);
    }

    eventIsASwitch(id) {
        if (id < 0 || id >= this.events.length) return false;
        const t = this.events[id].type;
        return t === 200 || t === 201 || t === 202 || t === 203;
    }

    makeSectorDynamic(sector, bCeiling) {
        for (let i = sector.faceStart; i < sector.faceEnd + 3; ++i) {
            const face = this.faces[i];
            if ((face.flags & FF.PORTAL) && face.sector >= 0) {
                const s = this.sectors[face.sector];
                for (let j = s.faceStart; j < s.faceEnd + 3; ++j) {
                    const f = this.faces[j];
                    if (f.tag === -1 || f.tag !== sector.event || (f.flags & FF.PORTAL)) continue;
                    f.flags |= FF.DYNAMIC;
                }
                if (i <= sector.faceEnd && !(face.flags & FF.PORTAL)) face.flags |= FF.DYNAMIC;
                continue;
            }
            if (i !== sector.faceEnd + (bCeiling ? 1 : 2)) continue;
            face.flags |= FF.DYNAMIC;
        }
    }

    moveSector(sector, bCeiling, moveAmount) {
        if (!moveAmount) return;
        const updated = [];
        const xyz = this.vxyz;
        const bump = (vi, amt) => { xyz[vi * 3 + 2] += amt; this.touchVertex(vi); };
        for (let i = sector.faceStart; i < sector.faceEnd + 3; ++i) {
            const face = this.faces[i];
            if (face.flags & FF.UPDATED) continue;
            if ((face.flags & FF.PORTAL) && face.sector >= 0) {
                const s = this.sectors[face.sector];
                for (let j = s.faceStart; j < s.faceEnd + 3; ++j) {
                    const f = this.faces[j];
                    if ((f.flags & FF.PORTAL) && f.sector === face.sectorOwner && j <= s.faceEnd) {
                        if (bCeiling) { bump(f.vertexStart, moveAmount); bump(f.vertexStart + 1, moveAmount); }
                        else { bump(f.vertexStart + 2, moveAmount); bump(f.vertexStart + 3, moveAmount); }
                        this.updateFacePlaneAndBounds(f);
                        continue;
                    }
                    if (f.tag === -1 || f.tag !== sector.event || (f.flags & FF.PORTAL)) continue;
                    if (f.flags & FF.UPDATED) continue;
                    for (let k = f.vertStart; k <= f.vertEnd; ++k) bump(k, moveAmount);
                    for (let k = 0; k < 4; ++k) bump(f.vertexStart + k, moveAmount);
                    this.updateFacePlaneAndBounds(f);
                    f.flags |= FF.UPDATED;
                    updated.push(f);
                }
                if (i <= sector.faceEnd) {
                    if (bCeiling) { bump(face.vertexStart, moveAmount); bump(face.vertexStart + 1, moveAmount); }
                    else { bump(face.vertexStart + 2, moveAmount); bump(face.vertexStart + 3, moveAmount); }
                    this.updateFacePlaneAndBounds(face);
                }
                this.updateSectorBounds(s);
            }
            if (i !== sector.faceEnd + (bCeiling ? 1 : 2)) continue;
            if (face.flags & FF.UPDATED) continue;
            for (let j = face.vertStart; j <= face.vertEnd; ++j) bump(j, moveAmount);
            for (let k = 0; k < 4; ++k) bump(face.vertexStart + k, moveAmount);
            this.updateFacePlaneAndBounds(face);
            face.flags |= FF.UPDATED;
            updated.push(face);
        }
        this.updateSectorBounds(sector);

        const cm = this.game.cmodel;
        for (const actor of sector.actors) {
            if (actor.origin.z <= actor.floorHeight || Math.abs(actor.velocity.z) <= 0.001) {
                const d = cm.getFloorHeight(actor.origin, sector);
                const floorDist = actor.origin.z - d;
                if (floorDist <= -(moveAmount * 2)) {
                    actor.floorHeight = d;
                    actor.origin.z = d;
                }
                if (!actor.isPuppet && moveAmount > 0 && floorDist <= 0.1) {
                    actor.velocity.z += moveAmount * 0.5;
                }
            }
        }
        for (const f of updated) f.flags &= ~FF.UPDATED;
    }

    getHighestSurroundingFloor(sector) {
        let height = sector.floorHeight;
        for (let i = sector.faceStart; i < sector.faceEnd + 3; ++i) {
            const face = this.faces[i];
            if ((face.flags & FF.PORTAL) && face.sector >= 0) {
                const s = this.sectors[face.sector];
                if (s.floorHeight > height) height = s.floorHeight;
            }
        }
        if (Math.trunc(height) === sector.floorHeight) height = this.faces[sector.faceEnd + 2].plane[3];
        return height;
    }

    getLowestSurroundingFloor(sector) {
        let height = this.faces[sector.faceEnd + 2].plane[3];
        for (let i = sector.faceStart; i < sector.faceEnd + 3; ++i) {
            const face = this.faces[i];
            if ((face.flags & FF.PORTAL) && face.sector >= 0) {
                const s = this.sectors[face.sector];
                if (s.floorHeight < height) height = s.floorHeight;
            }
        }
        if (Math.abs(height - this.faces[sector.faceEnd + 2].plane[3]) < 0.0001) height = sector.floorHeight;
        return height;
    }

    // -------------------------------------------------------------- use/specials

    useWallSpecial(player, face) {
        if (face.tag <= -1) return;
        const ev = this.events[face.tag];
        const g = this.game;
        if (ev.sector >= 0 && (this.sectors[ev.sector].flags & SF.SPECIAL) && ev.type !== 7) return;
        switch (ev.type) {
        case 1: g.spawnMover('kexDoor', ev.type, ev.sector); break;
        case 3: case 4: case 5: case 6: this.useLockedDoor(player, ev); break;
        case 7: g.print('$str_092'); break;
        case 8: case 9: g.spawnMover('kexDoor', ev.type, ev.sector); break;
        case 21: g.spawnMover('kexLiftImmediate', ev.type, ev.sector); break;
        case 200: case 201: case 202: case 203: this.useWallSwitch(player, face, ev); break;
        default: break;
        }
    }

    useLockedDoor(player, ev) {
        if (!player.checkKey(ev.type - 3)) {
            this.game.print(`$str_${String(116 + (ev.type - 3)).padStart(3, '0')}`);
            return;
        }
        this.game.spawnMover('kexDoor', ev.type, ev.sector);
    }

    useWallSwitch(player, face, ev) {
        const switchTex = (ev.params >> 8) & 0xff;
        let found = false;
        for (let i = face.polyStart; i <= face.polyEnd; ++i) {
            const poly = this.polys[i];
            if (poly.texture === switchTex) { poly.texture = ev.params & 0xff; found = true; }
        }
        if (!found) return;
        this.polysDirty = true;
        player.actor.playSound(ev.type === 202 || ev.type === 203 ? 'sounds/switch2.wav' : 'sounds/switch.wav');
        this.sendRemoteTrigger(this.sectors[ev.sector], ev);
    }

    resetWallSwitchFromTag(tag) {
        for (const ev of this.events) {
            if (ev.tag !== tag) continue;
            if (!this.eventIsASwitch(ev.index)) {
                if (ev.type === 23) {
                    const sector = this.sectors[ev.sector];
                    if (sector.objectThinker) sector.objectThinker.trigger();
                }
                continue;
            }
            const sector = this.sectors[ev.sector];
            const switchTex = ev.params & 0xff;
            for (let j = sector.faceStart; j < sector.faceEnd + 3; ++j) {
                const face = this.faces[j];
                if (face.tag !== ev.index) continue;
                for (let k = face.polyStart; k <= face.polyEnd; ++k) {
                    const poly = this.polys[k];
                    if (poly.texture === switchTex) { poly.texture = (ev.params >> 8) & 0xff; this.polysDirty = true; }
                }
            }
        }
    }

    fireRemoteEventFromTag(tag) {
        for (const ev of this.events) {
            if (ev.tag !== tag || ev.type === 70) continue;
            this.triggerEvent(ev);
        }
    }

    moveScriptedSector(tag, height, speed, bCeiling) {
        for (const ev of this.events) {
            if (ev.tag !== tag || ev.type !== 49) continue;
            if (speed <= -1) {
                this.moveSector(this.sectors[ev.sector], !!(false ^ bCeiling), height);
                if (ev.params >= 0) this.moveSector(this.sectors[ev.params], !!(true ^ bCeiling), height);
                continue;
            }
            const mover = this.game.spawnMover('kexScriptedMover', ev.type, ev.sector);
            if (mover) mover.start(height, speed, ev, bCeiling);
        }
    }

    triggerEvent(ev) {
        const g = this.game;
        switch (ev.type) {
        case 2: case 7: case 8: case 9: g.spawnMover('kexDoor', ev.type, ev.sector); break;
        case 21: g.spawnMover('kexLiftImmediate', ev.type, ev.sector); break;
        case 22: g.spawnMover('kexFloor', ev.type, ev.sector); break;
        case 24: g.spawnMover('kexLiftImmediate', ev.type, ev.sector); break;
        case 25: this.sectors[ev.sector].objectThinker?.trigger(); break;
        case 48: this.sectors[ev.sector].objectThinker?.reset(); break;
        default: break;
        }
    }

    enterSectorSpecial(actor, sector) {
        if (sector.event <= -1 || (sector.flags & SF.SPECIAL)) return;
        const ev = this.events[sector.event];
        const g = this.game;
        if (ev.type !== 50) {
            const fp = sector.floorFace.plane;
            const d = fp[0] * actor.origin.x + fp[1] * actor.origin.y + fp[2] * actor.origin.z - fp[3];
            if (d > actor.stepHeight) return;
        }
        switch (ev.type) {
        case 21: g.spawnMover('kexLift', ev.type, ev.sector); break;
        case 23:
            actor.playSound('sounds/fplate.wav');
            this.resetWallSwitchFromTag(ev.tag + 1);
            g.spawnMover('kexFloor', ev.type, ev.sector);
            break;
        case 24: g.spawnMover('kexLift', ev.type, ev.sector); break;
        case 48: sector.objectThinker?.start(); break;
        case 50: this.sendRemoteTrigger(sector, ev); break;
        case 52:
            g.scripts.callDelayedMapScript(ev.tag + 1, actor, 0);
            sector.event = -1;
            break;
        case 53: this.artifactEvent(actor, ev); break;
        case 63: g.scripts.callDelayedMapScript(ev.tag + 1, actor, 0); break;
        case 71: this.teleportEvent(actor, ev); break;
        default: break;
        }
    }

    fireActorEventFromTag(tag) {
        if (tag < 0) return; // -1 is "no tag"; untagged actors (e.g. Tomb's lasers) never respond
        let extraDelay = 0;
        const g = this.game;
        for (const ma of this.mapActors) {
            if (ma.sector < 0) continue;
            const sec = this.sectors[ma.sector];
            if (ma.tag === tag) {
                if (sec.flags & SF.SPECIAL) continue;
                switch (ma.type) {
                case 127:  // Special_LaserBeamSpawner toggles itself
                    for (const a of sec.actors) if (a.mapActor === ma) a.onActivate(null);
                    break;
                case 25:   // Special_FireballSpawner
                case 126:  // Special_LaserSpawner
                case 128: { // Special_BoulderSpawner
                    const f = g.spawnFireballFactory(ma);
                    if (f) f.extraDelay = extraDelay;
                    extraDelay += 8;
                    break;
                }
                default: break;
                }
            }
            if (ma.tag + 1 === tag) {
                if (ma.type === 127) {
                    for (const a of sec.actors) if (a.mapActor === ma) a.onDeactivate();
                    continue;
                }
                if (!(sec.flags & SF.SPECIAL) || !sec.objectThinker) continue;
                sec.objectThinker.remove();
            }
        }
    }

    sendMapActorEvent(sector, ev) {
        if (sector && (ev.sector < 0 || this.sectors[ev.sector] !== sector)) return;
        this.fireActorEventFromTag(ev.tag);
    }

    teleportEvent(actor, event) {
        for (const ev of this.events) {
            if (ev === event || ev.type !== 72 || ev.tag !== event.tag || ev.sector <= -1) continue;
            const face = this.sectors[ev.sector].floorFace;
            const o = this.vec(face.vertexStart).add(this.vec(face.vertexStart + 1)).add(this.vec(face.vertexStart + 2)).scale(1 / 3);
            actor.origin.copy(o);
            actor.setSector(this.sectors[ev.sector]);
            if (actor.isPuppet) {
                actor.playSound('sounds/teleport.wav');
                this.game.teleportFlash();
            }
            break;
        }
    }

    artifactEvent(actor, event) {
        if (!actor.isPuppet) return;
        const g = this.game;
        const player = actor.owner;
        const artiBit = event.tag - 1;
        if (!(player.artifacts & (1 << artiBit))) return;
        let template = null;
        for (const ma of this.mapActors) {
            const def = g.actorDef(ma.type);
            if (def && def.type !== undefined && Number(def.type) === artiBit) { template = ma; break; }
        }
        if (!template) return;
        for (const ev of this.events) {
            if (ev === event || ev.type !== 54 || ev.tag !== event.tag || ev.sector <= -1) continue;
            const face = this.sectors[ev.sector].floorFace;
            const o = this.vec(face.vertexStart).add(this.vec(face.vertexStart + 1)).add(this.vec(face.vertexStart + 2)).scale(1 / 3);
            player.artifacts &= ~(1 << artiBit);
            this.fireRemoteEventFromTag(1000 + artiBit);
            const obj = g.spawnActor(template.type, o.x, o.y, o.z + 16, 0, ev.sector);
            if (obj) {
                obj.playSound('sounds/ding02.wav');
                g.spawnDynamicLight(obj, 512, [1, 1, 1], 32);
            }
        }
    }

    sendRemoteTrigger(sector, event) {
        let clearEventRef = false;
        for (const ev of this.events) {
            if (!this.eventIsASwitch(event.index) && event.type !== 23 && ev.tag === event.tag + 1) {
                this.resetWallSwitchFromTag(ev.tag);
            }
            this.sendMapActorEvent(sector, ev);
            if (ev === event) continue;
            if (ev.tag === event.tag) {
                if (ev.sector >= 0 && (this.sectors[ev.sector].flags & SF.SPECIAL)) continue;
                if (ev.type === event.type) {
                    if (event.type === 66) {
                        ev.tag = -1;
                        if (sector) sector.event = -1;
                        this.explodeWallEvent(this.sectors[ev.sector]);
                    }
                    continue;
                }
                this.triggerEvent(ev);
                switch (ev.type) {
                case 7: case 8: case 9: case 21: case 22: case 24: clearEventRef = true; break;
                default: break;
                }
            } else if (ev.tag + 1 === event.tag) {
                if (ev.sector < 0) continue;
                const sec = this.sectors[ev.sector];
                if (!(sec.flags & SF.SPECIAL) || !sec.objectThinker) continue;
                if (ev.type === 23) sec.objectThinker.trigger();
            }
        }
        if (clearEventRef && sector && event.type !== 23) sector.event = -1;
    }

    // Breaks a single face (FUN_1401b83d0): it becomes a non-solid portal and its
    // tiles turn into explosion puffs or debris.
    explodeFace(face) {
        if (!(face.flags & FF.TOGGLE)) return;
        const g = this.game;
        face.flags = (face.flags & ~(FF.TOGGLE | FF.SOLID)) | FF.PORTAL;
        const n = new Vec3(face.plane[0], face.plane[1], face.plane[2]);
        if (face.polyStart >= 0 && face.polyEnd >= 0) {
            for (let j = face.polyStart; j <= face.polyEnd; ++j) {
                const poly = this.polys[j];
                const o = this.vec(face.vertStart + poly.indices[0])
                    .add(this.vec(face.vertStart + poly.indices[1]))
                    .add(this.vec(face.vertStart + poly.indices[2])).scale(1 / 3);
                if (!(rand.int() & 1)) {
                    o.x += rand.byte() - 128; o.y += rand.byte() - 128; o.z += rand.byte() - 128;
                    g.spawnActor(62, o.x, o.y, o.z, 0, face.sectorOwner);
                } else {
                    const debris = g.spawnActor(123, o.x, o.y, o.z, 0, face.sectorOwner);
                    if (!debris) continue;
                    debris.velocity.copy(n.scale(16 * rand.float()));
                    debris.velocity.z += 16 * rand.float();
                }
            }
        }
        face.polyStart = face.polyEnd = -1;
        this.polysDirty = true;
    }

    // A sector whose wall got blown open fires its type-66 event, and every other
    // type-66 event with the same tag (FUN_1401b8090).
    breakSectorEvent(sector) {
        if (sector.event < 0) return;
        const ev = this.events[sector.event];
        if (!ev || ev.type !== 66) return;
        sector.event = -1;
        this.sendRemoteTrigger(sector, ev);
        for (const other of this.events) {
            if (other === ev || other.type !== 66 || other.tag !== ev.tag || other.sector < 0) continue;
            const s = this.sectors[other.sector];
            if (s.event !== other.index) continue;
            s.event = -1;
            this.sendRemoteTrigger(s, other);
        }
    }

    static boundsOverlap(a, b) {
        return a.min[0] <= b.max[0] && a.min[1] <= b.max[1] && a.min[2] <= b.max[2] &&
               b.min[0] <= a.max[0] && b.min[1] <= a.max[1] && b.min[2] <= a.max[2];
    }

    // Blows open a breakable wall and everything attached to it (FUN_1401b8800):
    // touching breakable faces in the owner sector, the breakable faces of the
    // (usually thin) sector behind it, and breakable faces beyond that which touch.
    explodeWall(face) {
        if (!(face.flags & FF.TOGGLE)) return;
        const owner = this.sectors[face.sectorOwner];
        this.breakSectorEvent(owner);
        const backIdx = face.sector;
        this.explodeFace(face);
        if (backIdx < 0) return;
        const back = this.sectors[backIdx];
        this.breakSectorEvent(back);
        const overlap = World.boundsOverlap;
        for (let i = owner.faceStart; i < owner.faceEnd + 3; ++i) {
            const f = this.faces[i];
            if (f !== face && (f.flags & FF.TOGGLE) && overlap(f.bounds, face.bounds)) this.explodeWall(f);
        }
        for (let i = back.faceStart; i < back.faceEnd + 3; ++i) {
            const f = this.faces[i];
            if (f.flags & FF.TOGGLE) this.explodeWall(f);
            if (f.sector < 0) continue;
            const s = this.sectors[f.sector];
            for (let j = s.faceStart; j < s.faceEnd + 3; ++j) {
                const h = this.faces[j];
                if ((h.flags & FF.TOGGLE) && (overlap(h.bounds, f.bounds) || overlap(h.bounds, face.bounds))) this.explodeWall(h);
            }
        }
    }

    // Wall explosions triggered by a remote type-66 event.
    explodeWallEvent(sector) {
        for (let i = sector.faceStart; i < sector.faceEnd + 3; ++i) {
            const face = this.faces[i];
            if (face.flags & FF.TOGGLE) this.explodeWall(face);
        }
        this.breakSectorEvent(sector);
    }

    // Radial blast damage (FUN_1401a16b0): floods through portals near the blast,
    // damages shootable actors with a smoothstep falloff, knocks back actors that
    // allow it and breaks breakable walls whose tiles the blast can reach.
    radialDamage(source, radius, damage, canDestroyWalls = true) {
        if (!source.sector || radius <= 0) return;
        const cm = this.game.cmodel;
        const center = new Vec3(source.origin.x, source.origin.y, source.origin.z + source.height * 0.5);
        const r2 = radius * radius;
        const visited = new Uint8Array(this.sectors.length);
        const queue = [source.sector];
        visited[source.sector.index] = 1;
        const toBreak = [];
        const smooth = (t) => (3 - 2 * t) * t * t;
        for (let qi = 0; qi < queue.length; ++qi) {
            const sector = queue[qi];
            for (const actor of [...sector.actors]) {
                if (actor === source || !(actor.flags & AF_SHOOTABLE)) continue;
                const p = new Vec3(actor.origin.x, actor.origin.y, actor.origin.z + actor.height * 0.5);
                const d2 = center.distanceSq(p);
                if (d2 > r2) continue;
                if (actor.sector !== source.sector && cm.trace(source, source.sector, center, p, 0, false)) continue;
                const t = (radius - Math.sqrt(d2)) / radius;
                if (t <= 0) continue;
                const s = Math.min(1, Math.max(0, t / 0.9));
                if (canDestroyWalls && actor.isAI && actor.canIgnite) actor.igniteFrom(source);
                actor.inflictDamage(source, Math.trunc(smooth(s) * damage));
                if (actor.allowConcuss) {
                    const d = p.sub(source.origin);
                    const len = d.length() || 1;
                    let k = smooth(Math.min(1, Math.max(0, 2 * t))) * damage;
                    if (actor.scale > 0 && actor.scale !== 1) k /= actor.scale;
                    actor.velocity.x += k * 0.25 * d.x / len;
                    actor.velocity.y += k * 0.25 * d.y / len;
                    actor.velocity.z = Math.min(actor.velocity.z, 0) + k * 0.1575 * d.z / len;
                    actor.concussed = true; // flag 0x400000: the player turns this into a jump boost
                }
            }
            for (let i = sector.faceStart; i < sector.faceEnd + 3; ++i) {
                const face = this.faces[i];
                if ((face.flags & FF.SOLID) && (face.flags & FF.TOGGLE) && canDestroyWalls) {
                    const b = face.bounds;
                    const dx = (b.min[0] + b.max[0]) * 0.5 - center.x;
                    const dy = (b.min[1] + b.max[1]) * 0.5 - center.y;
                    const dz = (b.min[2] + b.max[2]) * 0.5 - center.z;
                    const rz = radius * 0.575;
                    if (dx * dx + dy * dy <= r2 && dz * dz <= rz * rz) {
                        if (face.polyStart < 0 || face.polyEnd < 0) {
                            toBreak.push(face);
                        } else {
                            const n = cm.normal(face);
                            for (let j = face.polyStart; j <= face.polyEnd; ++j) {
                                const poly = this.polys[j];
                                const pc = this.vec(face.vertStart + poly.indices[0])
                                    .add(this.vec(face.vertStart + poly.indices[1]))
                                    .add(this.vec(face.vertStart + poly.indices[2]));
                                const target = poly.indices[3] !== 0xff
                                    ? pc.add(this.vec(face.vertStart + poly.indices[3])).scale(0.25)
                                    : pc.scale(1 / 3);
                                target.addSelf(n);
                                cm.trace(source, source.sector, center, target, 0, false);
                                if (!cm.contactFace || cm.contactFace === face) { toBreak.push(face); break; }
                            }
                        }
                    }
                }
                if ((face.flags & FF.PORTAL) && face.sector >= 0 && !visited[face.sector]) {
                    if (cm.planeDist(face, center) < radius) {
                        visited[face.sector] = 1;
                        queue.push(this.sectors[face.sector]);
                    }
                }
            }
        }
        for (const f of toBreak) this.explodeWall(f);
    }

    floodFill(start, sector, maxDistance) {
        if (!sector) return [];
        const scan = [sector];
        sector.floodCount = 1;
        this.pvs.fill(0);
        this.pvs[sector.index] = 1;
        const cm = this.game.cmodel;
        for (let sc = 0; sc < scan.length; ++sc) {
            const sec = scan[sc];
            if (sec.floodCount === 0) continue;
            sec.floodCount = 0;
            for (let i = sec.faceStart; i < sec.faceEnd + 3; ++i) {
                const face = this.faces[i];
                if (!(face.flags & FF.PORTAL) || face.sector <= -1) continue;
                const d = cm.pointOnFaceSide(start, face);
                if (d <= 0) continue;
                if (d >= maxDistance) break;
                if (this.pvs[face.sector]) continue;
                this.pvs[face.sector] = 1;
                const next = this.sectors[face.sector];
                next.floodCount = 1;
                scan.push(next);
            }
        }
        return scan;
    }

    // Water ripple shading for SF_WATER sectors (kexRenderScene::ShadeWaterColor)
    updateWaterShading(water) {
        if (!this.waterVerts) {
            const set = new Set();
            for (const s of this.sectors) {
                const isWater = s.flags & SF.WATER;
                for (let i = s.faceStart; i < s.faceEnd + 3; ++i) {
                    const f = this.faces[i];
                    if (!isWater && !(f.flags & FF.WATER)) continue;
                    for (let k = f.vertStart; k <= f.vertEnd; ++k) set.add(k);
                }
            }
            this.waterVerts = [...set];
            this.vertexShade = new Int16Array(this.vxyz.length / 3);
        }
        if (!this.waterVerts.length) return;
        const xyz = this.vxyz, rgba = this.vrgba;
        for (const v of this.waterVerts) {
            const x = xyz[v * 3], y = xyz[v * 3 + 1], z = xyz[v * 3 + 2];
            const vel = water.velocityAt(x + z, y + z);
            const max = ((rgba[v * 4] + rgba[v * 4 + 1] + rgba[v * 4 + 2]) / 3) / 3;
            let c = (vel / water.maxMagnitude) * max;
            if (c < -max) c = -max;
            if (c > max) c = max;
            if (this.vertexShade[v] !== (c | 0)) {
                this.vertexShade[v] = c | 0;
                this.touchVertex(v);
            }
        }
    }
}

export const AF_SHOOTABLE = 1 << 6;
