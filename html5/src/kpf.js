// KPF archive reader. A .kpf is a plain zip; Exhumed ships it with every
// entry stored (method 0), but deflate is handled too via DecompressionStream.

export class Kpf {
    constructor(buffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
        this.entries = new Map();   // lowercase path -> entry
        this.cache = new Map();
        this.readCentralDirectory();
    }

    readCentralDirectory() {
        const v = this.view;
        let eocd = -1;
        for (let i = v.byteLength - 22; i >= Math.max(0, v.byteLength - 65557); --i) {
            if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('kpf: end of central directory not found');
        const count = v.getUint16(eocd + 10, true);
        let p = v.getUint32(eocd + 16, true);
        const dec = new TextDecoder();
        for (let i = 0; i < count; ++i) {
            if (v.getUint32(p, true) !== 0x02014b50) throw new Error('kpf: bad central entry');
            const method = v.getUint16(p + 10, true);
            const csize = v.getUint32(p + 20, true);
            const usize = v.getUint32(p + 24, true);
            const nlen = v.getUint16(p + 28, true);
            const xlen = v.getUint16(p + 30, true);
            const clen = v.getUint16(p + 32, true);
            const local = v.getUint32(p + 42, true);
            const name = dec.decode(new Uint8Array(this.buffer, p + 46, nlen));
            if (!name.endsWith('/')) {
                this.entries.set(name.toLowerCase(), { name, method, csize, usize, local });
            }
            p += 46 + nlen + xlen + clen;
        }
    }

    has(path) { return this.entries.has(normalize(path)); }

    list(prefix = '') {
        prefix = normalize(prefix);
        const out = [];
        for (const [k, e] of this.entries) if (k.startsWith(prefix)) out.push(e.name);
        return out;
    }

    dataOffset(e) {
        const v = this.view;
        const nlen = v.getUint16(e.local + 26, true);
        const xlen = v.getUint16(e.local + 28, true);
        return e.local + 30 + nlen + xlen;
    }

    // Synchronous access works for stored entries, which is all of them in Exhumed.
    bytes(path) {
        const e = this.entries.get(normalize(path));
        if (!e) return null;
        if (e.method !== 0) throw new Error(`kpf: ${path} is compressed; use bytesAsync`);
        return new Uint8Array(this.buffer, this.dataOffset(e), e.usize);
    }

    async bytesAsync(path) {
        const e = this.entries.get(normalize(path));
        if (!e) return null;
        const raw = new Uint8Array(this.buffer, this.dataOffset(e), e.csize);
        if (e.method === 0) return raw;
        const ds = new DecompressionStream('deflate-raw');
        const out = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
        return new Uint8Array(out);
    }

    text(path) {
        const b = this.bytes(path);
        return b ? new TextDecoder().decode(b).replace(/\r/g, '') : null;
    }

    blob(path, type) {
        const b = this.bytes(path);
        return b ? new Blob([b], { type }) : null;
    }
}

export function normalize(path) {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}
