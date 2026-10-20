// Scene composition: 3D view from the player, actor billboards (port of
// kexRenderScene::DrawSprite), the first-person weapon, automap and the
// 320x240 virtual-screen 2D layer used by the HUD and menus.

import { AF, PF, WS } from './actorflags.js';
import { FF } from './mapfile.js';
import { Vec3, clampAngle } from './math.js';
import { PortalVis } from './portals.js';

export class SceneDrawer {
    constructor(game) {
        this.game = game;
        this.r = game.renderer;
    }

    // ------------------------------------------------------------------ 3D

    viewFromPlayer() {
        const g = this.game, p = g.player, a = p.actor;
        let yaw = a.yaw, pitch = a.pitch;
        const o = a.origin.clone();
        o.z += p.viewZ + p.bob + p.landTime + p.stepViewZ;
        if (p.shakeTime > 0 && Math.trunc(a.velocity.z) === 0) {
            yaw += (p.shakeX * 0.125) * Math.PI / 180;
            o.z += p.shakeY * 0.5;
        }
        return { origin: o, yaw, pitch, roll: a.roll };
    }

    drawLevel() {
        const g = this.game, r = this.r;
        const v = this.viewFromPlayer();
        g.view = v;
        const fov = g.settings.fov * Math.PI / 180;
        r.fov = fov;
        r.colorScale = g.settings.colorScale;
        r.currentTime = g.ticks;
        // gather dynamic lights
        r.lights = [];
        for (const o of g.objects) {
            if (o.radius && o.fade !== undefined && o.color && !o.removing) {
                const k = o.fade;
                r.lights.push({ x: o.origin.x, y: o.origin.y, z: o.origin.z + 32, radius: o.radius * 1.5,
                    r: o.color[0] * k, g: o.color[1] * k, b: o.color[2] * k });
            }
        }
        r.lights.sort((a, b) => ((a.x - v.origin.x) ** 2 + (a.y - v.origin.y) ** 2) - ((b.x - v.origin.x) ** 2 + (b.y - v.origin.y) ** 2));
        // underwater tint
        const pa = g.player.actor;
        const underwater = (pa.flags & AF.INWATER) && !(pa.playerFlags & PF.ABOVESURFACE);
        r.tint = underwater ? [0.55, 0.75, 1.0, 1] : [1, 1, 1, 1];
        // camera uses positive pitch = look up
        r.beginFrame({ origin: v.origin, yaw: v.yaw, pitch: -v.pitch, roll: -v.roll * 0.5, fov });
        // only what the portal flood reaches from the camera's sector gets drawn
        if (!this.vis || this.vis.world !== g.world) this.vis = new PortalVis(g.world);
        const start = pa.sector;
        if (start && !g.noPortalVis) { this.vis.update(r.mvp, v.origin, start); r.vis = this.vis; } else r.vis = null;
        r.drawSky();
        r.drawWorld();
        this.drawActors(v);
        r.drawWater();
    }

    drawActors(v) {
        const g = this.game, r = this.r;
        const basis = r.spriteBasis();
        const list = [];
        const vx = v.origin.x, vy = v.origin.y, vz = v.origin.z;
        const fwd = basis.fwd;
        for (const a of g.objects) {
            if (!a.isActor || a.removing || a === g.player.actor) continue;
            if (a.flags & AF.HIDDEN) continue;
            if (!a.anim || !a.sector) continue;
            if (r.vis && !r.vis.visible[a.sector.index]) continue;
            const dx = a.origin.x - vx, dy = a.origin.y - vy, dz = a.origin.z - vz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > 12000 * 12000) continue;
            // behind the camera (with slack for big sprites)
            if (dx * fwd[0] + dy * fwd[1] + dz * fwd[2] < -256) continue;
            const s = this.buildSprite(a, v, basis);
            if (s) { s.dist = d2; list.push(s); }
            if (a.shadowAnim && a.origin.z - a.floorHeight < 512) {
                const sh = this.buildShadow(a);
                if (sh) { sh.dist = d2 + 1; list.push(sh); }
            }
        }
        // laser beams: camera-facing additive ribbons
        const white = g.textures.white;
        const glow = g.textures.get('sprites/projectiles/beam.png', { clamp: true, mips: false });
        for (const a of g.objects) {
            if (!a.beamStart || a.removing) continue;
            const s0 = a.beamStart, s1 = a.beamEnd;
            const d = s1.sub(s0);
            const len = d.length();
            if (len < 1) continue;
            const mid = s0.add(d.scale(0.5));
            const toCam = new Vec3(vx - mid.x, vy - mid.y, vz - mid.z);
            let side = d.cross(toCam).normalize();
            const pulse = 6 + Math.sin(g.ticks * 0.5) * 1.5;
            const quad = (w, tex, r0, g0, b0, a0) => {
                const o = side.scale(w);
                return { tex, p: [[s0.x + o.x, s0.y + o.y, s0.z + o.z], [s1.x + o.x, s1.y + o.y, s1.z + o.z],
                    [s0.x - o.x, s0.y - o.y, s0.z - o.z], [s1.x - o.x, s1.y - o.y, s1.z - o.z]],
                u1: 0, v1: 0, u2: 1, v2: 1, r: r0, g: g0, b: b0, a: a0, additive: true };
            };
            list.push({ dist: toCam.lengthSq(), quads: [quad(pulse * 2.5, glow.ready ? glow : white, 255, 40, 20, 255), quad(pulse * 0.4, white, 255, 200, 160, 255)] });
        }
        r.drawSpriteList(list);
    }

    spriteLight(a) {
        if ((a.flags & AF.FULLBRIGHT) || (a.frame && a.frame.fullbright)) return 255;
        return Math.min(255, (a.sector.lightLevel << 1) + 32);
    }

    buildSprite(a, v, basis) {
        const frame = a.anim.frames[a.frameID];
        if (!frame) return null;
        let rot = 0;
        if (frame.hasRotations) {
            let an = a.yaw - Math.atan2(a.origin.x - v.origin.x, a.origin.y - v.origin.y);
            an = clampAngle(an);
            an = (an > 0 ? an : Math.PI * 2 + an) * 180 / Math.PI;
            rot = Math.floor((an + (45 / 2) * 9) / 45);
            rot %= 8;
            if (rot < 0) rot += 8;
        }
        const set = frame.spriteSet[rot];
        if (!set || !set.length) return null;
        const c = this.spriteLight(a);
        const cr = Math.min(255, c * a.color.x * 2) | 0, cg = Math.min(255, c * a.color.y * 2) | 0, cb = Math.min(255, c * a.color.z * 2) | 0;
        const scale = a.scale;
        let oz = a.origin.z;
        if (a.floatBob) oz += Math.sin(a.gameTicks * 0.05 / Math.max(0.5, a.floatBobDivisor / 3)) * 8;
        const quads = [];
        const R = basis.right, U = basis.up;
        for (const s of set) {
            const atlas = s.atlas;
            if (!atlas) continue;
            const info = atlas.infos[s.index];
            const tex = atlas.texture;
            if (!info || !tex.ready || !tex.width) continue;
            const x = s.x, y = s.y, w = info.w, h = info.h;
            let u1 = info.x / tex.width, u2 = (info.x + w) / tex.width;
            const v1 = info.y / tex.height, v2 = (info.y + h) / tex.height;
            if (s.flipped) { const t = u1; u1 = u2; u2 = t; }
            const pt = (px, py) => [
                a.origin.x + (R[0] * px - U[0] * py) * scale,
                a.origin.y + (R[1] * px - U[1] * py) * scale,
                oz + (R[2] * px - U[2] * py) * scale,
            ];
            const p = [pt(x, y), pt(x + w, y), pt(x, y + h), pt(x + w, y + h)];
            quads.push({ tex, p, u1, v1, u2, v2, r: cr, g: cg, b: cb, a: a.transparency });
            if (a.flags & AF.FLASH) quads.push({ tex, p, u1, v1, u2, v2, r: 255, g: 255, b: 255, a: 255, additive: true });
        }
        return { quads };
    }

    buildShadow(a) {
        const frame = a.shadowAnim.frames[0];
        const s = frame && frame.spriteSet[0][0];
        if (!s || !s.atlas) return null;
        const info = s.atlas.infos[s.index], tex = s.atlas.texture;
        if (!info || !tex.ready || !tex.width) return null;
        // shadow.png's colours are a placeholder smiley; only its alpha disc is used,
        // drawn as a dark blob that fades as the actor rises above the floor
        const z = a.floorHeight + 1;
        const lift = Math.max(0, a.origin.z - a.floorHeight);
        const fade = Math.max(0, 1 - lift / 384);
        if (fade <= 0) return null;
        const size = 0.5 * a.scale * (0.6 + 0.4 * fade);
        const hw = info.w * size, hh = info.h * size;
        const x = a.origin.x, y = a.origin.y;
        return {
            quads: [{
                tex, p: [[x - hw, y + hh, z], [x + hw, y + hh, z], [x - hw, y - hh, z], [x + hw, y - hh, z]],
                u1: info.x / tex.width, v1: info.y / tex.height, u2: (info.x + info.w) / tex.width, v2: (info.y + info.h) / tex.height,
                r: 0, g: 0, b: 0, a: Math.round(110 * fade),
            }],
        };
    }

    // ------------------------------------------------------------------ 2D

    begin2D() {
        const r = this.r;
        r.resize();
        this.vh = 240;
        this.vw = 240 * (r.width / r.height);
        this.ox = (this.vw - 320) / 2;
        r.begin2D();
    }

    end2D() { this.r.end2D(this.vw, this.vh); }

    // draw in 320x240 centered coordinates
    img(tex, x, y, w, h, u1 = 0, v1 = 0, u2 = 1, v2 = 1, rr = 255, gg = 255, bb = 255, aa = 255, add = false) {
        this.r.image(tex, x + this.ox, y, w, h, u1, v1, u2, v2, rr, gg, bb, aa, add);
    }

    fill(x, y, w, h, rr, gg, bb, aa) { this.r.fill(x + this.ox, y, w, h, rr, gg, bb, aa); }
    fillScreen(rr, gg, bb, aa) { this.r.fill(0, 0, this.vw, this.vh, rr, gg, bb, aa); }

    pic(path, x, y, w, h, color = [255, 255, 255, 255], opts) {
        const t = this.game.textures.get(path, opts || { clamp: true, mips: false });
        if (!t.ready || !t.width) return t;
        this.img(t, x, y, w ?? t.width, h ?? t.height, 0, 0, 1, 1, ...color);
        return t;
    }

    text(s, x, y, opts = {}) {
        const g = this.game;
        const font = opts.big ? g.bigFont : g.smallFont;
        const scale = opts.scale || 1;
        const color = opts.color || [255, 255, 255, 255];
        const str = g.strings.t(s);
        if (opts.shadow !== false) font.draw(this, str, x + 1, y + 1, scale, [0, 0, 0, color[3]], opts.center);
        font.draw(this, str, x, y, scale, color, opts.center);
    }

    // used by Font.draw (absolute coordinates already offset)
    image(tex, x, y, w, h, u1, v1, u2, v2, rr, gg, bb, aa) { this.img(tex, x, y, w, h, u1, v1, u2, v2, rr, gg, bb, aa); }

    line(x1, y1, x2, y2, w, rr, gg, bb, aa = 255) {
        const dx = x2 - x1, dy = y2 - y1;
        const l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * w * 0.5, ny = dx / l * w * 0.5;
        const ox = this.ox;
        this.r.ui.quad(this.r.textures.white, [
            [x1 + nx + ox, y1 + ny, 0], [x2 + nx + ox, y2 + ny, 0], [x1 - nx + ox, y1 - ny, 0], [x2 - nx + ox, y2 - ny, 0],
        ], 0, 0, 1, 1, rr, gg, bb, aa, 0);
    }

    drawOverlays() {
        const g = this.game;
        this.drawWeapon();
        if (g.automap.enabled) this.drawAutomap();
        g.hud.draw(this);
        // fades
        const f = g.flashes;
        if (f.damage > 0) this.fillScreen(255, 32, 32, f.damage);
        if (f.pickup > 0) this.fillScreen(32, 32, 255, f.pickup);
        if (f.electrocute > 0) this.fillScreen(32, 255, 32, f.electrocute);
        if (f.teleport > 0) this.fillScreen(0, 255, 8, f.teleport);
        if (g.fade > 0) {
            this.fillScreen(0, 0, 0, g.fade);
            g.fade = Math.max(0, g.fade - 8);
        }
        if (g.fadeOut) this.fillScreen(0, 0, 0, Math.min(255, g.fadeOut.t));
        if (g.debug) {
            const a = g.player.actor;
            this.text(`pos ${a.origin} sec ${a.sector.index} hp ${a.health} objs ${g.objects.length} t ${g.levelTicks}`, -this.ox + 4, 4, { scale: 0.7 });
            if (g.lastError) this.text(g.lastError.slice(0, 90), -this.ox + 4, 14, { scale: 0.7, color: [255, 120, 120, 255] });
        }
    }

    drawLoading() {
        const g = this.game;
        this.fillScreen(0, 0, 0, 255);
        this.pic('gfx/loadback.png', 0, 0, 320, 240);
        const title = g.pendingLevel ? g.mapInfo[g.pendingLevel.index].title : '';
        this.text(title, 160, 104, { big: true, center: true });
        this.text('Loading', 160, 132, { center: true });
    }

    // ------------------------------------------------------------- weapon

    drawWeaponAnim(anim, frameID, light) {
        const g = this.game, p = g.player, w = p.weapon, info = w.info;
        if (!anim) return;
        const frame = anim.frames[Math.min(frameID, anim.frames.length - 1)];
        if (!frame) return;
        for (const s of frame.spriteSet[0]) {
            const atlas = s.atlas;
            if (!atlas) continue;
            const inf = atlas.infos[s.index], tex = atlas.texture;
            if (!inf || !tex.ready || !tex.width) continue;
            let u1 = inf.x / tex.width, u2 = (inf.x + inf.w) / tex.width;
            const v1 = inf.y / tex.height, v2 = (inf.y + inf.h) / tex.height;
            if (s.flipped) { const t = u1; u1 = u2; u2 = t; }
            const x = s.x + w.bobX + info.offsetX + p.actor.roll * 64;
            const y = s.y + w.bobY + info.offsetY + 8;
            const c = frame.fullbright ? 255 : light;
            this.img(tex, x, y, inf.w, inf.h, u1, v1, u2, v2, c, c, c, 255);
        }
    }

    drawWeapon() {
        const g = this.game, p = g.player, w = p.weapon;
        if (!w.anim || !p.actor) return;
        const info = w.info;
        const light = Math.min(255, p.actor.sector.lightLevel << 1);
        const ammo = p.getAmmo(p.currentWeapon);
        const which = ammo <= 0 ? 2 : ammo === 1 ? 1 : 0;
        if (w.state === WS.IDLE && info.flame) {
            const fr = (g.ticks >> 1) % info.flame.frames.length;
            this.drawWeaponAnim(info.flame, fr, 255);
        }
        if (!(w.state === WS.RAISE && info.ammoRaise[which] && which !== 2)) this.drawWeaponAnim(w.anim, w.frameID, light);
        const extra = w.state === WS.IDLE ? info.ammoIdle[which]
            : w.state === WS.RAISE ? info.ammoRaise[which]
                : (w.state === WS.LOWER || w.state === WS.HOLDSTER) ? info.ammoLower[which]
                    : w.state === WS.FIRE ? info.ammoFire[which] : null;
        if (extra) this.drawWeaponAnim(extra, w.frameID, light);
    }

    // ------------------------------------------------------------- automap

    drawAutomap() {
        const g = this.game, w = g.world, pa = g.player.actor;
        const cx = 160, cy = 108;
        const scale = 120 / g.automap.zoom;
        const yaw = pa.yaw;
        const cs = Math.cos(yaw), sn = Math.sin(yaw);
        const tr = (x, y) => {
            const dx = x - pa.origin.x, dy = y - pa.origin.y;
            // rotate so the view direction points up
            const rx = dx * cs - dy * sn;
            const ry = dx * sn + dy * cs;
            return [cx + rx * scale, cy - ry * scale];
        };
        this.fill(-this.ox, 0, this.vw, 216, 0, 0, 0, 96);
        const floorz = pa.floorHeight;
        for (const sector of w.sectors) {
            for (let j = sector.faceStart; j <= sector.faceEnd; ++j) {
                const face = w.faces[j];
                const mapAll = g.automap.mapAll;
                if (((face.flags & FF.HIDDEN) && !mapAll) || (!(face.flags & FF.MAPPED) && !mapAll) ||
                    ((face.flags & FF.PORTAL) && !(face.flags & FF.SOLID))) continue;
                const a = tr(w.vx(face.vertexStart + 2), w.vy(face.vertexStart + 2));
                const b = tr(w.vx(face.vertexStart + 3), w.vy(face.vertexStart + 3));
                if ((a[0] < -200 && b[0] < -200) || (a[0] > 520 && b[0] > 520) || (a[1] < -100 && b[1] < -100) || (a[1] > 340 && b[1] > 340)) continue;
                let col = [255, 255, 255];
                if (!(face.flags & FF.MAPPED)) col = [128, 128, 128];
                else if (face.tag >= 0 && w.events[face.tag]) {
                    const t = w.events[face.tag].type;
                    if (t === 1) col = [255, 32, 255];
                    else if (t >= 3 && t <= 6) col = [255, 255, 32];
                    else if (t >= 200 && t <= 203) col = [0, 255, 255];
                } else if (face.flags & FF.FORCEFIELD) col = [0, 255, 0];
                else {
                    const f = (floorz - w.vz(face.vertexStart + 2)) / 2048;
                    if (f >= 0) col = [255 * (1 - Math.min(1, f)), 255 * (1 - Math.min(1, f)), 255];
                    else col = [255, 255 * (1 - Math.min(1, -f)), 255 * (1 - Math.min(1, -f))];
                }
                this.line(a[0], a[1], b[0], b[1], 0.75, col[0] | 0, col[1] | 0, col[2] | 0, 255);
            }
        }
        // player arrow
        this.line(cx, cy + 5, cx, cy - 6, 1, 255, 255, 255);
        this.line(cx, cy - 6, cx - 3, cy - 2, 1, 255, 255, 255);
        this.line(cx, cy - 6, cx + 3, cy - 2, 1, 255, 255, 255);
    }
}
