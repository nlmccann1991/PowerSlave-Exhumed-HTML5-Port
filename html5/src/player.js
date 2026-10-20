// Player controller, the puppet actor it drives, and the first-person weapon.
// Port of kexPlayer/kexPuppet (game/player.cpp) and kexPlayerWeapon (game/pWeapon.cpp).

import { Actor } from './actor.js';
import { AF, PF, PA, PAB, BC, WS, NUMPLAYERWEAPONS, PW } from './actorflags.js';
import { Vec3, clamp, deg2rad, clampAngle } from './math.js';
import { FF, SF } from './mapfile.js';
import { dict } from './defs.js';
import { rand } from './random.js';

// movement constants from the remaster's kexSlavePuppet (ground 0x1401d5740,
// water 0x1401d6fd0, fly 0x1401d66d0, jump 0x1401d5480, landing 0x1401d7c20)
const PMOVE_MIN = 0.125;
const PMOVE_SPEED = 1.5675;
const PMOVE_MAX_SPEED = 17.5;
const PMOVE_WATER_SPEED = 0.48828125;
const PMOVE_SPEED_JUMP = 10.25;
const PMOVE_JUMP_BOOST = 14.0;
export const MAX_HEALTH = 200;

function toAxis(yaw, pitch) {
    const cp = Math.cos(pitch);
    return new Vec3(Math.sin(yaw) * cp, Math.cos(yaw) * cp, -Math.sin(pitch));
}
function rightOf(yaw) { return new Vec3(Math.cos(yaw), -Math.sin(yaw), 0); }

export class PlayerCmd {
    constructor() { this.reset(); }
    reset() {
        this.buttons = 0;
        this.angles = [0, 0];
        this.movement = [0, 0];
    }
}

export class Puppet extends Actor {
    constructor(game) {
        super(game);
        this.owner = null;
        this.playerFlags = 0;
        this.jumpTicks = 0;
        this.oldMovement = new Vec3();
        this.lavaTicks = 0;
        this.slimeTicks = 0;
    }

    get isPuppet() { return true; }
    get isDead() { return !!(this.playerFlags & PF.DEAD); }

    spawn() {
        const g = this.game;
        this.owner = g.player;
        g.player.actor = this;
        super.spawn();
        const d = this.def;
        this.radius = dict.float(d, 'radius', 95.25);
        this.height = dict.float(d, 'height', 160);
        this.stepHeight = dict.float(d, 'stepHeight', 48);
        this.health = dict.int(d, 'health', 200);
        this.friction = dict.float(d, 'friction', 0.9375);
        this.gravity = 0.75;
        this.flags = AF.SOLID | AF.SHOOTABLE;
        if (this.sector && (this.sector.flags & SF.WATER)) this.flags |= AF.INWATER;
        this.lavaTicks = 0;
        this.slimeTicks = 0;
        this.playerFlags = PF.ABOVESURFACE;
    }

    onCollide(cm) {
        if (this.playerFlags & PF.DEAD) return true;
        const g = this.game;
        if (cm.contactFace) {
            const face = cm.contactFace;
            if (face.flags & FF.FORCEFIELD) {
                if (this.owner.artifacts & PA.SCEPTER) {
                    const kill = (f) => {
                        f.flags &= ~(FF.SOLID | FF.FORCEFIELD);
                        f.flags |= FF.INVISIBLE | FF.HIDDEN;
                        f.polyStart = f.polyEnd = -1;
                    };
                    if (face.sector >= 0) {
                        const s = g.world.sectors[face.sector];
                        for (let i = s.faceStart; i < s.faceEnd + 3; ++i) {
                            const f = g.world.faces[i];
                            if ((f.flags & FF.FORCEFIELD) && f.sector === face.sectorOwner) kill(f);
                        }
                    }
                    kill(face);
                    g.world.polysDirty = true;
                    this.playSound('sounds/forcefieldoff.wav');
                } else {
                    this.playerFlags |= PF.ELECTROCUTE;
                    this.inflictDamage(null, 50);
                }
            }
            if (face.flags & FF.LAVA) this.lavaDamage(face);
            if (face.flags & FF.SLIME) this.slimeDamage();
        } else if (cm.contactActor && cm.contactActor.isTravelObject) {
            cm.contactActor.onTouch(this);
        }
        return true;
    }

    onDamage(instigator) {
        const g = this.game;
        if (this.playerFlags & PF.DEAD) return;
        if (this.health <= 0) {
            if ((this.playerFlags & PF.GOD) || g.godMode) { this.health = 1; return; }
            g.damageFlash();
            this.playerFlags |= PF.DEAD;
            if ((this.flags & AF.INWATER) && !(this.playerFlags & PF.ABOVESURFACE)) this.playSound('sounds/pdrown.wav');
            else if (instigator) this.playSound('sounds/pdeath03.wav');
            else if (this.playerFlags & PF.ELECTROCUTE) { g.electrocuteFlash(); this.playSound('sounds/pdeath01.wav'); }
            this.owner.holdsterWeapon();
            return;
        }
        if (instigator && instigator.isProjectile && (instigator.projectileFlags & (1 << 6))) {
            g.damageFlash();
            this.playSound('sounds/pshock.wav');
            this.stun();
        }
        if (this.playerFlags & PF.ELECTROCUTE) {
            this.playerFlags &= ~PF.ELECTROCUTE;
            this.owner.lockTime = 60;
            this.owner.shakeTime = 30;
            this.velocity.clear();
            this.movement.clear();
            g.electrocuteFlash();
            this.playSound('sounds/pelectrocute.wav');
            return;
        }
        g.damageFlash();
        if (this.lavaTicks > 0 || this.slimeTicks > 0) { this.playSound('sounds/psizzle.wav'); return; }
        if ((this.flags & AF.INWATER) && !(this.playerFlags & PF.ABOVESURFACE)) {
            this.playSound(`sounds/pwpain0${rand.max(5) + 1}.wav`);
        } else {
            this.playSound(`sounds/ppain0${rand.max(3) + 1}.wav`);
        }
    }

    inflictDamage(src, amount) {
        if (this.game.godMode && amount > 0) amount = 0;
        amount = Math.round(amount * (this.game.damageScale || 1));
        super.inflictDamage(src, amount);
    }

    stun() {
        this.playerFlags |= PF.STUNNED;
        this.owner.lockTime = 60;
        this.owner.shakeTime = 30;
    }

    checkFallDamage() {
        const amt = this.velocity.z + 28.5;
        if (amt >= 0) return;
        const scale = Math.pow(this.owner.ankahs + 1, 0.75);
        this.inflictDamage(null, Math.trunc(scale * Math.trunc(Math.pow(-amt, 1.1) * 7)));
        if (this.playerFlags & PF.DEAD) this.playSound('sounds/pxdeath.wav');
    }

    slimeDamage() {
        if (Math.trunc(this.velocity.z) !== 0) { this.slimeTicks = 0; return; }
        if (this.owner.artifacts & PA.ANKLETS) {
            if ((++this.slimeTicks & 63) === 1) this.inflictDamage(null, 5);
        } else if ((++this.slimeTicks & 31) === 1) {
            this.inflictDamage(null, 375);
        }
        if (this.playerFlags & PF.DEAD) { this.playSound('sounds/psizzle.wav'); this.playSound('sounds/pdeath02.wav'); }
    }

    lavaDamage(face) {
        if (Math.trunc(this.velocity.z) !== 0 && Math.abs(face.plane[2]) > 0.5) { this.lavaTicks = 0; return; }
        if ((++this.lavaTicks & 31) === 1) {
            this.inflictDamage(null, (this.owner.artifacts & PA.ANKLETS) ? 50 : this.health);
            if (this.playerFlags & PF.DEAD) { this.playSound('sounds/psizzle.wav'); this.playSound('sounds/pdeath02.wav'); }
        }
    }

    jump(cmd) {
        const o = this.owner;
        if (cmd.buttons & BC.JUMP) {
            if (!(this.playerFlags & PF.USERJUMPED)) {
                if (!(this.playerFlags & PF.JUMPING)) {
                    if (this.ceilingHeight - this.floorHeight <= this.height + 16) return;
                    if (this.origin.z + this.velocity.z - this.floorHeight >= 1 && !(o.abilities & PAB.VULTURE)) return;
                    this.playerFlags |= PF.JUMPING | PF.JUMPWASHELD;
                    if (o.abilities & PAB.VULTURE) this.playSound('sounds/fly.wav');
                    else this.playSound(`sounds/pjump0${rand.max(5) + 1}.wav`);
                }
                if (this.velocity.z > 0 || this.jumpTicks === 0) {
                    if (o.artifacts & PA.SANDALS) this.velocity.z = PMOVE_JUMP_BOOST - 0.325 * this.jumpTicks;
                    else this.velocity.z = PMOVE_SPEED_JUMP - 0.325 * this.jumpTicks;
                    this.jumpTicks++;
                } else {
                    this.playerFlags |= PF.USERJUMPED;
                }
            }
        } else {
            this.playerFlags &= ~PF.JUMPWASHELD;
            if (o.abilities & PAB.VULTURE) {
                this.playerFlags &= ~(PF.USERJUMPED | PF.JUMPING);
                this.jumpTicks = 0;
                return;
            }
            if ((this.velocity.z >= PMOVE_MIN || this.velocity.z <= -(PMOVE_MIN * 48)) || (this.playerFlags & PF.JUMPING)) {
                this.playerFlags |= PF.USERJUMPED;
            } else if (this.playerFlags & PF.USERJUMPED) {
                this.playerFlags &= ~PF.USERJUMPED;
            }
        }
    }

    applyLook(cmd) {
        this.yaw = this.yaw + cmd.angles[0];
        this.pitch = clamp(this.pitch + cmd.angles[1], deg2rad(-90), deg2rad(90));
        this.roll = clamp(this.roll - cmd.angles[0] * 0.25, -0.1, 0.1);
    }

    groundMove(cmd) {
        const g = this.game, cm = g.cmodel, o = this.owner;
        this.applyLook(cmd);
        const forward = toAxis(this.yaw, 0), right = rightOf(this.yaw);
        this.velocity.x *= this.friction;
        this.velocity.y *= this.friction;
        this.jump(cmd);
        if (this.origin.z > this.floorHeight) {
            if (!(this.playerFlags & PF.JUMPWASHELD) && this.velocity.z <= 0 && (cmd.buttons & BC.JUMP) &&
                (o.artifacts & (PA.SHAWL | PA.FEATHER))) {
                if (o.artifacts & PA.FEATHER) { this.velocity.z = 0; this.playerFlags |= PF.FLOATING; }
                else this.velocity.z = -5;
            } else {
                this.playerFlags &= ~PF.FLOATING;
                this.velocity.z -= this.gravity;
            }
        } else {
            this.playerFlags &= ~PF.FLOATING;
            const ff = this.sector.floorFace;
            if (ff.flags & FF.LAVA) {
                if (this.origin.z - cm.getFloorHeight(this.origin, this.sector) <= 0) this.lavaDamage(ff);
            } else this.lavaTicks = 0;
            if (ff.flags & FF.SLIME) {
                if (this.origin.z - cm.getFloorHeight(this.origin, this.sector) <= 0) this.slimeDamage();
            } else this.slimeTicks = 0;
        }
        if (this.velocity.x * this.velocity.x + this.velocity.y * this.velocity.y < PMOVE_MIN * PMOVE_MIN) this.velocity.x = this.velocity.y = 0;
        if (cmd.buttons & BC.FORWARD) { this.velocity.x += forward.x * PMOVE_SPEED; this.velocity.y += forward.y * PMOVE_SPEED; }
        if (cmd.buttons & BC.BACKWARD) { this.velocity.x -= forward.x * PMOVE_SPEED; this.velocity.y -= forward.y * PMOVE_SPEED; }
        if (cmd.buttons & BC.STRAFELEFT) { this.velocity.x -= right.x * PMOVE_SPEED; this.velocity.y -= right.y * PMOVE_SPEED; }
        if (cmd.buttons & BC.STRAFERIGHT) { this.velocity.x += right.x * PMOVE_SPEED; this.velocity.y += right.y * PMOVE_SPEED; }
        this.velocity.x += (forward.x * cmd.movement[0] + right.x * cmd.movement[1]) * PMOVE_SPEED;
        this.velocity.y += (forward.y * cmd.movement[0] + right.y * cmd.movement[1]) * PMOVE_SPEED;
        const hs = Math.hypot(this.velocity.x, this.velocity.y);
        if (hs > PMOVE_MAX_SPEED) { this.velocity.x *= PMOVE_MAX_SPEED / hs; this.velocity.y *= PMOVE_MAX_SPEED / hs; }
        if (this.origin.z + this.height + this.velocity.z >= this.ceilingHeight) {
            this.origin.z = this.ceilingHeight - this.height;
            this.velocity.z = -1;
            this.playerFlags |= PF.USERJUMPED;
            this.playerFlags &= ~PF.JUMPING;
        }
        if (this.origin.z + this.velocity.z <= this.floorHeight) {
            if (this.velocity.z < -this.gravity) o.landTime = this.velocity.z;
            this.checkFallDamage();
            this.origin.z = this.floorHeight;
            this.velocity.z = 0;
            this.jumpTicks = 0;
            this.playerFlags &= ~PF.JUMPING;
        }
        const oldSector = this.sector;
        this.movement.copy(this.velocity);
        if (!cm.move(this)) { this.velocity.clear(); this.movement.clear(); }
        if (this.oldMovement.x * this.movement.x + this.oldMovement.y * this.movement.y < 0) {
            this.movement.x = this.movement.y = 0;
            this.velocity.x = this.velocity.y = 0;
        }
        this.oldMovement.copy(this.movement);
        if (oldSector === this.sector && this.velocity.z <= 0) {
            const fp = this.sector.floorFace.plane;
            const vy = this.velocity.toYaw();
            if (-Math.sin(vy) * fp[0] + -Math.cos(vy) * fp[1] < 0) {
                const diff = this.origin.z - this.floorHeight;
                if (diff > 0 && diff <= 8) this.origin.z = this.floorHeight;
            }
        }
        if (!(oldSector.flags & SF.WATER) && (this.sector.flags & SF.WATER)) {
            this.playSound('sounds/splash02.wav');
            this.flags |= AF.INWATER;
        } else if (!(this.sector.flags & SF.WATER)) {
            this.flags &= ~AF.INWATER;
        }
    }

    tryClimbOutOfWater() {
        const g = this.game, cm = g.cmodel, w = g.world;
        if (!(this.playerFlags & PF.ABOVESURFACE) || !(this.flags & AF.INWATER) ||
            !(this.sector.ceilingFace.flags & FF.WATER) || this.sector.ceilingFace.sector <= -1) return;
        const vx = Math.abs(this.velocity.x), vy = Math.abs(this.velocity.y), vz = Math.abs(this.velocity.z);
        if (vz >= vx && vz >= vy) return;
        const startSector = w.sectors[this.sector.ceilingFace.sector];
        if (!(startSector.floorFace.flags & FF.WATER)) return;
        if (startSector.floorHeight - this.floorHeight < this.height) return;
        const start = this.origin.clone();
        start.z = startSector.floorHeight + this.stepHeight;
        let forward = toAxis(this.yaw, 0);
        const end = start.add(forward.scale(this.radius * 1.05));
        for (const s0 of w.floodFill(start, startSector, this.radius * 1.05)) {
            if (s0 === this.sector) continue;
            for (let i = s0.faceStart; i <= s0.faceEnd; ++i) {
                const face = w.faces[i];
                if (face.sector <= -1) continue;
                if (cm.normal(face).dot(this.velocity) >= 0) continue;
                if (cm.planeDist(face, end) >= 0 || cm.planeDist(face, start) < 0) continue;
                const s = w.sectors[face.sector];
                if ((s.flags & SF.WATER) || (s.floorFace.flags & FF.WATER)) continue;
                if (s.floorFace.plane[2] <= 0.5) continue;
                const fHeight = cm.getFloorHeight(end, s);
                if (end.z - fHeight < 0) continue;
                if (!cm.pointWithinSectorEdges(end, s)) continue;
                this.owner.stepViewZ = this.origin.z - fHeight;
                const amount = s.floorFace.plane[2] * (4 * this.radius);
                this.movement.x += forward.x * amount * Math.abs(s.floorFace.plane[0]);
                this.movement.y += forward.y * amount * Math.abs(s.floorFace.plane[1]);
                this.origin.z = fHeight;
                forward = new Vec3(this.origin.x + this.movement.x, this.origin.y + this.movement.y, this.origin.z);
                this.floorHeight = cm.getFloorHeight(forward, s);
                this.setSector(s);
                return;
            }
        }
    }

    waterMove(cmd) {
        const g = this.game, cm = g.cmodel, o = this.owner;
        this.applyLook(cmd);
        // at the surface, looking slightly up doesn't swim you out of the water
        let movePitch = this.pitch;
        if ((this.playerFlags & PF.ABOVESURFACE) && movePitch > deg2rad(-35) && movePitch < 0) movePitch = 0;
        const forward = toAxis(this.yaw, movePitch), right = rightOf(this.yaw);
        this.velocity.scaleSelf(this.friction);
        if (this.velocity.lengthSq() < PMOVE_MIN * PMOVE_MIN) this.velocity.clear();
        // the Dolphin ability triples swim speed underwater
        const swim = ((o.abilities & PAB.DOLPHIN) && !(this.playerFlags & PF.ABOVESURFACE)) ? PMOVE_WATER_SPEED * 3 : PMOVE_WATER_SPEED;
        if (cmd.buttons & BC.FORWARD) this.velocity.addSelf(forward.scale(swim));
        if (cmd.buttons & BC.BACKWARD) this.velocity.subSelf(forward.scale(swim));
        this.velocity.addSelf(forward.scale(cmd.movement[0] * swim));
        this.velocity.x += right.x * cmd.movement[1] * swim * 0.5;
        this.velocity.y += right.y * cmd.movement[1] * swim * 0.5;
        if (cmd.buttons & BC.STRAFELEFT) { this.velocity.x -= right.x * swim * 0.5; this.velocity.y -= right.y * swim * 0.5; }
        if (cmd.buttons & BC.STRAFERIGHT) { this.velocity.x += right.x * swim * 0.5; this.velocity.y += right.y * swim * 0.5; }
        // jump swims straight up
        if (cmd.buttons & BC.JUMP) this.velocity.z += swim;
        if (this.sector.ceilingFace.flags & FF.WATER) {
            const waterZ = cm.getCeilingHeight(this.origin, this.sector);
            const view = o.viewZ + (o.stepViewZ || 0);
            if (view + 16 <= waterZ - this.origin.z) {
                this.playerFlags &= ~PF.ABOVESURFACE;
            } else {
                // bob at the surface with the eyes just above the water
                const t = this.pitch <= deg2rad(45) ? 0.075 : 0.035;
                this.origin.z = ((waterZ + 32) - view - this.origin.z) * t + this.origin.z;
                this.playerFlags |= PF.ABOVESURFACE;
            }
        }
        if (this.origin.z + this.height + this.velocity.z >= this.ceilingHeight) this.origin.z = this.ceilingHeight - this.height;
        if (this.origin.z + this.velocity.z <= this.floorHeight) this.origin.z = this.floorHeight;
        this.movement.copy(this.velocity);
        this.tryClimbOutOfWater();
        if (!cm.move(this)) { this.velocity.clear(); this.movement.clear(); }
        if (!(this.sector.flags & SF.WATER)) this.flags &= ~AF.INWATER;
    }

    flyMove(cmd) {
        const g = this.game;
        this.applyLook(cmd);
        const forward = toAxis(this.yaw, this.pitch), right = rightOf(this.yaw);
        this.velocity.scaleSelf(this.friction);
        if (Math.abs(this.velocity.x) < PMOVE_MIN) this.velocity.x = 0;
        if (Math.abs(this.velocity.y) < PMOVE_MIN) this.velocity.y = 0;
        if (Math.abs(this.velocity.z) < PMOVE_MIN) this.velocity.z = 0;
        this.velocity.addSelf(forward.scale(cmd.movement[0] * PMOVE_SPEED));
        this.velocity.x += right.x * cmd.movement[1] * PMOVE_SPEED;
        this.velocity.y += right.y * cmd.movement[1] * PMOVE_SPEED;
        if (cmd.buttons & BC.FORWARD) this.velocity.addSelf(forward.scale(PMOVE_SPEED));
        if (cmd.buttons & BC.BACKWARD) this.velocity.subSelf(forward.scale(PMOVE_SPEED));
        if (cmd.buttons & BC.STRAFELEFT) { this.velocity.x -= right.x * PMOVE_SPEED; this.velocity.y -= right.y * PMOVE_SPEED; }
        if (cmd.buttons & BC.STRAFERIGHT) { this.velocity.x += right.x * PMOVE_SPEED; this.velocity.y += right.y * PMOVE_SPEED; }
        this.movement.copy(this.velocity);
        if (!(this.playerFlags & PF.NOCLIP)) {
            if (!g.cmodel.move(this)) { this.velocity.clear(); this.movement.clear(); }
        } else {
            this.origin.addSelf(this.movement);
            this.findSector(this.origin);
        }
    }

    deadMove() {
        this.pitch = clamp(this.pitch - deg2rad(4), deg2rad(-90), deg2rad(90));
        this.roll = clamp(this.roll - deg2rad(4), deg2rad(-45), deg2rad(45));
        this.velocity.x *= this.friction;
        this.velocity.y *= this.friction;
        if (this.origin.z > this.floorHeight) this.velocity.z -= this.gravity;
        if (this.origin.z + this.velocity.z <= this.floorHeight) { this.origin.z = this.floorHeight; this.velocity.z = 0; }
        this.movement.copy(this.velocity);
        if (!this.game.cmodel.move(this)) { this.velocity.clear(); this.movement.clear(); }
    }

    tick() {
        const cmd = this.owner.cmd;
        if (this.playerFlags & PF.DEAD) { this.deadMove(); this.gameTicks++; return; }
        this.roll = (0 - this.roll) * 0.35 + this.roll;
        if (this.flags & AF.FLASH) { if (this.flashTicks-- <= 0) { this.flashTicks = 0; this.flags &= ~AF.FLASH; } }
        if (this.owner.lockTime > 0 && !((this.playerFlags & PF.STUNNED) && this.origin.z > this.floorHeight)) return;
        if (this.playerFlags & (PF.NOCLIP | PF.FLY)) this.flyMove(cmd);
        else if (this.flags & AF.INWATER) this.waterMove(cmd);
        else this.groundMove(cmd);
        this.game.world.enterSectorSpecial(this, this.sector);
        this.gameTicks++;
    }

    // script API (kexSlavePuppet)
    Stun() { this.stun(); }
}

export class PlayerWeapon {
    constructor(owner) {
        this.owner = owner;
        this.anim = null;
        this.state = WS.IDLE;
        this.frameID = 0;
        this.ticks = 0;
        this.bobX = 0;
        this.bobY = 0;
        this.bobTime = 0;
    }

    get game() { return this.owner.game; }
    get info() { return this.game.weaponInfo[this.owner.currentWeapon]; }

    changeAnim(a) {
        if (typeof a === 'string') a = this.game.anims.get(a);
        if (!a) return;
        this.anim = a;
        this.frameID = 0;
        this.ticks = 0;
        if (a === this.info.idle) this.state = WS.IDLE;
        this.game.actions.runFrame(a.frames[0], this.owner.actor);
    }

    changeState(s) {
        const info = this.info;
        switch (s) {
        case WS.IDLE: this.changeAnim(info.idle); this.state = WS.IDLE; break;
        case WS.RAISE: this.changeAnim(info.raise); this.state = WS.RAISE; break;
        case WS.LOWER: this.changeAnim(info.lower); this.state = WS.LOWER; break;
        case WS.HOLDSTER: this.changeAnim(info.lower); this.state = WS.HOLDSTER; break;
        case WS.FIRE: this.changeAnim(info.fire); this.state = WS.FIRE; break;
        default: break;
        }
    }

    update() {
        this.updateBob();
        this.updateSprite();
    }

    updateBob() {
        const actor = this.owner.actor;
        let movement = Math.hypot(actor.velocity.x, actor.velocity.y);
        if ((movement > 0 || this.owner.landTime < 0) &&
            (actor.origin.z <= actor.floorHeight || (actor.flags & AF.INWATER)) && this.state !== WS.FIRE) {
            movement = clamp(movement / 16, 0, 1);
            const speed = (actor.flags & AF.INWATER) ? 0.025 : 0.075;
            const t = this.bobTime;
            const x = Math.sin(t * speed) * (16 * movement);
            const y = Math.abs(Math.sin(t * speed) * (16 * movement)) - this.owner.landTime;
            this.bobX = (x - this.bobX) * 0.25 + this.bobX;
            this.bobY = (y - this.bobY) * 0.25 + this.bobY;
            this.bobTime++;
        } else {
            this.bobTime = 0;
            this.bobX = (0 - this.bobX) * 0.25 + this.bobX;
            this.bobY = (0 - this.bobY) * 0.25 + this.bobY;
            if (actor.velocity.z > 0.1) this.bobY += actor.velocity.z * 0.25;
        }
    }

    updateSprite() {
        const o = this.owner, g = this.game;
        const info = this.info, pending = g.weaponInfo[o.pendingWeapon];
        if (!this.anim) return;
        let underwater = false;
        if ((o.actor.flags & AF.INWATER) && !(o.actor.playerFlags & PF.ABOVESURFACE)) {
            underwater = true;
            if (info.disableUnderwater && this.state !== WS.HOLDSTER) { this.changeState(WS.HOLDSTER); return; }
        }
        const frame = this.anim.frames[this.frameID];
        this.ticks += (1.0 / frame.delay) * 0.5;
        if (frame.delay === 0) o.actor.gameTicks++;
        if (this.ticks >= 1) {
            this.ticks = 0;
            if (frame.refireFrame && (o.cmd.buttons & BC.ATTACK)) { this.changeAnim(frame.refireFrame); return; }
            else if (frame.nextFrame) { this.changeAnim(frame.nextFrame); return; }
            if (++this.frameID >= this.anim.frames.length) {
                this.frameID = 0;
                if (this.state === WS.LOWER) {
                    if (underwater && info !== pending && pending.disableUnderwater) {
                        this.frameID = this.anim.frames.length - 1;
                        return;
                    }
                    o.changeWeapon();
                    this.changeState(WS.RAISE);
                    return;
                } else if (this.state === WS.HOLDSTER) {
                    if (underwater && info !== pending && !pending.disableUnderwater) {
                        o.changeWeapon();
                        this.changeState(WS.RAISE);
                        return;
                    }
                    if (!(o.actor.playerFlags & PF.DEAD) && !underwater) this.changeState(WS.RAISE);
                    else this.frameID = this.anim.frames.length - 1;
                    return;
                }
            }
            g.actions.runFrame(this.anim.frames[this.frameID], o.actor);
        }
        switch (this.state) {
        case WS.IDLE:
            if (o.pendingWeapon !== o.currentWeapon) this.changeState(WS.LOWER);
            if (o.cmd.buttons & BC.ATTACK) {
                if (!o.hasAmmo(o.currentWeapon)) {
                    this.changeState(WS.LOWER);
                    o.cycleNextWeapon(true);
                    return;
                }
                this.changeState(WS.FIRE);
            }
            break;
        case WS.FIRE:
            if (!o.hasAmmo(o.currentWeapon)) {
                o.actor.stopLoopingSounds();
                this.changeState(WS.LOWER);
                o.cycleNextWeapon(true);
            }
            break;
        case WS.HOLDSTER:
        case WS.LOWER:
            if (underwater && pending.disableUnderwater && (o.cmd.buttons & BC.ATTACK)) o.pendingWeapon = PW.MACHETE;
            break;
        default: break;
        }
    }
}

export class Player {
    constructor(game) {
        this.game = game;
        this.cmd = new PlayerCmd();
        this.weapon = new PlayerWeapon(this);
        this.actor = null;
        this.lockTime = 0;
        this.shakeTime = 0;
        this.shakeX = 0;
        this.shakeY = 0;
        this.reset();
    }

    reset() {
        const g = this.game;
        this.ankahs = 0;
        this.ankahFlags = 0;
        this.actor = null;
        this.cmd.reset();
        this.health = MAX_HEALTH;
        this.bob = 0; this.bobTime = 0; this.bobSpeed = 0;
        this.landTime = 0; this.stepViewZ = 0; this.viewZ = 64;
        this.airSupply = 64; this.airSupplyTime = 0;
        this.lockTime = 0; this.shakeTime = 0; this.shakeX = this.shakeY = 0;
        this.weapons = new Array(NUMPLAYERWEAPONS).fill(false);
        this.ammo = new Array(NUMPLAYERWEAPONS).fill(0);
        this.currentWeapon = 0;
        this.pendingWeapon = 0;
        for (let i = 0; i < NUMPLAYERWEAPONS; ++i) {
            const info = g.weaponInfo[i];
            if (!info) continue;
            if (info.persistent) { this.weapons[i] = true; this.currentWeapon = this.pendingWeapon = i; }
            this.ammo[i] = info.maxAmmo;
        }
        this.artifacts = 0;
        this.keys = 0;
        this.questItems = 0;
        this.teamDolls = 0;
        this.abilities = 0;
    }

    ready() {
        this.bob = this.bobTime = this.bobSpeed = 0;
        this.landTime = 0;
        this.stepViewZ = 0;
        this.keys = 0;
        this.viewZ = 64;
        this.airSupply = 64;
        this.airSupplyTime = 0;
        this.lockTime = 0;
        this.shakeTime = 0;
        this.shakeX = this.shakeY = 0;
        this.weapon.changeState(WS.RAISE);
        if (this.actor) {
            this.actor.health = this.health;
            this.game.world.enterSectorSpecial(this.actor, this.actor.sector);
        }
    }

    updateViewBob() {
        const a = this.actor, c = this.cmd;
        if (a.origin.z > a.floorHeight && !(a.flags & AF.INWATER) && !(a.playerFlags & PF.FLOATING)) {
            this.bob = this.bobTime = this.bobSpeed = 0;
        } else if ((c.buttons & (BC.FORWARD | BC.BACKWARD | BC.STRAFELEFT | BC.STRAFERIGHT)) ||
                   (a.flags & AF.INWATER) || (a.playerFlags & PF.FLOATING) || c.movement[0] !== 0 || c.movement[1] !== 0) {
            const speed = ((a.flags & AF.INWATER) || (a.playerFlags & PF.FLOATING)) ? 0.25 : 1;
            this.bobSpeed = (0.148 - this.bobSpeed) * 0.35 + this.bobSpeed;
            this.bob = Math.sin(this.bobTime * speed) * 7.0;
            this.bobTime += this.bobSpeed;
        } else {
            this.bobSpeed = 0;
            this.bobTime = 0;
            this.bob = (0 - this.bob) * 0.1 + this.bob;
        }
        if (this.landTime < 0) { this.landTime += 2; if (this.landTime >= 0) this.landTime = 0; }
        if (this.stepViewZ < 0) { this.stepViewZ += 8; if (this.stepViewZ >= 0) this.stepViewZ = 0; }
    }

    updateAirSupply() {
        const a = this.actor;
        if (!(a.flags & AF.INWATER) || (a.playerFlags & PF.ABOVESURFACE)) {
            if (a.playerFlags & PF.NEEDTOGASP) {
                if (this.abilities & PAB.DOLPHIN) {
                    a.playSound(rand.byte() & 1 ? 'sounds/dolphin01.wav' : 'sounds/dolphin02.wav');
                    a.velocity.z += PMOVE_SPEED_JUMP;
                } else {
                    a.playSound('sounds/pwgasp.wav');
                }
                a.playerFlags &= ~PF.NEEDTOGASP;
            }
            this.airSupplyTime = 0;
            this.airSupply = Math.min(64, this.airSupply + 8);
            return;
        }
        this.airSupplyTime++;
        const maxTime = (this.artifacts & PA.MASK) ? 100 : 5;
        if (this.abilities & PAB.DOLPHIN) a.playerFlags |= PF.NEEDTOGASP;
        if (this.airSupplyTime >= maxTime) {
            if (this.airSupply > 0) {
                this.airSupplyTime = 0;
                this.airSupply -= 2;
                if (!(a.playerFlags & PF.NEEDTOGASP) && this.airSupply <= 48) a.playerFlags |= PF.NEEDTOGASP;
                if (this.airSupply < 0) this.airSupply = 0;
                else if ((this.artifacts & PA.MASK) && (this.airSupply & 3) === 2 && !(this.abilities & PAB.DOLPHIN)) {
                    a.playSound('sounds/pwbreathe.wav');
                }
            } else if ((this.airSupplyTime & 0x7f) === 0) {
                a.inflictDamage(null, this.airSupplyTime >> 2);
            }
        }
    }

    tryUse() {
        const g = this.game, a = this.actor;
        const start = new Vec3(a.origin.x, a.origin.y, a.origin.z + this.viewZ);
        const end = start.add(toAxis(a.yaw, a.pitch).scale(a.radius + 64));
        if (g.cmodel.trace(a, a.sector, start, end)) {
            const face = g.cmodel.contactFace;
            if (face) g.world.useWallSpecial(this, face);
        }
    }

    autoAim(start, yaw, pitch, dist, aimYaw, aimPitch) {
        if (!this.game.settings.autoAim) return { actor: null, yaw, pitch };
        let bestYaw = yaw, bestPitch = pitch, best = null, maxDist = Infinity;
        const a = this.actor;
        for (const s of this.game.world.floodFill(start, a.sector, dist)) {
            for (const t of s.actors) {
                if ((t.flags & AF.HIDDEN) || t === a || t.health <= 0 || !(t.flags & AF.SHOOTABLE)) continue;
                const v = new Vec3(t.origin.x, t.origin.y, t.origin.z + t.height * 0.5);
                if (!a.canSee(v, maxDist)) continue;
                const d = v.sub(start);
                const ay = d.toYaw(), ap = -d.toPitch();
                if (Math.abs(clampAngle(yaw - ay)) > aimYaw) continue;
                if (Math.abs(pitch - ap) > aimPitch) continue;
                bestYaw = ay; bestPitch = ap; best = t;
                maxDist = start.distance(v);
            }
        }
        return { actor: best, yaw: bestYaw, pitch: bestPitch };
    }

    giveWeapon(id, autoSwitch = true) {
        if (id <= -1 || id >= NUMPLAYERWEAPONS || this.weapons[id]) return false;
        this.weapons[id] = true;
        if (autoSwitch) this.pendingWeapon = id;
        return true;
    }
    weaponOwned(id) { return id >= 0 && id < NUMPLAYERWEAPONS && this.weapons[id]; }
    consumeAmmo(n) {
        if (n < 0) return;
        this.ammo[this.currentWeapon] = Math.max(0, this.ammo[this.currentWeapon] - n);
    }
    getAmmo(id) { return this.ammo[id]; }
    giveAmmo(id, n) { this.ammo[id] = Math.min(this.game.weaponInfo[id].maxAmmo, this.ammo[id] + n); }
    maxHealthTotal() { return MAX_HEALTH * (this.ankahs + 1); }
    giveHealth(n) {
        const max = this.maxHealthTotal();
        if (this.actor.health >= max) return false;
        this.actor.health = Math.min(max, this.actor.health + n);
        return true;
    }
    giveKey(k) {
        if (this.keys & (1 << k)) return false;
        this.keys |= 1 << k;
        return true;
    }
    checkKey(k) { return (this.keys & (1 << k)) !== 0; }
    increaseMaxHealth(bits) {
        this.ankahs++;
        if (this.ankahs > 8 || (this.ankahFlags & bits)) { this.ankahs = Math.min(this.ankahs - 1, 8); return false; }
        this.actor.health = MAX_HEALTH * (this.ankahs + 1);
        this.ankahFlags |= bits;
        return true;
    }
    hasAmmo(id) {
        const max = this.game.weaponInfo[id].maxAmmo;
        if (max <= 0) return true;
        return this.ammo[id] > 0;
    }
    cycle(dir, checkAmmo) {
        let w = this.pendingWeapon;
        do {
            w = (w + dir + NUMPLAYERWEAPONS) % NUMPLAYERWEAPONS;
            if (checkAmmo && !this.hasAmmo(w)) continue;
            if (this.weapons[w]) { this.pendingWeapon = w; break; }
        } while (w !== this.currentWeapon);
    }
    cycleNextWeapon(checkAmmo = false) { this.cycle(1, checkAmmo); }
    cyclePrevWeapon(checkAmmo = false) { this.cycle(-1, checkAmmo); }
    holdsterWeapon() { this.weapon.changeState(WS.HOLDSTER); }
    changeWeapon() { this.currentWeapon = this.pendingWeapon; }
    selectWeapon(w) { if (this.weaponOwned(w)) this.pendingWeapon = w; }

    tick() {
        const a = this.actor;
        if (a.playerFlags & PF.DEAD) {
            this.viewZ = (2 - this.viewZ) * 0.35 + this.viewZ;
            this.landTime = 0;
            this.weapon.update();
            return;
        }
        this.updateAirSupply();
        if (this.shakeTime > 0) {
            this.shakeX = rand.cfloat() * 32;
            this.shakeY = rand.cfloat() * 32;
            if (--this.shakeTime <= 0) this.shakeX = this.shakeY = 0;
        }
        if (this.lockTime > 0) {
            if ((a.playerFlags & PF.STUNNED) && a.origin.z > a.floorHeight) {
                this.lockTime--;
            } else {
                if (this.weapon.state === WS.HOLDSTER) this.weapon.update();
                this.lockTime--;
                return;
            }
        }
        if (this.lockTime <= 0 && (a.playerFlags & PF.STUNNED)) a.playerFlags &= ~PF.STUNNED;
        if (this.cmd.buttons & BC.WEAPONLEFT) this.cyclePrevWeapon();
        if (this.cmd.buttons & BC.WEAPONRIGHT) this.cycleNextWeapon();
        if (this.cmd.buttons & BC.USE) this.tryUse();
        this.updateViewBob();
        this.weapon.update();
    }

    // ------------------------------------------- script API (kexSlavePlayer)
    GetArtifacts() { return this.artifacts; }
    GetKeys() { return this.keys; }
    GetQuestItems() { return this.questItems; }
    GetTeamDolls() { return this.teamDolls; }
    GetAbilities() { return this.abilities; }
    GetHealth() { return this.actor ? this.actor.health : this.health; }
    GetButtons() { return this.cmd.buttons; }
    GetActor() { return this.actor; }
    IsWeaponOwned(w) { return this.weaponOwned(w); }
    HoldsterWeapon() { this.holdsterWeapon(); }
    SetShakeTime(t) { this.shakeTime = t; }
    SetLockTime(t) { this.lockTime = t; }
}
