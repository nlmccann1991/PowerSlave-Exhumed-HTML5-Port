// The credits roll. Its text isn't in the kpf: the remaster keeps it in the exe as a static
// table in .data of 40-byte entries (a text pointer, then the line's scroll interpolant),
// drawn by game state 8 (setup 0x1401af9d0, tick 0x1401afe90, draw 0x1401b06d0).
// The table is read from the player's own anubis_Shipping_Galaxy_x64.exe at runtime.

const FIRST_LINE = '-- Nightdive Studios --';
const ENTRY_SIZE = 40;

// Returns the credit lines ('' for spacing), or null if the exe doesn't look like the remaster's.
export function parseCredits(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint16(0, true) !== 0x5a4d) return null; // MZ
    const pe = dv.getUint32(0x3c, true);
    if (dv.getUint32(pe, true) !== 0x4550) return null; // PE\0\0
    const nsec = dv.getUint16(pe + 6, true);
    const optSize = dv.getUint16(pe + 20, true);
    const imageBase = Number(dv.getBigUint64(pe + 24 + 24, true));
    const sections = [];
    for (let i = 0, o = pe + 24 + optSize; i < nsec; ++i, o += 40) {
        sections.push({
            va: dv.getUint32(o + 12, true), rawSize: dv.getUint32(o + 16, true), raw: dv.getUint32(o + 20, true),
        });
    }
    const vaToOffset = (va) => {
        const rva = va - imageBase;
        for (const s of sections) if (rva >= s.va && rva < s.va + s.rawSize) return s.raw + rva - s.va;
        return -1;
    };
    const offsetToVA = (off) => {
        for (const s of sections) if (off >= s.raw && off < s.raw + s.rawSize) return imageBase + s.va + off - s.raw;
        return -1;
    };
    const find = (needle, from = 0) => {
        outer: for (let i = from; i <= bytes.length - needle.length; ++i) {
            if (bytes[i] !== needle[0]) continue;
            for (let j = 1; j < needle.length; ++j) if (bytes[i + j] !== needle[j]) continue outer;
            return i;
        }
        return -1;
    };

    const strOff = find(new TextEncoder().encode(FIRST_LINE + '\0'));
    if (strOff < 0) return null;
    const strVA = offsetToVA(strOff);
    const ptr = new Uint8Array(8);
    new DataView(ptr.buffer).setBigUint64(0, BigInt(strVA), true);
    const table = find(ptr);
    if (table < 0) return null;

    const dec = new TextDecoder('utf-8');
    const lines = [];
    // every line's interpolant shares one vtable; the table ends where that stops
    const vtable = dv.getBigUint64(table + 16, true);
    for (let o = table; o + ENTRY_SIZE <= bytes.length; o += ENTRY_SIZE) {
        if (dv.getBigUint64(o + 16, true) !== vtable) break;
        const s = vaToOffset(Number(dv.getBigUint64(o, true)));
        if (s < 0) break;
        let e = s;
        while (e < bytes.length && bytes[e] !== 0) e++;
        lines.push(dec.decode(bytes.subarray(s, e)));
    }
    // trailing blank lines pad the end of the roll; they're kept so the timing matches
    return lines.length ? lines : null;
}
