// Sprite frame actions. Native ones port game/actionDef.cpp; anything else is
// looked up in the compiled game scripts (scripts/actions.txt registers them).

import { Vec3 } from './math.js';
import { AF, AIF, PF } from './actorflags.js';
import { rand } from './random.js';

function toAxis(yaw, pitch) {
    const cp = Math.cos(pitch);
    return new Vec3(Math.sin(yaw) * cp, Math.cos(yaw) * cp, -Math.sin(pitch));
}

export class Actions {
    constructor(game) {
        this.game = game;
        this.scriptModule = null;
        this.warned = new Set();
        const g = game;
        this.native = {
            A_HitScan: (actor, dist, hSpan, vSpan, damage, _damage2, height, name) => {
                const cm = g.cmodel;
                if (actor.isPuppet) height += actor.owner.bob;
                const an1 = rand.range(-hSpan, hSpan), an2 = rand.range(-vSpan, vSpan);
                let yaw = actor.yaw, pitch = actor.pitch;
                const start = new Vec3(actor.origin.x, actor.origin.y, actor.origin.z + height);
                if (actor.isPuppet) {
                    const aim = actor.owner.autoAim(start, yaw, pitch, dist, 0.0625, 0.125);
                    yaw = aim.yaw; pitch = aim.pitch;
                }
                const end = start.add(toAxis(yaw + an1, pitch + an2).scale(dist));
                if (cm.trace(actor, actor.sector, start, end)) {
                    const pos = cm.interceptVector.add(cm.contactNormal.scale(4));
                    const contact = cm.contactActor;
                    if (contact && (contact.flags & AF.SHOOTABLE)) contact.inflictDamage(actor, damage);
                    else g.spawnActor(name, pos.x, pos.y, pos.z, actor.yaw, cm.contactSector ? cm.contactSector.index : actor.sectorIndex());
                }
            },
            A_PlayerMelee: (actor, dist, damage, height, gotoNoObj, gotoObj) => {
                if (!actor.isPuppet) return;
                const cm = g.cmodel, player = actor.owner;
                height += player.bob;
                const start = new Vec3(actor.origin.x, actor.origin.y, actor.origin.z + height);
                const aim = player.autoAim(start, actor.yaw, actor.pitch, dist, 0.25, 0.25);
                const end = start.add(toAxis(aim.yaw, aim.pitch).scale(dist));
                if (cm.trace(actor, actor.sector, start, end)) {
                    if (cm.contactActor) {
                        const c = cm.contactActor;
                        player.weapon.changeAnim(gotoObj);
                        if (c.flags & AF.SHOOTABLE) c.inflictDamage(actor, damage);
                    } else {
                        player.weapon.changeAnim(gotoNoObj);
                    }
                }
            },
            A_Spawn: (actor, name, x, y, z) => {
                g.spawnActor(name, x + actor.origin.x, y + actor.origin.y, z + actor.origin.z, actor.yaw, actor.sectorIndex());
            },
            A_Printf: (_actor, s) => console.log(s),
            A_Destroy: (actor) => { if (!actor.removing) actor.remove(); },
            A_TossActor: (actor, name, x, y, z, xs, ys, zmin, zmax) => {
                const t = g.spawnActor(name, x + actor.origin.x, y + actor.origin.y, z + actor.origin.z, actor.yaw, actor.sectorIndex());
                if (!t) return;
                t.velocity.x += rand.range(-xs, xs);
                t.velocity.y += rand.range(-ys, ys);
                t.velocity.z += rand.range(zmin, zmax);
            },
            A_DestroyAtRest: (actor, min) => {
                if (actor.origin.z > actor.floorHeight || actor.floorHeight - actor.origin.z > actor.height) return;
                if (actor.velocity.lengthSq() > min * 2) return;
                actor.remove();
            },
            A_RadialBlast: (actor, radius, damage, destroyWalls) => g.world.radialDamage(actor, radius, damage, destroyWalls === 1),
            A_ConsumeAmmo: (actor, amount) => { if (actor.isPuppet) actor.owner.consumeAmmo(amount); },
            A_Die: (actor) => { actor.flags &= ~(AF.SOLID | AF.SHOOTABLE); },
            A_PlayLocalSound: (actor, s) => actor.playSound(s),
            A_PlayLoopingLocalSound: (actor, s) => actor.playLoopingSound(s),
            A_StopSounds: (actor) => actor.stopSound(),
            A_StopLoopingSounds: (actor) => actor.stopLoopingSounds(),
            A_FaceTarget: (actor) => {
                const t = actor.target;
                if (!t) return;
                actor.yaw = Math.atan2(t.origin.x - actor.origin.x, t.origin.y - actor.origin.y);
            },
            A_CheckMelee: (actor, gotoFrame, extra) => {
                if (!actor.isAI || !actor.target) return;
                const t = actor.target;
                const r = (actor.radius + t.radius) * 1.2 + extra;
                if (actor.origin.distanceSq(t.origin) > r * r) actor.changeAnim(gotoFrame);
            },
            A_CanSeeTarget: (actor, gotoFrame, dist) => {
                const t = actor.target;
                if (!t) return;
                const org = new Vec3(t.origin.x, t.origin.y, t.origin.z + t.height * 0.5);
                if (actor.canSee(org, dist)) actor.changeAnim(gotoFrame);
            },
            A_FireProjectile: (actor, name, yawOfs, pitchOfs, distOfs, offset, speed) => {
                const yaw = yawOfs + actor.yaw;
                const pitch = pitchOfs + actor.pitch;
                const dist = distOfs + actor.radius;
                let org = null, forward;
                if (!actor.isPuppet) {
                    if (!actor.target || speed === 0) return;
                    const t = actor.target;
                    org = new Vec3(t.origin.x, t.origin.y, t.origin.z + t.height * 0.5);
                    forward = toAxis(yaw, pitch - org.sub(actor.origin).toPitch());
                } else {
                    forward = toAxis(yaw, pitch);
                }
                const proj = g.spawnFromActor(name, forward.x * dist, forward.y * dist, forward.z * dist + offset, actor, actor.yaw);
                if (!proj) return;
                const projPitch = !actor.isPuppet ? -org.sub(proj.origin).toPitch() : actor.pitch;
                proj.velocity.copy(toAxis(actor.yaw, projPitch).scale(speed));
                proj.target = actor;
                proj.sourceOwner = actor;
                proj.pitch = projPitch;
            },
            A_MeleeAttack: (actor, extra, damage) => {
                if (!actor.isAI || !actor.target) return;
                const t = actor.target;
                const r = (actor.radius + t.radius) * 1.2 + extra;
                const org = t.origin.clone();
                if (actor.aiFlags & AIF.FLYING) org.z += t.height * 0.5;
                if (actor.origin.distanceSq(org) <= r * r) t.inflictDamage(actor, damage);
            },
            A_GotoIfUnderwater: (actor, gotoFrame) => { if (actor.flags & AF.INWATER) actor.changeAnim(gotoFrame); },
            A_ClearBurnState: (actor) => { if (actor.isAI) actor.clearBurn(); },
            A_TriggerEvent: (actor) => {
                if (!actor.mapActor) return;
                const w = g.world;
                for (const ev of w.events) {
                    if (ev.type !== 70 || actor.mapActor.sector !== ev.sector) continue;
                    w.fireRemoteEventFromTag(ev.tag);
                }
            },
            A_Quake: (_actor, t) => { g.player.shakeTime = t; },
            A_SpawnLight: (actor, radius, r, gg, b, fade, passes) => g.spawnDynamicLight(actor, radius, [r, gg, b], fade, passes),
            A_MarkCheckpoint: (actor) => g.markActorUsed(actor),
            A_PlayTactile: (_a, name) => g.input.rumble(name, false),
            A_PlayLoopingTactile: (_a, name) => g.input.rumble(name, true),
            A_StopLoopingTactile: () => g.input.stopRumble(),
        };
    }

    setScriptModule(mod) { this.scriptModule = mod; }

    // scripts/actions.txt maps each action name to the script declaration it calls;
    // the names don't always match (A_SelkisCountdown -> A_SelkisCountDown)
    scriptFunction(name) {
        const fns = this.scriptModule && this.scriptModule.functions;
        if (!fns) return null;
        if (!this.scriptNames) {
            this.scriptNames = new Map();
            const text = this.game.kpf.text('scripts/actions.txt') || '';
            for (const m of text.matchAll(/^\s*(\w+)\s+"[^"(]*?(\w+)\s*\(/gm)) this.scriptNames.set(m[1], m[2]);
        }
        return fns[this.scriptNames.get(name) || name] || fns[name] || null;
    }

    execute(action, actor) {
        if (!actor) return;
        let fn = action.fn;
        if (fn === undefined) {
            fn = this.native[action.name] || this.scriptFunction(action.name);
            action.fn = fn;
        }
        if (!fn) {
            if (!this.warned.has(action.name)) { console.warn('unknown action', action.name); this.warned.add(action.name); }
            return;
        }
        try {
            fn(actor, ...action.args);
        } catch (e) {
            console.error(`action ${action.name} failed`, e);
            action.fn = null;
        }
    }

    runFrame(frame, actor) {
        if (!frame || !frame.actions.length) return;
        for (const a of frame.actions) {
            this.execute(a, actor);
            if (actor && actor.removing && a.name !== 'A_Destroy') { /* keep running like the original */ }
        }
    }
}
