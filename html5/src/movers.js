// Sector movers: doors, floors, lifts, drop pads, floating platforms and
// script-driven movers. Port of game/mover.cpp.

import { GameObject } from './actor.js';
import { AF } from './actorflags.js';
import { SF } from './mapfile.js';
import { deg2rad } from './math.js';
import { rand } from './random.js';

class Mover extends GameObject {
    constructor(game) { super(game); this.type = -1; this.sector = null; }
    get world() { return this.game.world; }
    remove() { if (this.sector) this.sector.flags &= ~SF.SPECIAL; super.remove(); }
    setSector(s) { this.sector = s; }
    faceCenter(face) {
        const w = this.world;
        const o = w.vec(face.vertexStart).add(w.vec(face.vertexStart + 1)).add(w.vec(face.vertexStart + 2)).add(w.vec(face.vertexStart + 3));
        this.origin.copy(o.scale(0.25));
    }
    updateFloorOrigin() { this.faceCenter(this.sector.floorFace); }
    updateCeilingOrigin() { this.faceCenter(this.sector.ceilingFace); }
    playerInside() {
        for (const a of this.sector.actors) if (a.isPuppet) return true;
        return false;
    }
    checkActorHeight(h) {
        for (const a of this.sector.actors) {
            if (!(a.flags & AF.SOLID)) continue;
            if (a.height > h) return false;
        }
        return true;
    }
}

const DS = { IDLE: 0, UP: 1, DOWN: 2, WAIT: 3 };

export class Door extends Mover {
    spawn() {
        const s = this.sector;
        this.waitDelay = 90; this.lip = 0; this.moveSpeed = 4; this.bDirection = true;
        switch (this.type) {
        case 1: case 3: case 4: case 5: case 6: case 2: case 7:
            if (this.type === 7) this.waitDelay = -1;
            this.destHeight = s.ceilingHeight - this.lip;
            if (this.type === 2) s.objectThinker = this;
            break;
        case 8: case 9:
            this.bDirection = false;
            this.waitDelay = -1;
            this.moveSpeed = this.type === 9 ? 1 : 4;
            this.destHeight = s.floorHeight;
            break;
        default:
            this.remove();
            return;
        }
        this.raiseHeight = this.destHeight;
        s.flags |= SF.SPECIAL;
        this.state = this.bDirection ? DS.UP : DS.DOWN;
        this.currentTime = 0;
        this.baseHeight = -s.ceilingFace.plane[3];
        this.currentHeight = this.baseHeight;
    }

    tick() {
        if (this.removing) return;
        const last = this.currentHeight;
        const w = this.world;
        switch (this.state) {
        case DS.UP:
            if (this.currentHeight >= this.destHeight) {
                this.stopLoopingSounds();
                if (this.waitDelay <= -1) { this.playSound('sounds/stonestop.wav'); this.remove(); return; }
                this.state = DS.WAIT;
                this.currentTime = this.waitDelay;
                return;
            }
            this.playLoopingSound('sounds/stonemov.wav');
            this.currentHeight = Math.min(this.destHeight, this.currentHeight + this.moveSpeed);
            break;
        case DS.DOWN:
            if (this.currentHeight <= this.destHeight) {
                if (this.type === 2) {
                    if (this.sector.event >= 0) w.resetWallSwitchFromTag(w.events[this.sector.event].tag);
                    this.sector.objectThinker = null;
                }
                this.stopLoopingSounds();
                this.playSound('sounds/stonestop.wav');
                if (this.type === 8 || this.type === 9) {
                    if (this.sector.event >= 0) w.events[this.sector.event].type = 7;
                    this.state = DS.IDLE;
                    return;
                }
                this.remove();
                return;
            }
            this.playLoopingSound('sounds/stonemov.wav');
            this.currentHeight = Math.max(this.destHeight, this.currentHeight - this.moveSpeed);
            break;
        case DS.WAIT:
            this.currentTime -= 0.5;
            if (this.currentTime <= 0) { this.state = DS.DOWN; this.destHeight = this.baseHeight; }
            return;
        default:
            return;
        }
        w.moveSector(this.sector, true, this.currentHeight - last);
        this.updateCeilingOrigin();
        if (this.bDirection && this.state === DS.DOWN && !this.checkActorHeight(this.currentHeight - this.destHeight)) {
            this.state = DS.UP;
            this.destHeight = this.raiseHeight;
        }
    }
}

const FS = { IDLE: 0, UP: 1, DOWN: 2, LOWERED: 3 };

export class Floor extends Mover {
    spawn() {
        const s = this.sector;
        this.lip = 0;
        switch (this.type) {
        case 22: this.moveSpeed = 4; this.state = FS.DOWN; break;
        case 23: this.moveSpeed = 2; this.state = FS.DOWN; s.objectThinker = this; break;
        case 25: this.moveSpeed = 4; this.state = FS.IDLE; s.objectThinker = this; break;
        default: this.remove(); return;
        }
        s.flags |= SF.SPECIAL;
        this.baseHeight = s.floorFace.plane[3];
        this.currentHeight = this.baseHeight;
        this.destHeight = s.floorHeight - this.lip;
    }

    tick() {
        if (this.removing) return;
        const last = this.currentHeight;
        switch (this.state) {
        case FS.LOWERED: return;
        case FS.DOWN:
            if (this.currentHeight <= this.destHeight) {
                if (this.type !== 23) {
                    this.stopLoopingSounds();
                    this.playSound('sounds/stonestop.wav');
                    if (this.type === 25) this.state = FS.LOWERED; else this.remove();
                } else {
                    const w = this.world;
                    this.state = FS.LOWERED;
                    if (this.sector.event >= 0) w.sendRemoteTrigger(this.sector, w.events[this.sector.event]);
                    if (this.sector.event <= -1) this.remove();
                }
                return;
            }
            if (this.type !== 23) this.playLoopingSound('sounds/platstart.wav');
            this.currentHeight = Math.max(this.destHeight, this.currentHeight - this.moveSpeed);
            break;
        case FS.UP:
            if (this.currentHeight >= this.destHeight) {
                if (this.type !== 23) { this.stopLoopingSounds(); this.playSound('sounds/stonestop.wav'); }
                if (this.type === 25) this.state = FS.IDLE;
                else { this.sector.objectThinker = null; this.remove(); }
                return;
            }
            if (this.type !== 23) this.playLoopingSound('sounds/platstart.wav');
            this.currentHeight = Math.min(this.destHeight, this.currentHeight + this.moveSpeed);
            break;
        default: return;
        }
        this.world.moveSector(this.sector, false, this.currentHeight - last);
        this.updateFloorOrigin();
    }

    trigger() {
        if (!this.sector.objectThinker) return;
        switch (this.state) {
        case FS.LOWERED: case FS.DOWN: this.destHeight = this.baseHeight; this.state = FS.UP; break;
        case FS.IDLE: case FS.UP: this.destHeight = this.sector.floorHeight - this.lip; this.state = FS.DOWN; break;
        }
    }
}

const LS = { IDLE: 0, UP: 1, DOWN: 2, WAIT: 3 };

export class Lift extends Mover {
    get immediate() { return false; }
    spawn() {
        const s = this.sector;
        this.waitDelay = 90; this.triggerDelay = 60; this.lip = 0; this.moveSpeed = 4;
        switch (this.type) {
        case 21: case 22:
            this.bDirection = false;
            this.baseHeight = s.floorFace.plane[3];
            this.destHeight = s.floorHeight - this.lip;
            break;
        case 24:
            this.bDirection = true;
            this.baseHeight = s.floorHeight;
            this.destHeight = this.world.getHighestSurroundingFloor(s);
            break;
        default: this.remove(); return;
        }
        s.flags |= SF.SPECIAL;
        this.state = this.immediate ? (this.bDirection ? LS.UP : LS.DOWN) : LS.IDLE;
        this.currentTime = 0;
        this.currentDelay = 0;
        this.currentHeight = this.baseHeight;
    }

    tick() {
        if (this.removing) return;
        const last = this.currentHeight;
        switch (this.state) {
        case LS.IDLE:
            if (this.playerInside()) {
                this.currentDelay += 0.5;
                if (this.currentDelay >= this.triggerDelay) {
                    this.state = this.bDirection ? LS.UP : LS.DOWN;
                    this.currentDelay = 0;
                }
            }
            return;
        case LS.UP:
            if (this.currentHeight >= this.destHeight) {
                this.stopLoopingSounds();
                if (!this.bDirection) { this.playSound('sounds/stonestop.wav'); this.remove(); return; }
                this.state = LS.WAIT;
                this.currentTime = this.waitDelay;
            } else this.playLoopingSound('sounds/platstart.wav');
            this.currentHeight = Math.min(this.destHeight, this.currentHeight + this.moveSpeed);
            break;
        case LS.DOWN:
            if (this.currentHeight <= this.destHeight) {
                this.stopLoopingSounds();
                if (this.bDirection) { this.playSound('sounds/stonestop.wav'); this.remove(); return; }
                this.state = LS.WAIT;
                this.currentTime = this.waitDelay;
            } else this.playLoopingSound('sounds/platstart.wav');
            this.currentHeight = Math.max(this.destHeight, this.currentHeight - this.moveSpeed);
            break;
        case LS.WAIT:
            this.currentTime -= 0.5;
            if (this.currentTime <= 0) {
                this.state = this.bDirection ? LS.DOWN : LS.UP;
                this.destHeight = this.baseHeight;
            }
            return;
        default: return;
        }
        this.world.moveSector(this.sector, false, this.currentHeight - last);
        this.updateFloorOrigin();
    }
}

export class LiftImmediate extends Lift {
    get immediate() { return true; }
}

const DPS = { IDLE: 0, COUNTDOWN: 1, FALLING: 2, DOWN: 3, RAISE: 4 };

export class DropPad extends Mover {
    spawn() {
        const w = this.world, s = this.sector;
        if (this.type !== 48) { this.remove(); return; }
        this.moveSpeed = 4;
        this.triggerDelay = 30;
        this.state = DPS.IDLE;
        this.linkedSector = w.sectors[s.linkedSector];
        w.makeSectorDynamic(this.linkedSector, true);
        w.makeSectorDynamic(s, false);
        this.baseHeight = -this.linkedSector.ceilingFace.plane[3];
        this.destHeight = this.linkedSector.floorHeight;
        this.currentDelay = 0;
        this.speedAccel = 0;
        this.currentHeight = this.baseHeight;
    }

    tick() {
        if (this.removing) return;
        const last = this.currentHeight;
        const w = this.world;
        switch (this.state) {
        case DPS.COUNTDOWN:
            this.currentDelay += 0.5;
            if (this.currentDelay >= this.triggerDelay) { this.state = DPS.FALLING; this.currentDelay = 0; }
            return;
        case DPS.FALLING:
            if (this.currentHeight <= this.destHeight) {
                this.game.player.shakeTime = 16;
                this.playSound('sounds/platfall.wav');
                this.state = DPS.DOWN;
                this.sector.flags &= ~SF.SPECIAL;
                if (this.sector.event >= 0) w.resetWallSwitchFromTag(w.events[this.sector.event].tag);
                return;
            }
            this.currentHeight = Math.max(this.destHeight, this.currentHeight - (this.moveSpeed + this.speedAccel));
            this.speedAccel += 1;
            break;
        case DPS.RAISE:
            if (this.currentHeight >= this.destHeight) {
                this.state = DPS.IDLE;
                this.sector.flags &= ~SF.SPECIAL;
                return;
            }
            this.currentHeight = Math.min(this.destHeight, this.currentHeight + this.moveSpeed);
            break;
        case DPS.IDLE:
            if (this.playerInside()) this.start();
            return;
        default: return;
        }
        const amt = this.currentHeight - last;
        w.moveSector(this.linkedSector, true, amt);
        w.moveSector(this.sector, false, amt);
        this.updateFloorOrigin();
    }

    start() {
        if (this.state !== DPS.IDLE) return;
        this.baseHeight = -this.linkedSector.ceilingFace.plane[3];
        this.destHeight = this.linkedSector.floorHeight;
        this.currentDelay = 0;
        this.speedAccel = 0;
        this.currentHeight = this.baseHeight;
        this.state = DPS.COUNTDOWN;
        this.sector.flags |= SF.SPECIAL;
    }

    reset() {
        if (this.state !== DPS.DOWN) return;
        this.baseHeight = -this.linkedSector.ceilingFace.plane[3];
        this.destHeight = this.linkedSector.ceilingHeight;
        this.currentDelay = 0;
        this.speedAccel = 0;
        this.currentHeight = this.baseHeight;
        this.state = DPS.RAISE;
        this.sector.flags |= SF.SPECIAL;
    }
}

export class FloatingPlatform extends Mover {
    spawn() {
        const w = this.world, s = this.sector;
        this.linkedSector = w.sectors[s.linkedSector];
        this.moveSpeed = 2;
        this.moveHeight = 128;
        this.angOffset = 0;
        this.time = 0;
        this.currentHeight = 0;
        const evParams = s.event >= 0 ? w.events[s.event].params : 0;
        switch (this.type) {
        case 41: break;
        case 43: this.angOffset = deg2rad(60); break;
        case 44: this.angOffset = deg2rad(120); break;
        case 45: this.angOffset = Math.PI; break;
        case 46: this.angOffset = deg2rad(-60); break;
        case 47: this.angOffset = deg2rad(-120); break;
        case 60: this.moveHeight = 64; this.angOffset = deg2rad(evParams); break;
        case 65: this.angOffset = deg2rad(rand.cfloat() * 256); break;
        case 68: this.moveHeight = 512; this.angOffset = deg2rad(evParams); break;
        default: this.remove(); return;
        }
        w.makeSectorDynamic(this.linkedSector, true);
        w.makeSectorDynamic(s, false);
        this.baseHeight = -this.linkedSector.ceilingFace.plane[3];
    }

    tick() {
        if (this.removing) return;
        const w = this.world;
        const a = this.time * (this.moveSpeed * deg2rad(1));
        const amt = Math.cos(a + this.angOffset + Math.PI) * (this.moveHeight * 0.5);
        const move = amt - this.currentHeight;
        this.currentHeight = amt;
        w.moveSector(this.linkedSector, true, move);
        w.moveSector(this.sector, false, move);
        this.updateFloorOrigin();
        this.time++;
    }
}

export class ScriptedMover extends Mover {
    spawn() {
        this.moveSpeed = 2;
        this.moveHeight = 128;
        this.currentHeight = 0;
        this.bCeiling = false;
    }

    start(height, speed, ev, bCeiling) {
        this.sector.flags |= SF.SPECIAL;
        this.sector.linkedSector = ev.params;
        this.bCeiling = !!bCeiling;
        this.moveSpeed = Math.abs(speed);
        this.moveHeight = height;
    }

    tick() {
        if (this.removing) return;
        const w = this.world;
        const last = this.currentHeight;
        if ((this.moveHeight >= 0 && this.currentHeight >= this.moveHeight) ||
            (this.moveHeight < 0 && this.currentHeight <= this.moveHeight)) {
            this.remove();
            return;
        }
        if (this.moveHeight >= 0) this.currentHeight = Math.min(this.moveHeight, this.currentHeight + this.moveSpeed);
        else this.currentHeight = Math.max(this.moveHeight, this.currentHeight - this.moveSpeed);
        const move = this.currentHeight - last;
        if (this.sector.linkedSector >= 0) w.moveSector(w.sectors[this.sector.linkedSector], !this.bCeiling, move);
        w.moveSector(this.sector, this.bCeiling, move);
        this.updateFloorOrigin();
    }
}

export const MOVER_CLASSES = {
    kexDoor: Door, kexFloor: Floor, kexLift: Lift, kexLiftImmediate: LiftImmediate,
    kexDropPad: DropPad, kexFloatingPlatform: FloatingPlatform, kexScriptedMover: ScriptedMover,
};
