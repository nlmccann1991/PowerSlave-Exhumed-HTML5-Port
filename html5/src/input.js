// Keyboard, mouse (pointer lock) and gamepad input mapped to player commands,
// using the bindings from the remaster's default.cfg.

import { BC } from './actorflags.js';

const DEFAULT_BINDS = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'backward', ArrowDown: 'backward',
    KeyA: 'strafeleft', KeyD: 'straferight',
    ArrowLeft: 'turnleft', ArrowRight: 'turnright',
    Space: 'jump', KeyE: '+use', KeyF: '+use',
    ControlLeft: 'attack', ControlRight: 'attack',
    Tab: 'automap', ShiftLeft: 'inventory', KeyI: 'inventory',
    Equal: 'mapzoomin', Minus: 'mapzoomout',
    BracketLeft: '+weapprev', BracketRight: '+weapnext',
    Digit1: 'weapon0', Digit2: 'weapon1', Digit3: 'weapon2', Digit4: 'weapon3',
    Digit5: 'weapon4', Digit6: 'weapon5', Digit7: 'weapon6', Digit8: 'weapon7',
    Escape: 'menu',
};

const NAV_ALIASES = { KeyW: 'nav_ArrowUp', KeyS: 'nav_ArrowDown', KeyA: 'nav_ArrowLeft', KeyD: 'nav_ArrowRight', Space: 'nav_Enter', KeyE: 'nav_Enter' };

const ACTION_BUTTONS = {
    forward: BC.FORWARD, backward: BC.BACKWARD, strafeleft: BC.STRAFELEFT, straferight: BC.STRAFERIGHT,
    turnleft: BC.LEFT, turnright: BC.RIGHT, jump: BC.JUMP, attack: BC.ATTACK, '+use': BC.USE,
    '+weapnext': BC.WEAPONRIGHT, '+weapprev': BC.WEAPONLEFT, mapzoomin: BC.MAPZOOMIN, mapzoomout: BC.MAPZOOMOUT,
};

export class Input {
    constructor(game, canvas) {
        this.game = game;
        this.canvas = canvas;
        this.binds = { ...DEFAULT_BINDS };
        this.down = new Set();          // currently held actions
        this.pressed = [];              // one-shot action events for this tick
        this.mouseDX = 0;
        this.mouseDY = 0;
        this.mouseButtons = 0;
        this.wheel = 0;
        this.turnLerp = [0, 0];
        this.history = [[0, 0], [0, 0], [0, 0], [0, 0]];
        this.historyCount = 0;
        this.pad = null;
        this.padPrev = [];
        this.sensitivity = 5;
        this.invertY = false;

        addEventListener('keydown', (e) => this.onKey(e, true));
        addEventListener('keyup', (e) => this.onKey(e, false));
        canvas.addEventListener('mousedown', (e) => {
            this.game.sound.unlock();
            if (!document.pointerLockElement && this.game.wantsPointerLock()) {
                canvas.requestPointerLock?.();
            }
            this.mouseButtons |= 1 << e.button;
            if (e.button === 0) this.press('attack', true);
            if (e.button === 2) this.press('+use', true);
            this.game.onMouseClick?.(e);
        });
        addEventListener('mouseup', (e) => {
            this.mouseButtons &= ~(1 << e.button);
            if (e.button === 0) this.press('attack', false);
            if (e.button === 2) this.press('+use', false);
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        addEventListener('mousemove', (e) => {
            if (document.pointerLockElement === canvas) {
                this.mouseDX += e.movementX;
                this.mouseDY += e.movementY;
            }
            this.game.onMouseMove?.(e);
        });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.pressed.push(e.deltaY > 0 ? '+weapnext' : '+weapprev');
        }, { passive: false });
        addEventListener('blur', () => { this.down.clear(); this.mouseButtons = 0; });
    }

    onKey(e, isDown) {
        if (e.repeat && isDown) {
            const a = this.binds[e.code];
            if (a && a.startsWith('menu')) this.pressed.push(a);
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.pressed.push(`nav_${e.code}`);
            e.preventDefault();
            return;
        }
        if (isDown) this.game.sound.unlock();
        const a = this.binds[e.code];
        if (isDown) this.game.onKey?.(e);
        if (isDown && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Backspace'].includes(e.code)) {
            this.pressed.push(`nav_${e.code}`);
        }
        if (isDown && this.game.menus && this.game.menus.active && NAV_ALIASES[e.code]) this.pressed.push(NAV_ALIASES[e.code]);
        if (!a) return;
        if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
        this.press(a, isDown);
    }

    press(action, isDown) {
        if (isDown) {
            if (!this.down.has(action)) this.pressed.push(action);
            this.down.add(action);
        } else {
            this.down.delete(action);
        }
    }

    consumePressed() {
        const p = this.pressed;
        this.pressed = [];
        return p;
    }

    pollGamepad() {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        this.pad = null;
        for (const p of pads) if (p && p.connected) { this.pad = p; break; }
        if (!this.pad) return;
        const b = this.pad.buttons.map((x) => x.pressed);
        const edge = (i, action) => {
            if (b[i] && !this.padPrev[i]) { this.pressed.push(action); this.down.add(action); }
            if (!b[i] && this.padPrev[i]) this.down.delete(action);
        };
        edge(0, 'jump');       // A / cross
        edge(2, '+use');       // X / square
        edge(7, 'attack');     // RT
        edge(6, 'attack');     // LT
        edge(5, '+weapnext');
        edge(4, '+weapprev');
        edge(9, 'menu');       // start
        if (b[9] && !this.padPrev[9] && this.game.menus && this.game.menus.active) this.pressed.push('nav_Escape');
        edge(8, 'automap');    // back/select
        edge(3, 'inventory');  // Y
        edge(12, 'nav_ArrowUp'); edge(13, 'nav_ArrowDown'); edge(14, 'nav_ArrowLeft'); edge(15, 'nav_ArrowRight');
        if (b[0] && !this.padPrev[0]) this.pressed.push('nav_Enter');
        if (b[1] && !this.padPrev[1]) this.pressed.push('nav_Escape');
        this.padPrev = b;
    }

    // Builds the per-tick player command (kexPlayerCmd::BuildCommands).
    buildCmd(cmd, allowLook = true) {
        cmd.reset();
        for (const a of this.down) if (ACTION_BUTTONS[a]) cmd.buttons |= ACTION_BUTTONS[a];
        // scripted input used by automated browser tests (?test=...)
        if (this.scripted && this.scripted.length) {
            const step = this.scripted[0];
            if (ACTION_BUTTONS[step.action]) cmd.buttons |= ACTION_BUTTONS[step.action];
            if (/^weapon\d$/.test(step.action)) this.game.player.selectWeapon(Number(step.action[6]));
            if (step.action === 'lookleft') this.mouseDX -= 6;
            if (step.action === 'lookright') this.mouseDX += 6;
            if (step.action === 'lookup') this.mouseDY -= 4;
            if (step.action === 'lookdown') this.mouseDY += 4;
            if (--step.ticks <= 0) this.scripted.shift();
            allowLook = true;
        }
        for (const a of this.pressedThisTick || []) {
            if (a === '+weapnext') cmd.buttons |= BC.WEAPONRIGHT;
            if (a === '+weapprev') cmd.buttons |= BC.WEAPONLEFT;
        }
        // keyboard turning with acceleration
        const tl = this.turnLerp;
        tl[0] = (cmd.buttons & BC.LEFT) ? (0.078125 - tl[0]) * 0.05 + tl[0] : (Math.abs(tl[0] * 0.85) <= 0.005 ? 0 : tl[0] * 0.85);
        tl[1] = (cmd.buttons & BC.RIGHT) ? (0.078125 - tl[1]) * 0.05 + tl[1] : (Math.abs(tl[1] * 0.85) <= 0.005 ? 0 : tl[1] * 0.85);
        let ax = 0, ay = 0;
        if (allowLook) {
            ax = (this.mouseDX * this.sensitivity) / 2048 * 0.5;
            ay = (this.mouseDY * this.sensitivity) / 2048 * 0.5;
            if (this.invertY) ay = -ay;
        }
        this.mouseDX = this.mouseDY = 0;
        cmd.angles[0] = ax - tl[0] + tl[1];
        cmd.angles[1] = ay;
        if (this.pad) {
            const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
            const ax0 = this.pad.axes;
            cmd.movement[0] = -dz(ax0[1] || 0);
            cmd.movement[1] = dz(ax0[0] || 0);
            cmd.angles[0] += dz(ax0[2] || 0) * 0.06;
            cmd.angles[1] += dz(ax0[3] || 0) * 0.04;
        }
        return cmd;
    }

    rumble(_name, _loop) {
        if (this.pad && this.pad.vibrationActuator) {
            this.pad.vibrationActuator.playEffect('dual-rumble', { duration: 120, strongMagnitude: 0.4, weakMagnitude: 0.4 }).catch(() => {});
        }
    }

    stopRumble() {}
}
