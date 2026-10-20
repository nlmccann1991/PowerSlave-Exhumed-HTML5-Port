// Pickups, level travel objects and checkpoints (kexSlavePickup*, kexSlaveTravelObject,
// kexSlaveCheckpoint). Pickup logic follows game/pickup.cpp.

import { Actor } from './actor.js';
import { AF, PAB } from './actorflags.js';
import { dict } from './defs.js';
import { rand } from './random.js';

export class Pickup extends Actor {
    get isPickup() { return true; }

    spawn() {
        super.spawn();
        this.pickupSound = dict.str(this.def, 'pickupSound');
        this.pickupMessage = dict.str(this.def, 'pickupMessage');
        this.airFriction = dict.bool(this.def, 'airFriction');
        this.bits = dict.int(this.def, 'bits', dict.int(this.def, 'type', 0));
    }

    updateVelocity() {
        super.updateVelocity();
        if (this.airFriction && this.origin.z > this.floorHeight) {
            this.velocity.x *= 0.9;
            this.velocity.y *= 0.9;
        }
    }

    player(instigator) {
        if (this.removing || !instigator.isPuppet) return null;
        return instigator.owner;
    }

    pickedUp(instigator) {
        this.game.markActorUsed(this);
        if (this.pickupSound) instigator.playSound(this.pickupSound);
        if (this.pickupMessage) this.game.print(this.pickupMessage);
        this.flags &= ~(AF.SOLID | AF.TOUCHABLE);
        this.remove();
        this.game.pickupFlash();
    }
}

export class WeaponPickup extends Pickup {
    spawn() {
        super.spawn();
        this.weaponSlotToGive = dict.int(this.def, 'weaponSlotToGive', -1);
        if (dict.bool(this.def, 'removeIfOwned') && this.game.player.weaponOwned(this.weaponSlotToGive)) this.remove();
    }
    onTouch(i) {
        const p = this.player(i);
        if (p && p.giveWeapon(this.weaponSlotToGive)) this.pickedUp(i);
    }
}

export class AmmoPickup extends Pickup {
    spawn() {
        super.spawn();
        this.weaponSlotToGive = dict.int(this.def, 'weaponSlotToGive', -1);
        this.divisor = Math.max(1, dict.int(this.def, 'divisor', 1));
        this.multiplier = dict.float(this.def, 'multiplier', 5) || 1;
        this.fullAmmo = dict.bool(this.def, 'fullAmmo');
    }
    onTouch(i) {
        const p = this.player(i);
        if (!p) return;
        const g = this.game;
        if (this.fullAmmo) {
            for (let w = 0; w < g.weaponInfo.length; ++w) p.giveAmmo(w, g.weaponInfo[w].maxAmmo);
            this.pickedUp(i);
            return;
        }
        const weapon = this.weaponSlotToGive <= -1 ? p.pendingWeapon : this.weaponSlotToGive;
        const info = g.weaponInfo[weapon];
        if (p.getAmmo(weapon) >= info.maxAmmo) return;
        // larger (scaled-up) orbs give proportionally more ammo
        let give = Math.floor((info.maxAmmo * Math.max(1, this.scale)) / (this.multiplier * this.divisor));
        if (give <= 0) give = 1;
        p.giveAmmo(weapon, give);
        this.pickedUp(i);
    }
}

export class HealthPickup extends Pickup {
    spawn() {
        super.spawn();
        this.giveAmount = dict.int(this.def, 'giveAmount', 20);
        this.multiplier = dict.float(this.def, 'multiplier', 1);
    }
    onTouch(i) {
        const p = this.player(i);
        if (!p) return;
        let give = this.giveAmount;
        if (this.scale > 1) give = Math.trunc(give * this.multiplier);
        if (p.giveHealth(give)) this.pickedUp(i);
    }
}

// Item_Power: refills ammo for every weapon and restores some health.
export class PowerPickup extends Pickup {
    spawn() {
        super.spawn();
        this.giveAmount = dict.int(this.def, 'giveAmount', 2400);
    }
    onTouch(i) {
        const p = this.player(i);
        if (!p) return;
        const g = this.game;
        for (let w = 0; w < g.weaponInfo.length; ++w) p.giveAmmo(w, g.weaponInfo[w].maxAmmo);
        p.giveHealth(Math.trunc(this.giveAmount / 24));
        this.pickedUp(i);
    }
}

export class MaxHealthPickup extends Pickup {
    spawn() {
        super.spawn();
        if (this.game.player.ankahFlags & (1 << this.bits)) this.remove();
    }
    onTouch(i) {
        const p = this.player(i);
        if (p && p.increaseMaxHealth(1 << this.bits)) this.pickedUp(i);
    }
}

export class KeyPickup extends Pickup {
    spawn() { super.spawn(); this.bits = dict.int(this.def, 'keyType', 0); }
    onTouch(i) {
        const p = this.player(i);
        if (p && this.bits >= 0 && p.giveKey(this.bits)) this.pickedUp(i);
    }
}

export class ArtifactPickup extends Pickup {
    spawn() {
        super.spawn();
        if (this.game.player.artifacts & (1 << this.bits)) {
            this.game.world.fireRemoteEventFromTag(1000 + this.bits);
            this.remove();
        }
    }
    onTouch(i) {
        const p = this.player(i);
        if (!p || this.bits < 0 || (p.artifacts & (1 << this.bits))) return;
        p.artifacts |= 1 << this.bits;
        this.game.showArtifact(this.bits);
        this.pickedUp(i);
        this.game.world.fireRemoteEventFromTag(1000 + this.bits);
    }
}

export class QuestPickup extends Pickup {
    spawn() {
        super.spawn();
        if (this.game.player.questItems & (1 << this.bits)) this.remove();
    }
    onTouch(i) {
        const p = this.player(i);
        if (!p || this.bits < 0 || (p.questItems & (1 << this.bits))) return;
        p.questItems |= 1 << this.bits;
        this.game.showTransmitter(this.bits);
        this.pickedUp(i);
    }
}

export class TeamDollPickup extends Pickup {
    spawn() {
        super.spawn();
        if (this.game.player.teamDolls & (1 << this.bits)) this.remove();
    }
    onTouch(i) {
        const p = this.player(i);
        if (!p || this.bits < 0 || (p.teamDolls & (1 << this.bits))) return;
        p.teamDolls |= 1 << this.bits;
        let n = 0;
        for (let b = 0; b < 32; ++b) if (p.teamDolls & (1 << b)) n++;
        if (n >= 14) p.abilities |= PAB.VULTURE;
        else if (n >= 10) p.abilities |= PAB.DOLPHIN;
        this.game.print('$str_071', n);
        this.pickedUp(i);
    }
}

export class MapPickup extends Pickup {
    onTouch(i) {
        if (!this.player(i)) return;
        this.game.automap.mapAll = true;
        this.pickedUp(i);
    }
}

export class TravelObject extends Actor {
    get isTravelObject() { return true; }
    spawn() {
        super.spawn();
        const d = this.def;
        this.reTriggerTime = 0;
        this.mapDestination = dict.int(d, 'mapDestination', -1);
        this.giveArtifacts = dict.int(d, 'giveArtifacts', 0);
        this.destinationPosition = dict.vec(d, 'destinationPosition');
        this.requestSave = dict.bool(d, 'requestSave');
        this.warpSounds = [];
        for (let i = 1; d && d[`warpSound_${i}`]; ++i) this.warpSounds.push(d[`warpSound_${i}`]);
    }
    tick() {
        super.tick();
        if (this.reTriggerTime) this.reTriggerTime--;
    }
    onTouch(instigator) {
        if (this.reTriggerTime > 0 || !instigator.isPuppet) return;
        const g = this.game;
        if (this.warpSounds.length) this.playSound(this.warpSounds[rand.max(this.warpSounds.length)]);
        if (this.mapDestination >= 0) {
            g.player.artifacts |= this.giveArtifacts;
            g.travelTo(this.mapDestination, this.destinationPosition);
            this.reTriggerTime = 10000;
        } else if (this.mapDestination === -2) {
            g.requestEnding(true);
            this.reTriggerTime = 10000;
        } else if (this.mapDestination === -3) {
            g.requestEnding(false);
            this.reTriggerTime = 10000;
        } else {
            this.reTriggerTime = 120;
            g.openTravelMenu(this);
        }
    }
}

// kexSlaveCheckpoint: touching it makes it the active checkpoint, resets every other
// checkpoint in the level back to its idle animation and prints "Checkpoint".
export class Checkpoint extends Actor {
    spawn() {
        super.spawn();
        this.activated = false;
    }
    onTouch(instigator) {
        if (this.activated || !instigator.isPuppet || instigator.health <= 0) return;
        const g = this.game;
        for (const o of g.objects) {
            if (o !== this && o instanceof Checkpoint && o.activated) {
                o.activated = false;
                if (o.spawnAnim) o.changeAnim(o.spawnAnim);
            }
        }
        this.activated = true;
        if (this.deathAnim) this.changeAnim(this.deathAnim);
        this.playSound('sounds/checkpoint.wav');
        g.saveCheckpoint(this);
    }
}
