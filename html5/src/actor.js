// Base game object and actor. Port of kexGameObject/kexActor with the
// accessor names the Exhumed scripts use (kexSlaveActor).

import { Vec3, clampAngle } from './math.js';
import { AF } from './actorflags.js';
import { FF, SF } from './mapfile.js';
import { dict } from './defs.js';
import { rand } from './random.js';

const AMOVE_MIN = 0.125;
let nextObjectID = 1;

export class GameObject {
    constructor(game) {
        this.game = game;
        this.id = nextObjectID++;
        this.removing = false;
        this.origin = new Vec3();
        this.rotation = { x: 0, y: 0, z: 0 };   // pitch, roll, yaw
        this.target = null;
    }
    get yaw() { return this.rotation.z; }
    set yaw(v) { this.rotation.z = clampAngle(v); }
    get pitch() { return this.rotation.x; }
    set pitch(v) { this.rotation.x = v; }
    get roll() { return this.rotation.y; }
    set roll(v) { this.rotation.y = v; }
    tick() {}
    remove() { this.removing = true; }
    // the original lets one-shot sounds finish after the object is gone (death cries are
    // played on the same frame as A_Destroy); only loops are cut
    onRemove() { this.game.sound.stopLooping(this); }
    playSound(snd) { if (snd) this.game.sound.play(snd, this); }
    playLoopingSound(snd) { if (snd) this.game.sound.playLooping(snd, this); }
    stopSound() { this.game.sound.stopObject(this); }
    stopLoopingSounds() { this.game.sound.stopLooping(this); }
}

export class Actor extends GameObject {
    constructor(game) {
        super(game);
        this.type = -1;
        this.health = 100;
        this.radius = 16;
        this.height = 32;
        this.scale = 1;
        this.stepHeight = 16;
        this.fallHeight = 512;
        this.flags = 0;
        this.anim = null;
        this.spawnAnim = null;
        this.deathAnim = null;
        this.deathWaterAnim = null;
        this.frameID = 0;
        this.ticks = 0;
        this.gameTicks = 0;
        this.animSpeed = 0.5;
        this.flashTicks = 0;
        this.friction = 0.5;
        this.gravity = 0.75;
        this.floorOffset = 0;
        this.floorHeight = 0;
        this.ceilingHeight = 0;
        this.taggedActor = null;
        this.sourceOwner = null;
        this.transparency = 255;
        this.color = new Vec3(1, 1, 1);
        this.mapActor = null;
        this.def = null;
        this.sector = null;
        this.velocity = new Vec3();
        this.movement = new Vec3();
        this.prevOrigin = new Vec3();
        this.collidedWallAngle = 0;
        this.collidedWallNormal = new Vec3();
        this.bounceSounds = [];
        this.expireAmount = 0;
        this.floatBob = false;
        this.floatBobDivisor = 1;
        this.shadowAnim = null;
        for (let i = 0; i < 10; ++i) this['m_fScratchParam' + i] = 0;
    }

    get isActor() { return true; }
    get isPuppet() { return false; }
    get isAI() { return false; }
    get isProjectile() { return false; }
    get isProjectileFlame() { return false; }
    get isPickup() { return false; }
    get isTravelObject() { return false; }
    get isDead() { return this.health <= 0; }

    // ----------------------------------------------------------------- spawn

    spawn() {
        const d = this.def;
        const g = this.game;
        this.gameTicks = 0;
        if (d) {
            this.scale = dict.float(d, 'scale', 1);
            this.radius = dict.float(d, 'radius', 16);
            this.height = dict.float(d, 'height', 32);
            this.stepHeight = dict.float(d, 'stepHeight', 16);
            this.fallHeight = dict.float(d, 'fallHeight', 512);
            this.animSpeed = dict.float(d, 'animSpeed', 0.5);
            this.friction = dict.float(d, 'friction', 0.5);
            this.gravity = dict.float(d, 'gravity', 0.75);
            this.floorOffset = dict.float(d, 'floorOffset', 0);
            this.health = dict.int(d, 'health', 100);
            this.transparency = dict.int(d, 'transparency', 255);
            const clr = dict.vec(d, 'color');
            if (clr) this.color.set(clr[0], clr[1], clr[2]);
            const B = (k, f) => { if (dict.bool(d, k)) this.flags |= f; };
            B('noAdvanceFrames', AF.NOADVANCEFRAMES);
            B('randomizeFrames', AF.RANDOMIZATION);
            B('solid', AF.SOLID);
            B('shootable', AF.SHOOTABLE);
            B('fullbright', AF.FULLBRIGHT);
            B('moveable', AF.MOVEABLE);
            B('touchable', AF.TOUCHABLE);
            B('bouncy', AF.BOUNCY);
            B('noDropOff', AF.NODROPOFF);
            B('expires', AF.EXPIRES);
            B('noExitWater', AF.NOEXITWATER);
            B('noEnterWater', AF.NOENTERWATER);
            B('hidden', AF.HIDDEN);
            B('stretchy', AF.STRETCHY);
            B('verticalFriction', AF.VERTICALFRICTION);
            B('noSpriteClipFix', AF.NOSPRITECLIPFIX);
            B('noExitLava', AF.NOEXITLAVA);
            if (this.flags & AF.BOUNCY) {
                this.bounceSounds = [d.bounceSound_1, d.bounceSound_2, d.bounceSound_3];
            }
            this.allowConcuss = dict.bool(d, 'allowConcuss');
            this.floatBob = dict.bool(d, 'floatBob');
            this.floatBobDivisor = dict.float(d, 'floatBobDivisor', 1) || 1;
            if (dict.bool(d, 'shadow') && d.shadowAnim) this.shadowAnim = g.anims.get(d.shadowAnim);
            const spawnAnim = dict.str(d, 'spawnAnim');
            if (spawnAnim) {
                this.spawnAnim = g.anims.get(spawnAnim);
                this.changeAnim(this.spawnAnim);
            }
            const deathAnim = dict.str(d, 'deathAnim');
            if (deathAnim) this.deathAnim = g.anims.get(deathAnim);
            const dw = dict.str(d, 'deathWaterAnim');
            if (dw) this.deathWaterAnim = g.anims.get(dw);
            const gib = dict.str(d, 'gibAnim');
            if (gib) this.gibAnim = g.anims.get(gib);
            this.frameID = dict.int(d, 'initialFrame', 0);
            if (this.anim && this.frameID >= this.anim.frames.length) this.frameID = 0;
        }
        if (this.sector) {
            const cm = g.cmodel;
            this.floorHeight = cm.getFloorHeight(this.origin, this.sector, !(this.flags & AF.NOENTERWATER));
            this.ceilingHeight = cm.getCeilingHeight(this.origin, this.sector, true);
            if (this.sector.flags & SF.WATER) this.flags |= AF.INWATER;
            if (this.flags & AF.MOVEABLE) {
                const s = this.sector;
                for (let i = s.faceStart; i <= s.faceEnd; ++i) {
                    const face = g.world.faces[i];
                    if (!(face.flags & FF.SOLID) || face.sector >= 0) continue;
                    const dd = cm.pointOnFaceSide(this.origin, face);
                    if (dd <= this.radius && cm.actorTouchingFace(this, face)) {
                        this.origin.addSelf(cm.normal(face).scale(this.radius - dd));
                    }
                }
            }
        }
        if (!this.anim) this.anim = g.anims.defaultAnim;
        this.velocity.clear();
        if ((this.flags & AF.RANDOMIZATION) && this.anim.frames.length > 0) {
            this.frameID = rand.int() % this.anim.frames.length;
        }
    }

    // --------------------------------------------------------------- sectors

    setSector(s) {
        if (typeof s === 'number') {
            if (s < 0 || s >= this.game.world.sectors.length) return;
            s = this.game.world.sectors[s];
        }
        if (this.sector === s) {
            if (s && (s.flags & SF.WATER)) this.flags |= AF.INWATER; else this.flags &= ~AF.INWATER;
            return;
        }
        if (this.sector) this.sector.actors.delete(this);
        this.sector = s;
        if (s) {
            s.actors.add(this);
            if (s.flags & SF.WATER) this.flags |= AF.INWATER; else this.flags &= ~AF.INWATER;
        }
    }

    unlinkSector() {
        if (this.sector) this.sector.actors.delete(this);
    }

    sectorIndex() { return this.sector ? this.sector.index : -1; }

    // Finds the sector containing pos; with stacked rooms, prefer the one whose
    // floor/ceiling bracket the point.
    findSector(pos) {
        const g = this.game, cm = g.cmodel;
        let first = null, best = null;
        for (const sector of g.world.sectors) {
            if (!cm.pointWithinSectorEdges(pos, sector)) continue;
            if (!first) first = sector;
            const f = cm.getFloorHeight(pos, sector), c = cm.getCeilingHeight(pos, sector);
            if (pos.z >= f - 1 && pos.z <= c + 1) { best = sector; break; }
        }
        const sector = best || first;
        if (!sector) return false;
        this.setSector(sector);
        this.floorHeight = cm.getFloorHeight(this.origin, sector);
        this.ceilingHeight = cm.getCeilingHeight(this.origin, sector);
        return true;
    }

    // ------------------------------------------------------------- animation

    changeAnim(a) {
        if (typeof a === 'string') {
            const found = this.game.anims.get(a);
            if (!found) { console.warn('ChangeAnim: missing', a); return; }
            a = found;
        }
        if (!a) return;
        this.anim = a;
        this.frameID = 0;
        this.ticks = 0;
        this.game.actions.runFrame(a.frames[0], this);
    }

    get frame() { return this.anim ? this.anim.frames[this.frameID] : null; }

    updateSprite() {
        if (this.removing || !this.anim) return;
        const frame = this.anim.frames[this.frameID];
        if (!frame || frame.delay === 0xffff) return;
        this.ticks += (1.0 / frame.delay) * this.animSpeed;
        if (frame.delay === 0) this.gameTicks++;
        if (this.ticks >= 1) {
            this.ticks = 0;
            if (frame.nextFrame) this.changeAnim(frame.nextFrame);
            if (!(this.flags & AF.NOADVANCEFRAMES)) {
                if (++this.frameID >= this.anim.frames.length) this.frameID = 0;
            }
            this.game.actions.runFrame(this.anim.frames[this.frameID], this);
        }
    }

    // ------------------------------------------------------------------ tick

    tick() {
        if (this.removing) return;
        this.updateSprite();
        if (this.removing) return;
        if (this.flags & AF.MOVEABLE) this.updateMovement();
        if (this.flags & AF.FLASH) {
            if (this.flashTicks-- <= 0) { this.flashTicks = 0; this.flags &= ~AF.FLASH; }
        }
        this.gameTicks++;
    }

    remove() {
        if (this.removing) return;
        this.animSpeed = 0;
        this.flags &= ~(AF.SOLID | AF.SHOOTABLE | AF.MOVEABLE | AF.TOUCHABLE | AF.BOUNCY);
        this.flags |= AF.NOADVANCEFRAMES | AF.HIDDEN;
        super.remove();
    }

    onRemove() {
        this.unlinkSector();
        this.taggedActor = null;
        super.onRemove();
    }

    onTouch(_instigator) {}
    onDamage(_instigator) {}
    onDeath(_instigator) {}
    onActivate(_instigator) {}
    onDeactivate(_instigator) {}
    onCollide(_cm) { return true; }

    inflictDamage(inflictor, amount) {
        if (!(this.flags & AF.SHOOTABLE)) return;
        this.flags |= AF.FLASH;
        this.flashTicks = 1;
        if (this.anim && (this.anim === this.deathAnim || this.anim === this.deathWaterAnim)) return;
        if (this.health > 0) {
            const old = this.health;
            this.health -= amount;
            this.onDamage(inflictor);
            if (this.health <= 0 && old > 0 && this.anim !== this.deathAnim && this.anim !== this.deathWaterAnim) {
                if (!this.isPuppet) this.flags &= ~AF.SHOOTABLE;
                // explosives and big hits use the gib animation when one exists
                if (this.gibAnim && this.health <= -40) this.changeAnim(this.gibAnim);
                else if ((this.flags & AF.INWATER) && this.deathWaterAnim) this.changeAnim(this.deathWaterAnim);
                else this.changeAnim(this.deathAnim);
                this.onDeath(inflictor);
            }
        }
    }

    randomDecision(rnd) {
        return (rand.int() & rnd) !== (this.gameTicks & rnd);
    }

    canSee(point, maxDistance) {
        const org = new Vec3(this.origin.x, this.origin.y, this.origin.z + this.height * 0.5 + this.stepHeight);
        if (org.distanceSq(point) > maxDistance * maxDistance) return false;
        return !this.game.cmodel.trace(this, this.sector, org, point, 0, false);
    }

    spawnActorFrom(name, x, y, z) {
        return this.game.spawnFromActor(name, x, y, z, this, this.yaw);
    }

    // -------------------------------------------------------------- movement

    updateVelocity() {
        if (this.flags & AF.VERTICALFRICTION) this.velocity.z *= this.friction;
        if (this.origin.z > this.floorHeight || this.gravity < 0) {
            this.velocity.z -= this.gravity;
        } else if (!(this.flags & AF.DISABLEFRICTION)) {
            this.velocity.x *= this.friction;
            this.velocity.y *= this.friction;
        }
        if (Math.abs(this.velocity.x) < AMOVE_MIN) this.velocity.x = 0;
        if (Math.abs(this.velocity.y) < AMOVE_MIN) this.velocity.y = 0;
    }

    checkFloorAndCeilings() {
        const floorz = this.floorHeight + this.floorOffset;
        if (this.origin.z + this.height + this.velocity.z >= this.ceilingHeight) {
            if (this.type === 125) { this.remove(); return; }  // water bubble
            if (this.gravity !== 0) this.velocity.z = -this.velocity.z;
        }
        if (this.origin.z + this.velocity.z <= floorz) {
            this.origin.z = floorz;
            if ((this.flags & AF.BOUNCY) && Math.abs(Math.floor(this.velocity.z)) > this.gravity * 4) {
                const r = this.game.ticks % 3;
                this.velocity.z = (floorz - (this.origin.z + this.velocity.z)) * (1.2 - this.gravity);
                this.velocity.x *= this.friction;
                this.velocity.y *= this.friction;
                if (this.bounceSounds[r]) this.playSound(this.bounceSounds[r]);
            } else if (this.gravity !== 0) {
                this.velocity.z = 0;
            }
        }
    }

    updateMovement() {
        const g = this.game;
        this.updateVelocity();
        this.checkFloorAndCeilings();
        if (this.removing) return;
        const oldSector = this.sector;
        this.movement.copy(this.velocity);
        let noSplash = false;
        if (this.sector.floorFace.flags & FF.WATER) {
            if (g.cmodel.planeDist(this.sector.floorFace, this.origin) < 0) noSplash = true;
        }
        if (this.movement.lengthSq() > 0) {
            if (!g.cmodel.move(this)) { this.velocity.clear(); this.movement.clear(); }
            else this.velocity.copy(this.movement);
            if (this.type === 125 && (oldSector.flags & SF.WATER) && !(this.sector.flags & SF.WATER)) {
                this.remove();
                return;
            }
            if (!(oldSector.flags & SF.WATER) && (this.sector.flags & SF.WATER)) {
                if (!noSplash) {
                    const splashZ = g.cmodel.getCeilingHeight(this.origin, this.sector);
                    this.playSound('sounds/splash01.wav');
                    g.spawnActor(124, this.origin.x, this.origin.y, splashZ, 0, this.sectorIndex());
                }
                this.flags |= AF.INWATER;
            } else if (!(this.sector.flags & SF.WATER)) {
                this.flags &= ~AF.INWATER;
            }
        } else if (this.flags & AF.EXPIRES) {
            if (--this.health <= 0) {
                if (this.health === 0) this.expireAmount = this.scale / 32;
                this.scale -= this.expireAmount;
                if (this.scale <= 0) this.remove();
            }
        }
    }

    // ------------------------------------------------- script API (kexSlaveActor)

    GetOrigin() { return this.origin; }
    GetVelocity() { return this.velocity; }
    GetRotation() { return this.rotation; }
    GetTarget() { return this.target && this.target.isActor ? this.target : null; }
    SetTarget(t) { this.target = t || null; }
    GetSector() { return this.sectorIndex(); }
    LinkSector(i) { this.setSector(i); }
    ChangeAnim(n) { this.changeAnim(n); }
    PlaySound(s) { this.playSound(s); }
    GetFlags() { return this.flags; }
    GetHealth() { return this.health; }
    Remove() { this.remove(); }
    GetScale() { return this.scale; }
    GetHeight() { return this.height; }
    GetRadius() { return this.radius; }
    GetStepHeight() { return this.stepHeight; }
    GetGameTicks() { return this.gameTicks; }
    GetFloorHeight() { return this.floorHeight; }
    GetCeilingHeight() { return this.ceilingHeight; }
    GetType() { return this.type; }
    GetColor() { return this.color; }
    GetTransparency() { return this.transparency; }
    GetFrameID() { return this.frameID; }
    SetFrameID(f) { this.frameID = Math.max(0, Math.min(f, (this.anim?.frames.length || 1) - 1)); }
    GetTaggedActor() { return this.taggedActor; }
    SetTaggedActor(a) { this.taggedActor = a || null; }
    GetSourceOwner() { return this.sourceOwner; }
    SetSourceOwner(a) { this.sourceOwner = a || null; }
    GetCollidedWallAngle() { return this.collidedWallAngle; }
    CastToActor() { return this; }
    GetCollidableRadius(r) { return this.radius * 0.5 + r; }
    CanSeeLocation(v, dist) { return this.canSee(v, dist); }
    IsFacing(yaw) {
        return Math.abs(clampAngle(this.yaw - yaw)) <= Math.PI / 2;
    }
    InflictDamage(src, _type, amount) { this.inflictDamage(src, amount); }
    FireActor(name, x, y, z) {
        if (typeof x === 'object') { z = x.z; y = x.y; x = x.x; }
        const a = this.game.spawnFromActor(name, x, y, z, this, this.yaw);
        if (a) a.pitch = this.pitch;
        return a;
    }
    RandomDecision(r) { return this.randomDecision(r); }
    MarkCheckpoint() { this.game.markActorUsed(this); }
}
