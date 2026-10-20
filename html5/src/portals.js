// Portal visibility: which sectors can be seen from the camera. Port of
// kexRenderScene::FindVisibleSectors (renderer/renderPortal.cpp). Starting in the
// camera's sector, the flood walks through portal faces whose screen rectangle
// overlaps the rectangle the current sector was seen through, narrowing it as it
// goes. Only the sectors reached are drawn, as in the original engine. PowerSlave
// maps rely on this: rooms overlap and their tops are often unmodelled, so drawing
// every sector shows interiors (seen from above, with their ceilings culled) where
// the original shows sky or the room that is actually in front.

import { FF } from './mapfile.js';

export class PortalVis {
    constructor(world) {
        this.world = world;
        const n = world.sectors.length;
        this.visible = new Uint8Array(n);
        this.list = [];
        this.rect = new Float32Array(n * 4);   // x1 y1 x2 y2 in NDC, per sector
        this.queued = new Uint8Array(n);
        this.queue = [];
        this.pts = new Float32Array(8 * 4);
        this.serial = 0;                      // bumped when the visible set changes
    }

    // Screen rectangle (NDC) of a face's 4 corners, clipped to the near plane.
    // Returns false when it's entirely behind the camera or off screen.
    faceRect(face, m, out) {
        const x = this.world.vxyz, P = this.pts;
        let n = 0;
        for (let j = 0; j < 4; ++j) {
            const v = (face.vertexStart + j) * 3;
            const px = x[v], py = x[v + 1], pz = x[v + 2];
            const o = j * 4;
            P[o] = m[0] * px + m[4] * py + m[8] * pz + m[12];
            P[o + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
            P[o + 3] = m[3] * px + m[7] * py + m[11] * pz + m[15];
        }
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        const near = 1e-3;
        const add = (cx, cy, w) => {
            const sx = cx / w, sy = cy / w;
            if (sx < x1) x1 = sx; if (sx > x2) x2 = sx;
            if (sy < y1) y1 = sy; if (sy > y2) y2 = sy;
            n++;
        };
        for (let j = 0; j < 4; ++j) {
            const a = j * 4, b = ((j + 1) & 3) * 4;
            const wa = P[a + 3], wb = P[b + 3];
            if (wa > near) add(P[a], P[a + 1], wa);
            if ((wa > near) !== (wb > near)) {
                const t = (near - wa) / (wb - wa);
                add(P[a] + (P[b] - P[a]) * t, P[a + 1] + (P[b + 1] - P[a + 1]) * t, near);
            }
        }
        if (n < 2) return false;
        if (x1 < -1) x1 = -1; if (x2 > 1) x2 = 1;
        if (y1 < -1) y1 = -1; if (y2 > 1) y2 = 1;
        if (x1 >= x2 || y1 >= y2) return false;
        out[0] = x1; out[1] = y1; out[2] = x2; out[3] = y2;
        return true;
    }

    update(mvp, origin, start) {
        const w = this.world, R = this.rect, vis = this.visible;
        const prev = this.list;
        for (const s of prev) vis[s] = 0;
        const list = [];
        if (!start) { this.list = list; this.serial++; return; }
        const q = this.queue;
        q.length = 0;
        const si = start.index;
        vis[si] = 1; list.push(si);
        R[si * 4] = -1; R[si * 4 + 1] = -1; R[si * 4 + 2] = 1; R[si * 4 + 3] = 1;
        q.push(si); this.queued[si] = 1;
        const fr = new Float32Array(4);
        for (let qi = 0; qi < q.length; ++qi) {
            const s = w.sectors[q[qi]];
            this.queued[s.index] = 0;
            const so = s.index * 4;
            for (let i = s.faceStart; i < s.faceEnd + 3; ++i) {
                const face = w.faces[i];
                if (face.sector < 0 || !(face.flags & FF.PORTAL)) continue;
                const n = face.plane;
                const dist = n[0] * origin.x + n[1] * origin.y + n[2] * origin.z - n[3];
                const isWall = i <= s.faceEnd;
                // (the GPL code also skips wall portals the camera is behind; that hides
                // rooms seen through openings of non-convex sectors, so it isn't done here)
                const next = w.sectors[face.sector];
                const nb = next.bounds;
                if (nb.max[2] <= nb.min[2]) continue; // closed door
                // standing in (or right next to) the opening: it covers the whole view
                if ((face.flags & FF.WATER) || dist <= 0.5 || (!isWall && dist < 64)) {
                    fr[0] = -1; fr[1] = -1; fr[2] = 1; fr[3] = 1;
                } else if (!this.faceRect(face, mvp, fr)) {
                    continue;
                }
                // what of the opening shows through the rectangle this sector was seen in
                const tx1 = Math.max(fr[0], R[so]), ty1 = Math.max(fr[1], R[so + 1]);
                const tx2 = Math.min(fr[2], R[so + 2]), ty2 = Math.min(fr[3], R[so + 3]);
                if (tx1 >= tx2 || ty1 >= ty2) continue;
                const ni = next.index, no = ni * 4;
                let grew = false;
                if (!vis[ni]) {
                    vis[ni] = 1; list.push(ni);
                    R[no] = tx1; R[no + 1] = ty1; R[no + 2] = tx2; R[no + 3] = ty2;
                    grew = true;
                } else {
                    if (tx1 < R[no]) { R[no] = tx1; grew = true; }
                    if (ty1 < R[no + 1]) { R[no + 1] = ty1; grew = true; }
                    if (tx2 > R[no + 2]) { R[no + 2] = tx2; grew = true; }
                    if (ty2 > R[no + 3]) { R[no + 3] = ty2; grew = true; }
                }
                if (grew && !this.queued[ni]) { this.queued[ni] = 1; q.push(ni); }
            }
            if (q.length > 20000) break; // safety net against pathological maps
        }
        for (const i of q) this.queued[i] = 0;
        let same = list.length === prev.length;
        if (same) {
            const a = list.slice().sort((x, y) => x - y), b = prev.slice().sort((x, y) => x - y);
            for (let i = 0; i < a.length && same; ++i) same = a[i] === b[i];
        }
        this.list = list;
        if (!same) this.serial++;
    }
}
