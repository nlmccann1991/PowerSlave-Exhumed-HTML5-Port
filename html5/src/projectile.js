// Projectiles and the map-placed projectile spawners.
// Port of kexProjectile/kexProjectileFlame/kexFireballSpawner/kexFireballFactory.

import { Actor, GameObject } from './actor.js';
import { AF } from './actorflags.js';
import { Vec3, clamp, clampAngle } from './math.js';
import { FF, SF } from './mapfile.js';
import { dict } from './defs.js';
import { rand } from './random.js';

export const PJF = {
    HOMING: 1 << 0, IMPACTWALLSONLY: 1 << 1, AIMONSPAWN: 1 << 2, AIMING: 1 << 3, IMPACTED: 1 << 4,
    NOHOMINGTHRUST: 1 << 5, STUNTARGET: 1 << 6, NOCLIPINITIALSECTOR: 1 << 7,
};

function toAxis(yaw, pitch) {
    const cp = Math.cos(pitch);
    return new Vec3(Math.sin(yaw) * cp, Math.cos(yaw) * cp, -Math.sin(pitch));
}

export class Projectile extends Actor {
    constructor(game) {
        super(game);
        this.damage = 0;
        this.initialSector = -1;
        this.projectileFlags = 0;
        this.homingTurnAngles = 0.03125;
        this.homingMaxPitch = 0.125;
        this.homingMaxSightDistance = 2000;
        this.homingActor = null;
        this.light = null;
    }

    get isProjectile() { return true; }

    spawn() {
        super.spawn();
        const d = this.def;
        if (d) {
            this.damage = dict.int(d, 'damage', 0);
            this.homingTurnAngles = dict.float(d, 'homingTurnAngles', 0.03125);
            this.homingMaxPitch = dict.float(d, 'homingMaxPitch', 0.25);
            this.homingMaxSightDistance = dict.float(d, 'homingMaxSightDistance', 2000);
            if (dict.bool(d, 'impactWallsOnly')) this.projectileFlags |= PJF.IMPACTWALLSONLY;
            if (dict.bool(d, 'homing')) this.projectileFlags |= PJF.HOMING;
            if (dict.bool(d, 'aimOnSpawn')) this.projectileFlags |= PJF.AIMONSPAWN;
            if (dict.bool(d, 'noHomingThrust')) this.projectileFlags |= PJF.NOHOMINGTHRUST;
            if (dict.bool(d, 'stunTarget')) this.projectileFlags |= PJF.STUNTARGET;
            if (dict.bool(d, 'spawnLight')) {
                const c = dict.vec(d, 'lightColor') || [1, 1, 1];
                const k = dict.float(d, 'lightIntensity', 1);
                this.light = this.game.spawnDynamicLight(this, dict.float(d, 'lightRadius', 256),
                    [c[0] * k, c[1] * k, c[2] * k], -1, dict.int(d, 'lightPasses', 0));
            }
        }
        if (this.projectileFlags & PJF.AIMONSPAWN) this.projectileFlags |= PJF.AIMING;
    }

    tick() {
        super.tick();
        if (this.removing) return;
        if (this.projectileFlags & PJF.HOMING) this.homingThink();
        else if (this.projectileFlags & PJF.AIMONSPAWN) this.aimThink();
    }

    onCollide() { return false; }

    homingValid(a) {
        return a && !a.removing && a.health > 0 && !(a.flags & AF.HIDDEN) && (a.flags & AF.SHOOTABLE);
    }

    homingThink() {
        const h = this.homingActor;
        if (h) {
            if (!this.homingValid(h)) { this.homingActor = null; return; }
            const v = new Vec3(h.origin.x, h.origin.y, h.origin.z + h.height * 0.5);
            const dir = v.sub(this.origin).normalize();
            const an1 = dir.toYaw();
            const diff = clampAngle(an1 - this.yaw);
            if (diff > this.homingTurnAngles) this.yaw = this.yaw + this.homingTurnAngles;
            else if (diff < -this.homingTurnAngles) this.yaw = this.yaw - this.homingTurnAngles;
            else this.yaw = an1;
            this.pitch = clamp(-dir.toPitch(), -this.homingMaxPitch, this.homingMaxPitch);
            if (!(this.projectileFlags & PJF.NOHOMINGTHRUST)) {
                const speed = this.velocity.length();
                this.velocity.copy(toAxis(this.yaw, this.pitch).scale(speed));
            }
        } else if (!this.randomDecision(14)) {
            this.seekTargets();
        }
    }

    aimThink() {
        const g = this.game;
        if (this.projectileFlags & PJF.AIMING) {
            const start = new Vec3(this.origin.x, this.origin.y, this.origin.z + this.height * 0.5);
            let best = null, maxDist = Infinity;
            this.projectileFlags &= ~PJF.AIMING;
            for (const s of g.world.floodFill(start, this.sector, 1024)) {
                for (const a of s.actors) {
                    if (a === this || a === this.target || a.health <= 0 || !(a.flags & AF.SHOOTABLE)) continue;
                    const end = new Vec3(a.origin.x, a.origin.y, a.origin.z + a.height * 0.5);
                    const dist = start.distanceSq(end);
                    if (dist > maxDist) continue;
                    let vx = end.x - start.x, vy = end.y - start.y;
                    const l = Math.hypot(vx, vy) || 1; vx /= l; vy /= l;
                    if (Math.sin(this.yaw) * vx + Math.cos(this.yaw) * vy < 0.5) continue;
                    if (g.cmodel.trace(this, this.sector, start, end, 0, false)) continue;
                    best = a; maxDist = dist;
                }
            }
            this.homingActor = best;
        } else if (this.homingActor) {
            if (!this.homingValid(this.homingActor)) { this.homingActor = null; return; }
            const h = this.homingActor;
            const start = new Vec3(this.origin.x, this.origin.y, this.origin.z + this.height * 0.5);
            const end = new Vec3(h.origin.x, h.origin.y, h.origin.z + h.height * 0.5);
            const dir = end.sub(start).normalize();
            this.yaw = dir.toYaw();
            this.pitch = -dir.toPitch();
        } else if (this.target) {
            this.yaw = this.target.yaw;
            this.pitch = this.target.pitch;
        }
    }

    adjustAlongFace(face) {
        if (face.flags & FF.WATER) return;
        if (Math.abs(face.plane[2]) <= 0.5) { this.onImpact(null); return; }
        const len = this.velocity.length();
        const forward = toAxis(this.yaw, 0);
        let pitch = Math.acos(clamp(face.plane[2], -1, 1));
        if (face.plane[2] < 0) pitch += Math.PI;
        const facing = -Math.sin(this.yaw) * face.plane[0] + -Math.cos(this.yaw) * face.plane[1] < 0;
        if (!facing) pitch = -pitch;
        this.pitch = pitch;
        this.velocity.copy(forward.scale(len));
    }

    checkSeekTarget(start, actor) {
        if (!actor) return false;
        if (Math.abs(this.origin.x - actor.origin.x) >= this.homingMaxSightDistance) return false;
        if (Math.abs(this.origin.y - actor.origin.y) >= this.homingMaxSightDistance) return false;
        const end = new Vec3(actor.origin.x, actor.origin.y, actor.origin.z + actor.height * 0.5);
        if (this.game.cmodel.trace(this, this.sector, start, end, 0, false)) return false;
        this.homingActor = actor;
        return true;
    }

    seekTargets() {
        const start = new Vec3(this.origin.x, this.origin.y, this.origin.z + this.height * 0.5);
        if (this.target && this.target.isAI) {
            this.checkSeekTarget(start, this.target.target);
            return;
        }
        for (const s of this.game.world.floodFill(start, this.sector, this.homingMaxSightDistance)) {
            for (const a of s.actors) {
                if (a === this || a === this.target || a.health <= 0 || !(a.flags & AF.SHOOTABLE) || !a.isAI) continue;
                if (!this.checkSeekTarget(start, a)) continue;
                if ((rand.int() & 7) === 3) return;
            }
        }
    }

    updateVelocity() {
        if (this.origin.z > this.floorHeight || this.gravity < 0) this.velocity.z -= this.gravity;
    }

    bumpedCeiling() {
        const s = this.sector;
        if (s.ceilingFace.flags & FF.SOLID) {
            const p = this.origin.add(this.velocity);
            const cp = new Vec3(p.x, p.y, p.z + this.height);
            if (this.game.cmodel.planeDist(s.ceilingFace, cp) <= 0 || cp.z >= this.ceilingHeight) return true;
        }
        return false;
    }

    bumpedFloor() {
        const s = this.sector;
        if (s.floorFace.flags & FF.SOLID) {
            const p = this.origin.add(this.velocity);
            if (this.game.cmodel.planeDist(s.floorFace, p) <= 0 || p.z <= this.floorHeight) return true;
        }
        return false;
    }

    reflect(face) {
        const n = this.game.cmodel.normal(face);
        const d = this.velocity.dot(n) * 2;
        this.velocity.subSelf(n.scale(d));
    }

    checkFloorAndCeilings() {
        const s = this.sector;
        if (this.bumpedCeiling()) {
            if (this.flags & AF.BOUNCY) this.reflect(s.ceilingFace);
            else if (this.projectileFlags & PJF.IMPACTWALLSONLY) this.adjustAlongFace(s.ceilingFace);
            else this.onImpact(null);
            return;
        }
        if (this.bumpedFloor()) {
            if (this.flags & AF.BOUNCY) {
                if ((this.flags & AF.EXPIRES) && --this.health === 0) { this.onImpact(null); return; }
                this.reflect(s.floorFace);
                if (this.bounceSounds.length) {
                    const snd = this.bounceSounds[this.game.ticks % 3];
                    if (snd && Math.abs(this.velocity.z) > 2) this.playSound(snd);
                }
            } else if (this.projectileFlags & PJF.IMPACTWALLSONLY) this.adjustAlongFace(s.floorFace);
            else this.onImpact(null);
            return;
        }
        super.checkFloorAndCeilings();
    }

    updateMovement() {
        const cm = this.game.cmodel;
        cm.fraction = 1;
        super.updateMovement();
        if (this.removing || (this.projectileFlags & PJF.IMPACTED)) return;
        if (cm.fraction !== 1) {
            const face = cm.contactFace;
            if ((this.flags & AF.BOUNCY) && face) { this.reflect(face); return; }
            if (this.initialSector >= 0) {
                if (face && this.velocity.dot(cm.normal(face)) >= 0) return;
                this.projectileFlags &= ~PJF.NOCLIPINITIALSECTOR;
            }
            this.onImpact(cm.contactActor);
            return;
        }
        for (const a of this.sector.actors) {
            if (a === this || a === this.target || !(a.flags & AF.SOLID)) continue;
            const r = a.radius + 1.024;
            const dz = this.origin.z - a.origin.z;
            if (dz < -this.height || dz > a.height) continue;
            const dx = this.origin.x - a.origin.x, dy = this.origin.y - a.origin.y;
            if (dx * dx + dy * dy <= r * r) { this.onImpact(a); return; }
        }
        if ((this.flags & AF.EXPIRES) && !(this.flags & AF.BOUNCY)) {
            if (--this.health === 0) { this.onImpact(null); return; }
        }
        if (this.velocity.lengthSq() <= 0.05 || this.origin.sub(this.prevOrigin).lengthSq() <= 0.05) {
            this.projectileFlags &= ~PJF.NOCLIPINITIALSECTOR;
            this.onImpact(null);
            return;
        }
        if (this.initialSector >= 0 && (this.projectileFlags & PJF.NOCLIPINITIALSECTOR) && this.sectorIndex() !== this.initialSector) {
            this.projectileFlags &= ~PJF.NOCLIPINITIALSECTOR;
        }
        if (!cm.pointWithinSectorEdges(this.origin, this.sector)) this.onImpact(null);
    }

    onImpact(contact) {
        if (this.projectileFlags & PJF.IMPACTED) return;
        if (!contact && (this.projectileFlags & PJF.NOCLIPINITIALSECTOR)) return;
        if (contact && this.damage > 0) contact.inflictDamage(this, this.damage);
        if ((this.flags & AF.INWATER) && this.deathWaterAnim) this.changeAnim(this.deathWaterAnim);
        else if (this.deathAnim) this.changeAnim(this.deathAnim);
        else this.remove();
        this.homingActor = null;
        this.flags &= ~(AF.MOVEABLE | AF.SOLID);
        this.projectileFlags |= PJF.IMPACTED;
    }

    onRemove() {
        if (this.light) this.light.remove();
        super.onRemove();
    }
}

export class ProjectileFlame extends Projectile {
    constructor(game) { super(game); this.fizzleTime = 0; this.lifeTime = 50; }
    get isProjectileFlame() { return true; }
    spawn() {
        super.spawn();
        this.lifeTime = dict.int(this.def, 'lifeTime', 50);
        this.fizzleTime = 0;
    }
    tick() {
        if (this.removing) return;
        if (this.flags & AF.INWATER) { this.remove(); return; }
        super.tick();
        if (this.anim === this.deathAnim) return;
        const lt = this.lifeTime;
        this.fizzleTime += 0.5;
        this.scale += ((5000 - ((this.fizzleTime * 65536) / 512)) / 128) / 512;
        const t = 1 / (lt * 0.5);
        const goal = this.fizzleTime < lt * 0.5 ? [1, 1, 0.25] : [1, 0.25, 0.0625];
        this.color.set(this.color.x + (goal[0] - this.color.x) * t, this.color.y + (goal[1] - this.color.y) * t, this.color.z + (goal[2] - this.color.z) * t);
        if (this.fizzleTime >= lt) this.remove();
    }
    onImpact(contact) {
        if (contact && contact.isAI) contact.igniteFrom(this);
        super.onImpact(contact);
    }
}

// Map-placed spawner that fires a projectile out of a wall tile.
export class FireballSpawner extends Actor {
    constructor(game) { super(game); this.fireDelay = 50; this.enabled = false; }
    spawn() { super.spawn(); this.flags |= AF.HIDDEN; }
    tick() {
        if (this.removing) return;
        if (!this.mapActor) { this.remove(); return; }
        super.tick();
        if (!this.enabled) return;
        this.fireDelay -= 0.5;
        if (this.fireDelay <= 0) {
            this.enabled = false;
            const face = this.game.world.faces[this.mapActor.params2];
            if (face) this.spawnFireball(face);
        }
    }
    // Exhumed places one spawner per wall tile; fire from its position along the face normal.
    spawnFireball(face) {
        const g = this.game;
        const secID = this.sectorIndex();
        const n = g.cmodel.normal(face);
        const o = this.origin.sub(n.scale(g.cmodel.pointOnFaceSide(this.origin, face)));
        o.addSelf(n.scale(32));
        let projType, speed;
        switch (this.type) {
        case 25: g.spawnActor(200, o.x, o.y, o.z, 0, secID); projType = 26; speed = 12; break;
        case 126: projType = 201; speed = 16; break;
        case 128: projType = 28; speed = 12; break;
        default: return;
        }
        const proj = g.spawnActor(projType, o.x, o.y, o.z, n.toYaw(), secID);
        if (!proj) return;
        proj.target = this;
        proj.velocity.copy(n.scale(speed));
        proj.playSound(this.type === 126 ? 'sounds/shockold.wav' : 'sounds/fballshoot.wav');
        if (proj.projectileFlags !== undefined) {
            proj.projectileFlags |= PJF.NOCLIPINITIALSECTOR;
            proj.initialSector = secID;
        }
    }
    onActivate() { this.enabled = true; }
    onDeactivate() { this.enabled = false; }
}

// Periodically re-arms all spawners of one type in a sector.
export class FireballFactory extends GameObject {
    constructor(game) {
        super(game);
        this.intervals = 60;
        this.currentTime = 0;
        this.fireballType = -1;
        this.extraDelay = 0;
        this.sector = null;
    }
    setSector(s) {
        this.sector = s;
        s.flags |= SF.SPECIAL;
        s.objectThinker = this;
    }
    spawn() {
        this.intervals = this.fireballType === 126 ? 10 : 60;
        this.currentTime = this.intervals;
    }
    remove() {
        if (this.sector) {
            for (const a of this.sector.actors) {
                if (a.mapActor && a.mapActor.type === this.fireballType) a.onDeactivate(null);
            }
            this.sector.flags &= ~SF.SPECIAL;
            this.sector.objectThinker = null;
        }
        super.remove();
    }
    tick() {
        if (this.removing) return;
        let fireDelay = this.extraDelay;
        if (!this.sector) { this.remove(); return; }
        this.currentTime += 0.5;
        if (this.currentTime >= this.intervals) {
            this.currentTime = 0;
            for (const a of this.sector.actors) {
                if (!a.mapActor || a.mapActor.type !== this.fireballType) continue;
                a.onActivate(null);
                if (a instanceof FireballSpawner) {
                    if (fireDelay > this.intervals) fireDelay -= this.intervals;
                    a.fireDelay = fireDelay;
                    fireDelay += 8;
                }
            }
        }
    }
}

// Special_LaserBeamSpawner (kexSlaveLaserBeam). Recovered from the shipped binary:
// a continuous ray cast from the spawner along its wall's normal until it reaches
// solid geometry. params1 holds the state: 0 always on, -1 on (a trigger turns it
// off for a while), -3 starts off (a trigger turns it on), -4 on (a trigger turns
// it off for good). params2 is the face the beam fires out of.
export class LaserBeam extends Actor {
    spawn() {
        super.spawn();
        this.flags |= AF.HIDDEN;
        const p = this.mapActor ? this.mapActor.params1 : 0;
        this.mode = p;
        this.on = p !== -3;
        this.offTime = 0;
        this.beamStart = null;
        this.beamEnd = null;
    }

    tick() {
        if (this.removing) return;
        if (!this.mapActor) { this.remove(); return; }
        this.gameTicks++;
        if (this.offTime > 0 && --this.offTime <= 0) {
            this.on = true;
            this.playSound('sounds/shockold.wav');
        }
        if (!this.on) { this.beamStart = this.beamEnd = null; return; }
        const g = this.game, cm = g.cmodel;
        const face = g.world.faces[this.mapActor.params2];
        if (!face) return;
        const n = cm.normal(face);
        // start just in front of the emitting wall
        const start = this.origin.sub(n.scale(cm.pointOnFaceSide(this.origin, face) - 2));
        const end = start.add(n.scale(10000));
        let sector = this.sector;
        if (!cm.pointWithinSectorEdges(start, sector)) sector = g.world.sectors[face.sectorOwner] || sector;
        cm.trace(this, sector, start, end, 0, true);
        this.beamStart = start;
        this.beamEnd = cm.interceptVector.clone();
        const hit = cm.contactActor;
        if (hit && (hit.flags & AF.SHOOTABLE) && hit.health > 0) hit.inflictDamage(this, 9999);
    }

    onActivate() {
        switch (this.mode) {
        case 0: break;
        case -1: this.on = false; this.offTime = 300; break;
        case -3: this.on = true; break;
        case -4: this.on = false; break;
        default: this.on = !this.on; break;
        }
    }
}
