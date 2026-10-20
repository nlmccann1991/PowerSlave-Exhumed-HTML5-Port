// Monster AI, exposed to scripts as kexSlaveAI. Structure follows the GPL kexAI, but the
// think logic is the remaster's (kexSlaveAI in the exe: tick 0x14018e5b0, chase 0x140190ab0,
// look 0x14018ee50, damage 0x14018e920, step 0x1401902a0): monsters step moveSpeed along one
// of 16 directions per think, ease their facing toward it, give up on targets they haven't
// seen for 300 thinks and range attack on a per-difficulty cooldown.

import { Actor } from './actor.js';
import { AF, AIF, AIS } from './actorflags.js';
import { Vec3, clampAngle, deg2rad } from './math.js';
import { FF, SF } from './mapfile.js';
import { dict } from './defs.js';
import { rand } from './random.js';

const DIR_ANGLE = Math.PI / 8; // 16 move directions, 0 = +y, clockwise
const SIGHT_TIMEOUT = 300;

export class AI extends Actor {
    constructor(game) {
        super(game);
        this.chaseAnim = this.painAnim = this.meleeAnim = this.attackAnim = null;
        this.state = AIS.IDLE;
        this.thinkTime = 0.5;
        this.curThinkTime = 1;
        this.aiFlags = 0;
        this.painChance = 0xff;
        this.moveSpeed = 8;
        this.meleeExtraDistance = 0;
        this.turnSpeed = 8;
        this.sightDistance = 3000;
        this.moveDir = -1;        // 0..15, -1 = none
        this.moveDelay = 0;       // pause between steps (moveDelayMin/Max)
        this.moveDelayMin = 0;
        this.moveDelayMax = 0;
        this.rethinkTime = 0;     // steps left before picking a new direction
        this.sightTimeout = 0;    // thinks left before giving up on an unseen target
        this.attackCooldown = 0;  // thinks left before the next range attack
        this.igniteFlames = [null, null, null, null];
        this.igniteTicks = [-1, -1, -1, -1];
        this.painSound = null;
        this.sightSound = null;
        this.canIgnite = true;
    }

    get isAI() { return true; }

    spawn() {
        super.spawn();
        const d = this.def;
        const g = this.game;
        if (d) {
            this.painChance = dict.int(d, 'painChance', 0xff);
            this.moveSpeed = dict.float(d, 'moveSpeed', 8);
            this.meleeExtraDistance = dict.float(d, 'meleeExtraDist', 0);
            this.turnSpeed = dict.float(d, 'turnSpeed', 8);
            this.sightDistance = dict.float(d, 'sightDistance', 3000);
            this.painSound = dict.str(d, 'painSound');
            this.sightSound = dict.str(d, 'sightSound');
            this.canIgnite = dict.bool(d, 'canIgnite', false);
            this.moveDelayMin = dict.float(d, 'moveDelayMin', 0);
            this.moveDelayMax = dict.float(d, 'moveDelayMax', 0);
            const B = (k, f) => { if (dict.bool(d, k)) this.aiFlags |= f; };
            B('lookAllAround', AIF.LOOKALLAROUND);
            B('alwaysRangeAttack', AIF.ALWAYSRANGEATTACK);
            B('flying', AIF.FLYING);
            B('retreatAfterMelee', AIF.RETREATAFTERMELEE);
            B('flyAdjustViewLevel', AIF.FLYADJUSTVIEWLEVEL);
            B('noLavaDamage', AIF.NOLAVADAMAGE);
            B('noInFighting', AIF.NOINFIGHTING);
            B('chaseWander', AIF.CHASEWANDER);
            const A = (k) => { const n = dict.str(d, k); return n ? g.anims.get(n) : null; };
            this.chaseAnim = A('chaseAnim');
            this.painAnim = A('painAnim');
            this.meleeAnim = A('meleeAnim');
            this.attackAnim = A('rangeAttackAnim');
        }
        if (this.turnSpeed <= 0) this.turnSpeed = 1;
        if (g.settings.difficulty === 2) {
            this.painChance >>= 1;
            this.moveSpeed *= 1.1;
        }
    }

    tick() {
        if (this.removing) return;
        this.changeStateFromAnim();
        this.curThinkTime -= this.thinkTime;
        if (this.curThinkTime <= 0) {
            if (this.target && this.target.health <= 0) {
                this.state = AIS.IDLE;
                this.target = null;
                this.changeAnim(this.spawnAnim);
                return;
            }
            switch (this.state) {
            case AIS.IDLE: this.lookForTarget(); break;
            case AIS.CHASE: this.chaseTarget(); break;
            case AIS.PAIN: this.inPain(); break;
            case AIS.MELEE: this.faceTarget(); break;
            default: break;
            }
            this.updateBurn();
            this.curThinkTime += 1;
        }
        super.tick();
    }

    onRemove() { this.clearBurn(); super.onRemove(); }
    onDeath() { this.clearBurn(); this.game.stats.kills++; this.game.markActorUsed(this); }

    onDamage(instigator) {
        if (this.health <= 0) { this.state = AIS.DEAD; return; }
        if (instigator && instigator !== this.target && instigator !== this &&
            ((instigator.flags & AF.SHOOTABLE) || instigator.isProjectile)) {
            if (!instigator.isProjectile) {
                if (instigator.isPuppet) this.target = instigator;
            } else {
                // whoever fired it; monsters only turn on each other now and then
                const owner = instigator.target;
                if (owner && owner.isPuppet) {
                    this.target = owner;
                } else if (owner && owner.isAI && owner !== this && !(this.aiFlags & AIF.NOINFIGHTING) &&
                    (owner.target === this || (rand.byte() & 3) === 0)) {
                    this.target = owner;
                }
            }
            if (this.state === AIS.IDLE && this.anim !== this.chaseAnim) this.startChasing();
        }
        if (rand.byte() < this.painChance) {
            if (this.painAnim && this.state === AIS.CHASE) {
                this.changeAnim(this.painAnim);
                this.state = AIS.PAIN;
            }
            if (this.painSound) this.playSound(this.painSound);
        } else if ((rand.byte() & 15) !== 0) {
            return;
        }
        this.attackCooldown = 0; // hit back straight away
    }

    clearBurn() {
        for (let i = 0; i < 4; ++i) {
            if (this.igniteTicks[i] <= -1 || !this.igniteFlames[i]) continue;
            this.igniteFlames[i].target = null;
            this.igniteFlames[i].remove();
            this.igniteFlames[i] = null;
            this.igniteTicks[i] = -1;
        }
        this.aiFlags &= ~AIF.ONFIRE;
    }

    updateBurn() {
        if (!(this.aiFlags & AIF.ONFIRE) || this.state === AIS.PAIN) return;
        let cnt = 0, total = 0;
        for (let i = 0; i < 4; ++i) {
            if (this.igniteTicks[i] <= -1 || !this.igniteFlames[i]) continue;
            if (--this.igniteTicks[i] < 0) {
                this.igniteFlames[i].target = null;
                this.igniteFlames[i].remove();
                this.igniteFlames[i] = null;
                this.igniteTicks[i] = -1;
                continue;
            }
            total += this.igniteTicks[i];
            cnt++;
        }
        if (cnt === 0) this.aiFlags &= ~AIF.ONFIRE;
        else if ((total & 7) === 0) this.inflictDamage(null, 9);
    }

    canSeeTarget(actor) {
        if (this.game.noTarget) return false;
        const start = new Vec3(this.origin.x, this.origin.y, this.origin.z + this.height * 0.8);
        const end = new Vec3(actor.origin.x, actor.origin.y, actor.origin.z + actor.height * 0.8);
        return !this.game.cmodel.trace(this, this.sector, start, end, 0, false);
    }

    angleTo(actor) { return Math.atan2(actor.origin.x - this.origin.x, actor.origin.y - this.origin.y); }

    changeStateFromAnim() {
        if (this.state === AIS.DEAD) return;
        const a = this.anim;
        if (a === this.chaseAnim && this.state !== AIS.CHASE) this.state = AIS.CHASE;
        else if (a === this.spawnAnim && this.state !== AIS.IDLE) this.state = AIS.IDLE;
        else if (a === this.meleeAnim && this.state !== AIS.MELEE) this.state = AIS.MELEE;
        else if (a === this.painAnim && this.state !== AIS.PAIN) this.state = AIS.PAIN;
        else if (a !== this.chaseAnim && a !== this.spawnAnim && a !== this.meleeAnim && a !== this.painAnim) this.state = AIS.CUSTOM;
    }

    startChasing() {
        if (this.chaseAnim) this.changeAnim(this.chaseAnim);
        this.state = AIS.CHASE;
        this.sightTimeout = SIGHT_TIMEOUT;
        this.resetAttackCooldown();
    }

    // FUN_14018ed80
    resetAttackCooldown() {
        const diff = this.game.settings.difficulty;
        if (diff === 2) this.attackCooldown = (rand.byte() & 3) + 4;
        else if (diff === 1 && !(rand.byte() & 1)) this.attackCooldown = (rand.byte() & 7) + 8;
        else this.attackCooldown = (rand.byte() & 15) + 16;
    }

    giveUpTarget() {
        this.state = AIS.IDLE;
        this.aiFlags |= AIF.LOOKALLAROUND;
        this.target = null;
        this.changeAnim(this.spawnAnim);
    }

    inPain() { if (this.anim === this.chaseAnim) this.state = AIS.CHASE; }

    faceTarget(targ) {
        const t = targ || this.target;
        if (!t) return;
        this.yaw = this.angleTo(t);
    }

    lookForTarget() {
        if (this.target) {
            if (this.state === AIS.IDLE) this.startChasing();
            return;
        }
        const targ = this.game.player.actor;
        if (!targ || targ.health <= 0 || targ.isDead || this.game.noTarget) return;
        if (Math.abs(this.origin.x - targ.origin.x) >= this.sightDistance) return;
        if (Math.abs(this.origin.y - targ.origin.y) >= this.sightDistance) return;
        if (!(this.aiFlags & AIF.LOOKALLAROUND) && Math.abs(clampAngle(this.yaw - this.angleTo(targ))) > deg2rad(85)) return;
        if (!this.canSeeTarget(targ)) return;
        if (this.sightSound) this.playSound(this.sightSound);
        this.target = targ;
        this.startChasing();
    }

    // height of this monster's eyes over the target's, for flyers
    getTargetHeightDifference() {
        const t = this.target;
        if (!t || !t.isActor) return 0;
        const th = t.height;
        if (this.aiFlags & AIF.FLYADJUSTVIEWLEVEL) {
            return (this.height * 0.5 + this.origin.z - t.origin.z) - th * 0.5 - th * 0.25;
        }
        return (this.height + this.origin.z - t.origin.z) - th;
    }

    // FUN_1401902a0: step moveSpeed along moveDir if there's room
    tryMove() {
        if (this.moveDir < 0) return false;
        const g = this.game, cm = g.cmodel;
        const ang = this.moveDir * DIR_ANGLE;
        const dx = Math.sin(ang), dy = Math.cos(ang);
        const start = new Vec3(this.origin.x, this.origin.y, this.origin.z + this.stepHeight);
        const end = new Vec3(start.x + dx * (this.moveSpeed + this.radius), start.y + dy * (this.moveSpeed + this.radius), start.z);
        if (cm.trace(this, this.sector, start, end) && cm.contactActor !== this.target) return false;
        if (!(this.aiFlags & AIF.FLYING) && !this.checkDropOff(end)) return false;
        this.movement.set(dx * this.moveSpeed, dy * this.moveSpeed, 0);
        cm.move(this);
        if (this.aiFlags & AIF.ONFIRE) {
            for (const f of this.igniteFlames) {
                if (!f) continue;
                f.origin.addSelf(this.movement);
                f.setSector(this.sector);
            }
        }
        this.movement.clear();
        return true;
    }

    // ledges, water and lava the monster won't walk into
    checkDropOff(end) {
        const g = this.game, cm = g.cmodel, s0 = this.sector;
        for (let i = s0.faceStart; i <= s0.faceEnd; ++i) {
            const face = g.world.faces[i];
            if (face.sector <= -1) continue;
            if (cm.pointOnFaceSide(end, face, this.radius * 1.125) > 0) continue;
            if (face.flags & FF.BLOCKAIFALLERS) return false;
            const s = g.world.sectors[face.sector];
            if ((this.flags & AF.NOENTERWATER) && (s.floorFace.flags & FF.WATER)) return false;
            if (!(this.aiFlags & AIF.NOLAVADAMAGE) && (s.floorFace.flags & FF.LAVA)) return false;
            if (this.flags & AF.NODROPOFF) {
                const fh1 = cm.getFloorHeight(this.origin, s0);
                const fh2 = cm.getFloorHeight(this.origin, s);
                if (fh1 - fh2 > this.fallHeight || (!(this.flags & AF.INWATER) && (s.flags & SF.WATER))) return false;
            }
        }
        return true;
    }

    igniteFrom(src) {
        if (this.aiFlags & AIF.NOLAVADAMAGE) return;
        if (src && src.isProjectileFlame) {
            if (!(rand.int() & 1)) return;
            if (!this.target) this.target = src.target;
            return this.ignite(src.target);
        }
        return this.ignite(src);
    }

    ignite(igniteTarget) {
        if (this.aiFlags & AIF.NOLAVADAMAGE) return;
        this.aiFlags |= AIF.ONFIRE;
        for (let i = 0; i < 4; ++i) {
            if (this.igniteTicks[i] <= -1 && !this.igniteFlames[i]) {
                this.igniteTicks[i] = rand.max(64) + 64;
                let hd = (this.height * rand.byte()) / 384;
                if (hd < this.stepHeight) hd = this.stepHeight;
                const x = this.origin.x + rand.float() * this.radius * 0.5;
                const y = this.origin.y + rand.float() * this.radius * 0.5;
                const z = this.origin.z + hd;
                const f = this.game.spawnActor(24, x, y, z, 0, this.sectorIndex());
                if (f) { f.target = igniteTarget; this.igniteFlames[i] = f; }
                break;
            }
        }
    }

    igniteFromLava() {
        if ((this.aiFlags & AIF.ONFIRE) && (rand.int() & 3) !== 0) return;
        if (!this.target) this.target = this.game.player.actor;
        this.ignite(this.target);
    }

    chaseTarget() {
        if (!this.target) this.target = this.game.player.actor;
        const t = this.target;
        if (!t || t.health <= 0) { this.giveUpTarget(); return; }
        const seen = this.canSeeTarget(t);
        if (seen) this.sightTimeout = SIGHT_TIMEOUT;
        if (--this.sightTimeout < 0) { this.giveUpTarget(); return; }

        // ease the facing toward the move direction
        if (this.moveDelay <= 0 && this.moveDir >= 0) {
            this.yaw = clampAngle(this.yaw + clampAngle(this.moveDir * DIR_ANGLE - this.yaw) / this.turnSpeed);
        }

        if ((this.aiFlags & AIF.FLYING) && this.moveDelay <= 0 && seen) {
            const diff = this.getTargetHeightDifference();
            if (diff < 0 && this.height < this.ceilingHeight - this.origin.z) this.velocity.z = Math.min(16, -diff / 32);
            else if (diff > 0 && this.height < this.origin.z - this.floorHeight) this.velocity.z = Math.max(-16, -diff / 32);
            else this.velocity.z = 0;
        }

        if (this.meleeAnim) {
            const r = (this.radius + t.radius) * 1.2 + this.meleeExtraDistance;
            const tz = t.origin.z + ((this.aiFlags & AIF.FLYING) ? this.stepHeight : 0);
            const dx = this.origin.x - t.origin.x, dy = this.origin.y - t.origin.y, dz = this.origin.z - tz;
            if (dx * dx + dy * dy + dz * dz <= r * r && this.canSeeTarget(t)) {
                this.faceTarget();
                this.changeAnim(this.meleeAnim);
                this.state = AIS.MELEE;
                if ((this.aiFlags & AIF.FLYING) && this.getTargetHeightDifference() <= 0) this.velocity.z = 0;
                return;
            }
        }

        if (this.attackAnim) {
            const always = this.aiFlags & AIF.ALWAYSRANGEATTACK;
            if (seen || always) this.attackCooldown--;
            if (this.attackCooldown < 1 && (always || this.canSeeTarget(t))) {
                this.faceTarget();
                this.changeAnim(this.attackAnim);
                this.state = AIS.RANGE;
                this.resetAttackCooldown();
            }
        }

        if (this.moveDelay > 0) {
            this.moveDelay -= 0.5;
            if (this.moveDelay > 0) return;
        }
        if (--this.rethinkTime >= 0 && this.tryMove()) return;
        if (this.rethinkTime < 1 && (this.moveDelayMin || this.moveDelayMax)) {
            this.moveDelay = rand.range(this.moveDelayMin, this.moveDelayMax);
        }
        this.chooseDirection();
    }

    // pick a new direction: straight at the target (or random when wandering),
    // otherwise sidestep, sweep round, back off or give up and go anywhere
    chooseDirection() {
        const t = this.target;
        const wander = this.aiFlags & AIF.CHASEWANDER;
        if (wander) {
            this.moveDir = rand.byte() & 15;
        } else {
            const a = clampAngle(this.angleTo(t));
            this.moveDir = ((Math.round(a / DIR_ANGLE) % 16) + 16) % 16;
        }
        const bonus = wander ? 64 : 0;
        if (this.tryMove()) { this.rethinkTime = (rand.byte() & 31) + bonus; return; }
        const dir = this.moveDir, back = (dir + 8) & 15;
        this.moveDir = rand.byte() <= 128 ? (dir + 4) & 15 : (dir + 12) & 15;
        let ok = this.tryMove();
        if (!ok) {
            const step = (rand.byte() & 1) ? 1 : -1;
            for (let i = 0; i < 16 && !ok; ++i) {
                this.moveDir = (dir + step * i + 16) & 15;
                ok = this.moveDir !== back && this.tryMove();
            }
        }
        if (ok) { this.rethinkTime = rand.max(64) + bonus; return; }
        this.moveDir = back;
        if (this.tryMove()) { this.rethinkTime = (rand.byte() & 31) + bonus; return; }
        this.moveDir = rand.byte() & 15;
    }

    updateMovement() {
        const g = this.game;
        this.updateVelocity();
        this.checkFloorAndCeilings();
        this.movement.addSelf(this.velocity);
        if (!(this.aiFlags & AIF.NOLAVADAMAGE) && (this.sector.floorFace.flags & FF.LAVA) &&
            g.cmodel.pointOnFaceSide(this.origin, this.sector.floorFace) <= 0.1) {
            this.igniteFromLava();
        }
        if (this.movement.lengthSq() > 0) {
            if (!g.cmodel.move(this)) this.velocity.clear();
            if (this.aiFlags & AIF.ONFIRE) {
                for (const f of this.igniteFlames) {
                    if (!f) continue;
                    f.origin.addSelf(this.movement);
                    f.setSector(this.sector);
                }
            }
            this.movement.clear();
        }
    }

    // script API (kexSlaveAI)
    GetMoveSpeed() { return this.moveSpeed; }
    GetPainChance() { return this.painChance; }
    GetTurnSpeed() { return this.turnSpeed; }
    GetSightDistance() { return this.sightDistance; }
    GetMeleeExtraDistance() { return this.meleeExtraDistance; }
    ClearIgniteFlames() { this.clearBurn(); }
}
