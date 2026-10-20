// Boot: locate game data, then start the game.

import { DataSource } from './data.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; };
const progress = (f) => { $('bar').style.width = `${Math.round(f * 100)}%`; };
const params = new URLSearchParams(location.search);

async function start(data) {
    status('Starting…');
    const game = new Game($('screen'), data);
    window.game = game;
    game.debug = params.has('debug');
    game.noPortalVis = params.has('novis');
    addEventListener('error', (e) => { game.lastError = String(e.message); });
    const origError = console.error.bind(console);
    console.error = (...a) => { game.lastError = a.map((x) => (x && x.stack) || String(x)).join(' '); origError(...a); };
    await game.init((step) => status(`Loading ${step}…`));
    if (params.has('map')) {
        const idx = Number(params.get('map'));
        game.menus.clear();
        game.player.reset();
        if (params.has('allweapons')) for (let w = 0; w < 8; ++w) game.player.giveWeapon(w, false);
        let warp = null;
        if (params.has('warp')) {
            const [x, y, z] = params.get('warp').split(',').map(Number);
            const { Vec3 } = await import('./math.js');
            warp = new Vec3(x, y, z);
            game.warpYaw = params.has('yaw') ? Number(params.get('yaw')) * Math.PI / 180 : null;
        }
        game.startMap(idx, warp);
    } else if (params.has('overworld')) {
        // e.g. ?overworld=1&unlock=0,1,3,5
        game.player.reset();
        game.selectedMap = Number(params.get('overworld'));
        game.mapUnlocks[game.selectedMap] = true;
        for (const i of (params.get('unlock') || '').split(',').filter(Boolean)) game.mapUnlocks[Number(i)] = true;
        game.menus.openOverworld();
    }
    if (params.has('movie')) game.data.playMovie(params.get('movie'), game.movieLang());
    if (params.has('test')) {
        // e.g. ?test=forward:120,use:5,turnleft:40,attack:30
        game.input.scripted = params.get('test').split(',').map((t) => {
            const [action, n] = t.split(':');
            return { action, ticks: Number(n) || 1 };
        });
        if (params.has('god')) game.godMode = true;
    }
    $('boot').classList.add('hidden');
    $('hint').textContent = 'Click the game to capture the mouse. Esc for menu.';
    setTimeout(() => { $('hint').textContent = ''; }, 8000);
}

async function boot() {
    const data = new DataSource();
    // 1) served from inside the game folder (or ?data=<url>)
    const base = params.get('data') || '../';
    try {
        const head = await fetch(base + 'PowerslaveEX.kpf', { method: 'HEAD' });
        if (head.ok) {
            status('Loading PowerslaveEX.kpf…');
            await data.fromURL(base, progress);
            await start(data);
            return;
        }
    } catch (_) { /* not available over HTTP */ }
    // 2) cached from a previous folder pick
    status('Checking browser cache…');
    if (await data.fromCache()) {
        progress(1);
        await start(data);
        return;
    }
    // 3) ask the player
    status('Game data not found.');
    $('pick').style.display = '';
    const onFiles = async (files) => {
        try {
            $('err').textContent = '';
            status('Reading game data…');
            await data.fromFiles(files, progress);
            await start(data);
        } catch (e) {
            $('err').textContent = String(e.message || e);
        }
    };
    $('folder').addEventListener('change', (e) => onFiles(e.target.files));
    $('kpffile').addEventListener('change', (e) => onFiles(e.target.files));
}

boot().catch((e) => {
    console.error(e);
    $('err').textContent = String(e.stack || e.message || e);
});
