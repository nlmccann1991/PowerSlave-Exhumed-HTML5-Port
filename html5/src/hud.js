// Status bar, messages and air supply. Port of kexHud (game/hud.cpp), drawn
// in the 320x240 virtual screen.

import { AF, PAB, WS } from './actorflags.js';
import { MAX_HEALTH } from './player.js';

const MAXMESSAGES = 4;

export class Hud {
    constructor(game) {
        this.game = game;
        this.reset();
        this.airOffset = -300;
    }

    reset() {
        this.currentHealth = 0;
        this.messages = [];
    }

    addMessage(msg) {
        this.messages.unshift({ msg, ticks: 300 });
        if (this.messages.length > MAXMESSAGES) this.messages.length = MAXMESSAGES;
    }

    update() {
        for (const m of this.messages) if (m.ticks > 0) m.ticks--;
        this.messages = this.messages.filter((m) => m.ticks > 0);
    }

    draw(d) {
        const g = this.game, p = g.player, a = p.actor;
        const tex = g.textures;
        const back = tex.get('gfx/hud.png', { clamp: true, mips: false });
        const fillPic = tex.get('gfx/menu/menu_bg.png', { clamp: false, mips: false });
        // fill strip across the whole width
        if (fillPic.ready && fillPic.width) {
            const x0 = -d.ox, w = d.vw;
            d.img(fillPic, x0, 216, w, 32, 0, 0, w / fillPic.width, 32 / fillPic.height);
        }
        d.fill(-d.ox, 216, d.vw, 1, 156, 100, 70, 255);
        d.fill(-d.ox, 217, d.vw, 1, 80, 40, 10, 255);
        // ammo bar
        const wi = g.weaponInfo[p.pendingWeapon];
        const ammoW = wi.maxAmmo > 0 ? p.getAmmo(p.pendingWeapon) / wi.maxAmmo : 1;
        d.fill(52, 222, 88 * ammoW, 8, 32, 32, 255, 255);
        d.fill(52, 222, 88 * ammoW, 1, 8, 8, 64, 255);
        // health bar (wraps every 200 like the original)
        this.currentHealth = (a.health - this.currentHealth) * 0.125 + this.currentHealth;
        let hw = (this.currentHealth % MAX_HEALTH) / MAX_HEALTH;
        if (a.health > 0 && a.health % MAX_HEALTH === 0 && Math.abs(this.currentHealth - a.health) < 1) hw = 1;
        d.fill(193, 222, 88 * Math.max(0, hw), 8, 255, 32, 32, 255);
        d.fill(193, 222, 88 * Math.max(0, hw), 1, 64, 8, 8, 255);
        if (!back.ready || !back.width) return;
        // frame pieces
        d.img(back, 0, 192, 64, 64, 0, 0, 0.25, 1);
        d.img(back, 64, 216, 96, 24, 0.25, 0, 0.625, 0.375);
        d.img(back, 160, 216, 96, 24, 0.25, 0.375, 0.625, 0.75);
        d.img(back, 256, 192, 64, 64, 0.625, 0, 0.875, 1);
        this.drawCompass(d, back);
        this.drawDots(d, back);
        this.drawAirSupply(d);
        this.drawAbilities(d);
        // messages
        let y = 24;
        const pulse = (Math.sin(g.levelTicks * 0.1) * 64 + 191) | 0;
        for (const m of this.messages) {
            d.text(m.msg, 160, y, { center: true, color: [pulse, pulse, pulse, 255] });
            y += 10;
        }
        if (g.settings.crosshair && ![WS.HOLDSTER, WS.RAISE, WS.LOWER].includes(p.weapon.state)) {
            d.fill(159, 107, 2, 6, 255, 255, 255, 128);
            d.fill(157, 109, 6, 2, 255, 255, 255, 128);
        }
    }

    drawCompass(d, back) {
        const a = this.game.player.actor;
        const tw = back.width, th = back.height;
        let u1 = 225 / tw, u2 = 1, v1 = 0, v2 = 22 / th;
        const angle = a.yaw * 180 / Math.PI;
        let x = 146;
        const y = 217;
        const flip = () => { const t = u1; u1 = u2; u2 = t; x -= 4; };
        if (angle >= 22.5 && angle < 67.5) { v1 = 21 / th; v2 = 43 / th; }
        else if (angle >= 67.5 && angle < 112.5) { v1 = 42 / th; v2 = 64 / th; }
        else if (angle >= 112.5 && angle < 157.5) { v2 = 21 / th; v1 = 43 / th; }
        else if (angle >= 157.5 || angle <= -157.5) { v2 = 0; v1 = 22 / th; }
        else if (angle >= -157.5 && angle < -112.5) { v2 = 21 / th; v1 = 43 / th; flip(); }
        else if (angle >= -112.5 && angle < -67.5) { v2 = 42 / th; v1 = 64 / th; flip(); }
        else if (angle >= -67.5 && angle < -22.5) { v1 = 21 / th; v2 = 43 / th; flip(); }
        d.img(back, x, y, 31, 22, u1, v1, u2, v2);
    }

    drawDots(d, back) {
        const g = this.game, p = g.player;
        const tw = back.width, th = back.height;
        const dot = (x, y, red, on) => {
            const v1 = 48 / th, v2 = 54 / th;
            let u1, u2;
            if (!on) { u1 = 136 / tw; u2 = 146 / tw; }
            else if (!red) { u1 = 146 / tw; u2 = 156 / tw; }
            else { u1 = 156 / tw; u2 = 166 / tw; }
            d.img(back, x, y, 9, 6, u1, v1, u2, v2);
        };
        for (let i = 0; i < 8; ++i) if (p.weaponOwned(i)) dot(55 + 10 * i, 228, false, p.pendingWeapon === i);
        for (let i = 0; i < p.ankahs; ++i) dot(196 + 10 * i, 228, true, p.actor.health >= MAX_HEALTH * (i + 1));
    }

    drawAirSupply(d) {
        const g = this.game, p = g.player;
        const front = g.textures.get('gfx/airsupply_front.png', { clamp: true, mips: false });
        const backPic = g.textures.get('gfx/airsupply_back.png', { clamp: true, mips: false });
        if (!(p.actor.flags & AF.INWATER)) this.airOffset = (-300 - this.airOffset) * 0.08 + this.airOffset;
        else this.airOffset = (116 - this.airOffset) * 0.25 + this.airOffset;
        if (this.airOffset < -250 || !front.ready || !backPic.ready) return;
        let w = backPic.width, h = backPic.height;
        d.img(backPic, 272 - w * 0.5, (this.airOffset - 64) - h * 0.5, w, h, 0, 0, 1, 1, 255, 255, 255, 224);
        const s = p.airSupply / 64;
        w = front.width * s; h = front.height * s;
        d.img(front, 272 - w * 0.5, (this.airOffset - 64) - h * 0.5, w, h, 0, 0, 1, 1, 255, 255, 255, 224);
    }

    drawAbilities(d) {
        const p = this.game.player;
        if (!p.abilities) return;
        if (p.abilities & PAB.DOLPHIN) d.pic('gfx/dolphin.png', 25, 12);
        if (p.abilities & PAB.VULTURE) d.pic('gfx/vulture.png', 52, 12);
    }
}
