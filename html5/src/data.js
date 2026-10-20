// Game data sources. The port never ships game files: it reads the player's
// own PowerSlave Exhumed install, either over HTTP (page served from inside
// the game folder) or from a folder picked in the browser (cached in IndexedDB).

import { Kpf } from './kpf.js';

const DB_NAME = 'psx-exhumed-data';
const EXE_NAME = 'anubis_Shipping_Galaxy_x64.exe';

function idb() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

async function idbGet(key) {
    try {
        const db = await idb();
        return await new Promise((resolve) => {
            const tx = db.transaction('files', 'readonly');
            const q = tx.objectStore('files').get(key);
            q.onsuccess = () => resolve(q.result || null);
            q.onerror = () => resolve(null);
        });
    } catch (_) { return null; }
}

async function idbPut(key, value) {
    try {
        const db = await idb();
        await new Promise((resolve) => {
            const tx = db.transaction('files', 'readwrite');
            tx.objectStore('files').put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
    } catch (_) { /* quota or private mode */ }
}

export async function clearCache() {
    try {
        const db = await idb();
        await new Promise((resolve) => {
            const tx = db.transaction('files', 'readwrite');
            tx.objectStore('files').clear();
            tx.oncomplete = resolve;
        });
    } catch (_) { /* ignore */ }
}

async function fetchWithProgress(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.set(value, got);
        got += value.length;
        onProgress?.(got / total);
    }
    return out.buffer;
}

export class DataSource {
    constructor() {
        this.kpf = null;
        this.files = null;     // Map(lowercase relative path -> Blob) for folder mode
        this.baseURL = null;   // for HTTP mode
        this.urlCache = new Map();
    }

    // HTTP mode: base URL of the game folder.
    async fromURL(base, onProgress) {
        this.baseURL = base.endsWith('/') ? base : base + '/';
        const buf = await fetchWithProgress(this.baseURL + 'PowerslaveEX.kpf', onProgress);
        this.kpf = new Kpf(buf);
        return this;
    }

    // Folder mode from <input webkitdirectory> FileList.
    async fromFiles(fileList, onProgress) {
        const files = new Map();
        for (const f of fileList) {
            const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
            const parts = rel.split('/');
            // strip the picked folder name
            const key = (parts.length > 1 ? parts.slice(1).join('/') : rel).toLowerCase();
            files.set(key, f);
            files.set(f.name.toLowerCase(), files.get(f.name.toLowerCase()) || f);
        }
        const kpfFile = files.get('powerslaveex.kpf');
        if (!kpfFile) throw new Error('PowerslaveEX.kpf not found in the selected folder');
        onProgress?.(0.1);
        const buf = await kpfFile.arrayBuffer();
        onProgress?.(0.9);
        this.kpf = new Kpf(buf);
        this.files = new Map();
        for (const [k, f] of files) if (k.startsWith('music/') || k.startsWith('movies/')) this.files.set(k, f);
        const exe = files.get(EXE_NAME.toLowerCase());
        if (exe) this.files.set(EXE_NAME.toLowerCase(), exe);
        // cache for next visit
        await idbPut('kpf', kpfFile);
        const media = {};
        for (const [k, f] of this.files) if (k.startsWith('music/')) media[k] = f;
        await idbPut('media', media);
        onProgress?.(1);
        return this;
    }

    async fromCache() {
        const blob = await idbGet('kpf');
        if (!blob) return null;
        this.kpf = new Kpf(await blob.arrayBuffer());
        const media = (await idbGet('media')) || {};
        this.files = new Map(Object.entries(media));
        return this;
    }

    async musicURL(name) {
        const key = `music/${name.toLowerCase()}`;
        if (this.urlCache.has(key)) return this.urlCache.get(key);
        let url = null;
        if (this.files && this.files.has(key)) url = URL.createObjectURL(this.files.get(key));
        else if (this.baseURL) url = this.baseURL + 'music/' + name;
        this.urlCache.set(key, url);
        return url;
    }

    // The game's exe, read only for the credits text. Null when it isn't reachable
    // (e.g. a cached session started from the folder picker).
    async exeBytes() {
        try {
            if (this.files && this.files.has(EXE_NAME.toLowerCase())) {
                return new Uint8Array(await this.files.get(EXE_NAME.toLowerCase()).arrayBuffer());
            }
            if (this.baseURL) {
                const res = await fetch(this.baseURL + EXE_NAME);
                if (res.ok) return new Uint8Array(await res.arrayBuffer());
            }
        } catch (_) { /* fall through */ }
        return null;
    }

    movieURL(name) {
        const key = `movies/${name.toLowerCase()}`;
        if (this.files && this.files.has(key)) return URL.createObjectURL(this.files.get(key));
        if (this.baseURL) return this.baseURL + 'movies/' + name;
        return null;
    }

    // Candidate files for a cutscene, best first. The game ships Theora (.ogv), which
    // Chromium browsers no longer play, so WebM copies made by tools/convert-movies.sh
    // are preferred. Movies without a language suffix (the logos) are tried as-is too.
    movieCandidates(base, lang) {
        const v = document.createElement('video');
        const exts = [];
        if (v.canPlayType('video/webm; codecs="vp9, opus"') || v.canPlayType('video/webm; codecs="av01.0.05M.08, opus"')) exts.push('webm');
        if (v.canPlayType('video/ogg; codecs="theora, vorbis"')) exts.push('ogv');
        const names = [...new Set([`${base}-${lang}`, `${base}-en`, base])];
        const out = [];
        for (const ext of exts) {
            for (const n of names) {
                const file = `${n}.${ext}`;
                // in folder mode we know exactly which files exist
                if (this.files && !this.files.has(`movies/${file.toLowerCase()}`)) continue;
                const url = this.movieURL(file);
                if (url) out.push(url);
            }
        }
        return out;
    }

    // Plays a cutscene full screen; resolves when done, skipped or when nothing playable exists.
    playMovie(base, lang = 'en') {
        return new Promise((resolve) => {
            const urls = this.movieCandidates(base, lang);
            if (!urls.length) { resolve(); return; }
            const v = document.createElement('video');
            v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;background:#000;z-index:10;object-fit:contain';
            v.autoplay = true;
            let i = 0;
            const done = () => { v.remove(); removeEventListener('keydown', done); resolve(); };
            // a missing or undecodable file moves on to the next candidate
            const next = () => {
                if (i >= urls.length) { done(); return; }
                v.src = urls[i++];
                // load failures arrive through onerror; a blocked autoplay just plays muted
                v.play().catch((e) => { if (e.name === 'NotAllowedError') { v.muted = true; v.play().catch(() => {}); } });
            };
            v.onended = done;
            v.onerror = next;
            v.onclick = done;
            addEventListener('keydown', done);
            document.body.appendChild(v);
            next();
        });
    }
}
