// PSM map loader. Layout recovered from the shipped .MAP files (see the
// kexWorld::Read* functions in the GPL PowerslaveEX source; the Exhumed
// version adds a "PSM\x01" magic and stores vertices as floats).

export const FF = {
    SOLID: 1 << 0, BLOCKAIFALLERS: 1 << 1, SECRET: 1 << 2, BLOCKAIGROUND: 1 << 3,
    INVISIBLE: 1 << 4, LAVA: 1 << 5, WATER: 1 << 6, SLIME: 1 << 7, TOGGLE: 1 << 8,
    FORCEFIELD: 1 << 9, FULLBRIGHT: 1 << 10, OCCLUDED: 1 << 11, HIDDEN: 1 << 12,
    PORTAL: 1 << 13, UNDERWATER: 1 << 14, MAPPED: 1 << 15, DYNAMIC: 1 << 16, UPDATED: 1 << 17,
};

export const SF = {
    DEBUG: 1 << 0, CLIPPED: 1 << 1, SPECIAL: 1 << 2, PROCESSED: 1 << 3, NOSKYSCISSOR: 1 << 4,
    WATER: 1 << 8,
};

export function parseMap(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    const u8 = () => v.getUint8(p++);
    const u16 = () => { const r = v.getUint16(p, true); p += 2; return r; };
    const s16 = () => { const r = v.getInt16(p, true); p += 2; return r; };
    const u32 = () => { const r = v.getUint32(p, true); p += 4; return r; };
    const f32 = () => { const r = v.getFloat32(p, true); p += 4; return r; };
    const str = () => {
        const n = u16();
        if (n === 0) { u16(); return null; }
        const s = new TextDecoder().decode(bytes.subarray(p, p + n));
        p += n;
        return s;
    };

    let floatVerts = false;
    if (bytes[0] === 0x50 && bytes[1] === 0x53 && bytes[2] === 0x4d) {
        p = 4;
        floatVerts = true;
    }

    const numTextures = u32(), numVertices = u32(), numSectors = u32(), numFaces = u32();
    const numPolys = u32(), numTCoords = u32(), numEvents = u32(), numActors = u32();

    const map = { sky: str(), textures: [] };
    for (let i = 0; i < numTextures; ++i) map.textures.push(str());

    // vertices: xyz + rgba, kept in flat typed arrays for cheap updates
    const vxyz = new Float32Array(numVertices * 3);
    const vrgba = new Uint8Array(numVertices * 4);
    for (let i = 0; i < numVertices; ++i) {
        if (floatVerts) {
            vxyz[i * 3] = f32(); vxyz[i * 3 + 1] = f32(); vxyz[i * 3 + 2] = f32();
        } else {
            vxyz[i * 3] = s16(); vxyz[i * 3 + 1] = s16(); vxyz[i * 3 + 2] = s16();
        }
        vrgba[i * 4] = u8(); vrgba[i * 4 + 1] = u8(); vrgba[i * 4 + 2] = u8(); vrgba[i * 4 + 3] = u8();
    }
    map.vxyz = vxyz;
    map.vrgba = vrgba;

    map.sectors = [];
    for (let i = 0; i < numSectors; ++i) {
        map.sectors.push({
            index: i,
            faceStart: u16(), faceEnd: u16(), lightLevel: u16(),
            ceilingHeight: s16(), floorHeight: s16(),
            ceilingSlope: f32(), floorSlope: f32(),
            flags: u16(),
            event: -1, linkedSector: -1, objectThinker: null,
            bounds: { min: [0, 0, 0], max: [0, 0, 0] },
            actors: new Set(), floodCount: 0, validcount: -1,
        });
    }

    map.faces = [];
    for (let i = 0; i < numFaces; ++i) {
        map.faces.push({
            index: i,
            polyStart: s16(), polyEnd: s16(), vertexStart: u16(), sector: s16(),
            angle: f32(),
            plane: [f32(), f32(), f32(), 0],
            flags: u16(), tag: s16(), vertStart: u16(), vertEnd: u16(),
            sectorOwner: -1, validcount: -1,
            bounds: { min: [0, 0, 0], max: [0, 0, 0] },
            edgeFlags: [0, 0, 0, 0],
        });
    }

    map.polys = [];
    for (let i = 0; i < numPolys; ++i) {
        map.polys.push({
            indices: [u8(), u8(), u8(), u8()],
            tcoords: [s16(), s16(), s16(), s16()],
            texture: s16(), flipped: s16(), faceRef: -1,
        });
    }

    // texcoords are addressed as a flat uv array (poly.tcoords index uv pairs)
    map.uv = new Float32Array(numTCoords * 8);
    for (let i = 0; i < numTCoords * 8; ++i) map.uv[i] = f32();

    map.events = [];
    for (let i = 0; i < numEvents; ++i) {
        map.events.push({ index: i, type: s16(), sector: s16(), tag: s16(), params: s16() });
    }

    map.actors = [];
    for (let i = 0; i < numActors; ++i) {
        map.actors.push({
            index: i, type: s16(), sector: s16(), x: s16(), y: s16(), z: s16(),
            tag: s16(), params1: s16(), params2: s16(), angle: f32(),
        });
    }

    if (p !== bytes.byteLength) {
        console.warn(`map: ${bytes.byteLength - p} trailing bytes`);
    }

    // ownership links
    for (const s of map.sectors) {
        for (let j = s.faceStart; j < s.faceEnd + 3; ++j) map.faces[j].sectorOwner = s.index;
    }
    for (const f of map.faces) {
        if (f.polyStart < 0 || f.polyEnd < 0 || f.sectorOwner < 0) continue;
        for (let j = f.polyStart; j <= f.polyEnd; ++j) map.polys[j].faceRef = f.index;
    }
    return map;
}
