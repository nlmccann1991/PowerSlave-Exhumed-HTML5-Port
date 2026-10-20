// Collision model: actor movement against sector geometry and other actors,
// plus ray traces. Port of kexCModel (game/cmodel.cpp).

import { FF, SF } from './mapfile.js';
import { Vec3 } from './math.js';
import { AF } from './actorflags.js';

const CONTACT_COUNT = 5;
const EGF_TOPSTEP = 1;

export class CModel {
    constructor(game) {
        this.game = game;
        this.validcount = 1;
        this.sectorList = [];
        this.moveActor = null;
        this.sourceActor = null;
        this.contactSector = null;
        this.contactFace = null;
        this.contactActor = null;
        this.interceptVector = new Vec3();
        this.start = new Vec3();
        this.end = new Vec3();
        this.moveDir = new Vec3();
        this.contactNormal = new Vec3();
        this.actorRadius = 0;
        this.actorHeight = 0;
        this.fraction = 1;
        this.bmin = [0, 0, 0];
        this.bmax = [0, 0, 0];
    }

    setup(world) {
        this.world = world;
        this.xyz = world.vxyz;
        this.sectors = world.sectors;
        this.faces = world.faces;
    }

    // plane helpers
    normal(face) { return new Vec3(face.plane[0], face.plane[1], face.plane[2]); }
    planeDist(face, p) { const n = face.plane; return n[0] * p.x + n[1] * p.y + n[2] * p.z - n[3]; }
    pointOnFaceSide(origin, face, extent = 0) {
        const n = face.plane;
        return n[0] * origin.x + n[1] * origin.y + n[2] * origin.z - (n[3] + extent);
    }
    v(i) { const x = this.xyz; return new Vec3(x[i * 3], x[i * 3 + 1], x[i * 3 + 2]); }

    checkEdgeSide(origin, edge, face, heightAdjust, extent = 0) {
        const vs = face.vertexStart;
        const x = this.xyz;
        const a = (vs + edge) * 3, b = (vs + ((edge + 1) & 3)) * 3;
        const lx = x[b] - x[a], ly = x[b + 1] - x[a + 1], lz = x[b + 2] - x[a + 2];
        const px = origin.x - x[a], py = origin.y - x[a + 1], pz = origin.z + heightAdjust - x[a + 2];
        // cp = pdir x ldir
        const cx = py * lz - pz * ly, cy = pz * lx - px * lz, cz = px * ly - py * lx;
        const n = face.plane;
        if (cx * n[0] + cy * n[1] + cz * n[2] < 0) {
            if (extent === 0) return true;
            if (cx * cx + cy * cy + cz * cz > (lx * lx + ly * ly + lz * lz) * extent * extent) return true;
        }
        return false;
    }

    pointInsideFace(origin, face, extent = 0) {
        const vs = face.vertexStart;
        const rSq = extent * extent;
        const pts = [this.v(vs + 3), this.v(vs + 2), this.v(vs + 1), this.v(vs)];
        const n = this.normal(face);
        const org = origin.sub(n.scale(this.pointOnFaceSide(origin, face)));
        for (let i = 0; i < 4; ++i) {
            const pt1 = pts[i & 3], pt2 = pts[(i + 1) & 3], pt3 = pts[(i + 2) & 3];
            const dp1 = pt1.sub(org), dp2 = pt2.sub(org);
            const cp = dp1.cross(dp2);
            if (n.dot(cp) >= 0) continue;
            if (this.actorRadius === 0) return false;
            let edge = pt1.sub(pt2);
            const eSq = edge.lengthSq();
            if (cp.lengthSq() > eSq * rSq) return false;
            const d = edge.dot(dp1);
            if (d < 0) {
                edge = pt1.sub(pt3);
                if (edge.dot(dp1) < 0 && dp1.lengthSq() > rSq) return false;
            } else if (d > eSq) {
                edge = pt2.sub(pt3);
                if (edge.dot(dp2) < 0 && dp2.lengthSq() > rSq) return false;
            }
        }
        return true;
    }

    traceFacePlane(face, extent1 = 0, extent2 = 0, testOnly = false) {
        const d1 = this.pointOnFaceSide(this.start, face, extent1);
        const d2 = this.pointOnFaceSide(this.end, face, extent1);
        if (d1 <= d2 || d1 < 0 || d2 > 0) return false;
        const frac = d1 / (d1 - d2);
        if (frac > 1 || frac < 0) return false;
        if (frac >= this.fraction) return false;
        const hit = this.start.lerp(this.end, frac);
        if (!this.pointInsideFace(hit, face, extent2)) {
            if (!this.moveActor) return false;
            if (this.checkEdgeSide(this.end, 2, face, this.actorHeight) ||
                this.checkEdgeSide(this.end, 0, face, this.moveActor.stepHeight)) return false;
            if (this.checkEdgeSide(this.end, 3, face, 0, extent1) ||
                this.checkEdgeSide(this.end, 1, face, 0, extent1)) return false;
        }
        if (testOnly) return true;
        this.fraction = frac;
        this.interceptVector = hit;
        this.contactNormal = this.normal(face);
        this.contactFace = face;
        this.contactSector = this.sectors[face.sectorOwner];
        return true;
    }

    testIntersectSector(face, extent) {
        const d1 = this.pointOnFaceSide(this.start, face, extent);
        const d2 = this.pointOnFaceSide(this.end, face, extent);
        if (d1 <= d2 || d1 < 0 || d2 > 0) return false;
        const frac = d1 / (d1 - d2);
        if (frac > 1 || frac < 0) return false;
        if (frac >= this.fraction) return false;
        const hit = this.start.lerp(this.end, frac);
        if (!this.pointWithinSectorEdges(hit, this.sectors[face.sectorOwner], extent - 4.096)) return false;
        this.fraction = frac;
        this.interceptVector = hit;
        this.contactNormal = this.normal(face);
        this.contactFace = face;
        this.contactSector = this.sectors[face.sectorOwner];
        return true;
    }

    // 2D circle intersection
    traceSphere2D(radius, px, py, heightMax = 0, heightMin = 0, testOnly = false) {
        const ox = px - this.start.x, oy = py - this.start.y;
        let dx = this.moveDir.x, dy = this.moveDir.y;
        const dl = Math.sqrt(dx * dx + dy * dy);
        if (dl > 0) { dx /= dl; dy /= dl; }
        if (dx * ox + dy * oy < 0) return false;
        const len = this.end.sub(this.start).length();
        if (len === 0) return false;
        const cp = dx * ox + dy * oy;
        const cdx = ox - dx * cp, cdy = oy - dy * cp;
        const r = radius + 1.024;
        const rd = r * r - (cdx * cdx + cdy * cdy);
        if (rd < 0) return false;
        const frac = (cp - Math.sqrt(rd)) * (1 / len);
        if (frac <= 1 && frac < this.fraction) {
            if (testOnly) return true;
            const hit = this.start.lerp(this.end, frac);
            if (heightMax !== 0 && hit.z > heightMax) return false;
            if (heightMin !== 0 && hit.z < heightMin) return false;
            this.fraction = frac;
            this.interceptVector = hit;
            this.contactNormal = new Vec3(hit.x - px, hit.y - py, 0).normalize();
            this.contactFace = null;
            return true;
        }
        return false;
    }

    traceSphere3D(radius, point) {
        const org = point.sub(this.start);
        const dir = this.moveDir.clone().normalize();
        if (dir.dot(org) < 0) return false;
        const len = this.end.sub(this.start).length();
        if (len === 0) return false;
        const cp = dir.dot(org);
        const cDist = org.sub(dir.scale(cp));
        const r = radius + 1.024;
        const rd = r * r - cDist.lengthSq();
        if (rd < 0) return false;
        const frac = (cp - Math.sqrt(rd)) * (1 / len);
        if (frac >= -1 && frac <= 1 && frac < this.fraction) {
            const hit = this.start.lerp(this.end, frac);
            this.fraction = frac;
            this.interceptVector = hit;
            this.contactNormal = hit.sub(point).normalize();
            this.contactFace = null;
            return true;
        }
        return false;
    }

    pushFromRadialBounds(px, py, radius) {
        const dx = this.end.x - px, dy = this.end.y - py;
        let dist = dx * dx + dy * dy;
        const r = radius + 1.024;
        if (dist <= r * r) {
            const l = Math.sqrt(dist) || 1;
            const nx = dx / l, ny = dy / l;
            dist = (r - Math.sqrt(dist)) + 0.1;
            this.moveDir.x += nx * dist;
            this.moveDir.y += ny * dist;
        }
    }

    collideFace(face) {
        const ma = this.moveActor;
        if (this.checkEdgeSide(this.end, 0, face, ma.stepHeight)) return false;
        if (face.edgeFlags[2] & EGF_TOPSTEP) {
            if (this.checkEdgeSide(this.end, 2, face, this.actorHeight)) return false;
        }
        if (this.pointOnFaceSide(this.start, face) >= 0) {
            const vs = face.vertexStart;
            const zf = this.start.z + ma.stepHeight;
            const zc = this.start.z + this.actorHeight;
            const p0 = this.v(vs + 3), p1 = this.v(vs + 2), p2 = this.v(vs + 1), p3 = this.v(vs);
            const rSq = this.actorRadius * this.actorRadius;
            const qx = this.end.x, qy = this.end.y;
            const ax = p3.x, ay = p3.y, bx = p2.x, by = p2.y;
            const ex = bx - ax, ey = by - ay;
            const u = ex * (bx - qx) + ey * (by - qy);
            const v = ex * (qx - ax) + ey * (qy - ay);
            if (v <= 0 && (p3.z >= zf && p0.z <= zc)) {
                const dx = qx - ax, dy = qy - ay;
                if (dx * dx + dy * dy > rSq) return false;
                if (this.traceSphere2D(this.actorRadius, ax, ay)) this.contactFace = face;
                return false;
            }
            if (u <= 0 && (p2.z >= zf && p1.z <= zc)) {
                const dx = qx - bx, dy = qy - by;
                if (dx * dx + dy * dy > rSq) return false;
                if (this.traceSphere2D(this.actorRadius, bx, by)) this.contactFace = face;
                return false;
            }
        }
        return this.traceFacePlane(face, this.actorRadius);
    }

    traceActorsInSector(sector) {
        const ma = this.moveActor;
        if (ma && !(ma.flags & AF.SOLID) && !ma.isProjectile) return;
        for (const actor of sector.actors) {
            if (actor === this.sourceActor) continue;
            if (!(actor.flags & (AF.SOLID | AF.TOUCHABLE | AF.SHOOTABLE))) continue;
            if (ma) {
                const isProj = ma.isProjectile;
                if (isProj && actor === ma.target) continue;
                let underLip = actor.radius - actor.stepHeight;
                if (underLip < 0 || isProj) underLip = 0;
                const z = actor.origin.z;
                const height = actor.height + underLip;
                if (this.end.z > z + height || this.actorHeight + this.end.z < z - underLip) continue;
                const r = actor.radius * 0.5 + ma.radius;
                const testProj = isProj && (actor.flags & AF.SHOOTABLE);
                const testOnly = !testProj && !(actor.flags & AF.SOLID);
                if (this.traceSphere2D(r, actor.origin.x, actor.origin.y, z + height, 0, testOnly)) {
                    if (actor.flags & AF.TOUCHABLE) actor.onTouch(ma);
                    if ((actor.flags & AF.SOLID) || testProj) {
                        this.contactActor = actor;
                        this.contactSector = actor.sector;
                    }
                }
            } else if (actor.flags & (AF.SOLID | AF.SHOOTABLE)) {
                let minz = 0;
                const vOrg = actor.origin;
                if (actor.isAI && (actor.aiFlags & 4 /* AIF_FLYING */)) minz = -actor.stepHeight;
                const ed = this.end.distanceSq(this.start);
                const d = ed > 0 ? Math.sqrt(vOrg.distanceSq(this.start) / ed) : 0;
                let z = ((this.end.z - this.start.z) * d + this.start.z) - vOrg.z;
                if (z < minz) z = minz;
                if (z > actor.height) z = actor.height;
                if (this.traceSphere3D(actor.radius, new Vec3(vOrg.x, vOrg.y, vOrg.z + z))) {
                    this.contactActor = actor;
                    this.contactSector = actor.sector;
                }
            }
        }
    }

    slideAgainstFaces(sector) {
        const ma = this.moveActor;
        const isAI = ma.isAI;
        const flying = isAI && (ma.aiFlags & 4);
        for (let i = sector.faceStart; i < sector.faceEnd + 3; ++i) {
            const face = this.faces[i];
            if (face.flags & FF.WATER) {
                if (ma.flags & AF.NOENTERWATER) this.collideFace(face);
                continue;
            }
            if (isAI && (face.flags & FF.BLOCKAIGROUND) && !flying) {
                this.collideFace(face);
                continue;
            }
            if (i <= sector.faceEnd && (face.flags & FF.PORTAL) && face.sector >= 0) {
                const s = this.sectors[face.sector];
                const ceilingz = this.getCeilingHeight(this.end, s);
                const floorz = this.getFloorHeight(this.end, s);
                if ((ma.flags & AF.NOENTERWATER) && !(isAI && flying)) {
                    if (s.floorFace.flags & FF.WATER) { this.collideFace(face); continue; }
                }
                if ((ma.flags & AF.NOEXITWATER) && !(s.flags & SF.WATER) && !(s.floorFace.flags & FF.WATER)) {
                    this.collideFace(face); continue;
                }
                if ((ma.flags & AF.NOEXITLAVA) && !(s.floorFace.flags & FF.LAVA)) {
                    this.collideFace(face); continue;
                }
                if ((sector.ceilingFace.flags & FF.SOLID) && (s.floorFace.flags & FF.SOLID) &&
                    ma.ceilingHeight - floorz < this.actorHeight) {
                    this.collideFace(face); continue;
                }
                if (ma.flags & AF.NODROPOFF) {
                    if (face.flags & FF.BLOCKAIFALLERS) { this.collideFace(face); continue; }
                    if (isAI && (s.floorFace.flags & FF.LAVA) && !(ma.aiFlags & 32 /* AIF_NOLAVADAMAGE */)) {
                        this.collideFace(face); continue;
                    }
                    if (this.getFloorHeight(this.start, ma.sector) - floorz > ma.fallHeight) this.collideFace(face);
                } else {
                    const fc = Math.abs(s.floorFace.plane[2]);
                    const cc = Math.abs(s.ceilingFace.plane[2]);
                    if ((s.ceilingFace.flags & FF.SOLID) && (s.floorFace.flags & FF.SOLID) &&
                        ceilingz - floorz < this.actorHeight && fc > 0.5 && cc > 0.5) {
                        if (this.planeDist(s.floorFace, this.start) < 0 ||
                            this.planeDist(s.ceilingFace, this.start) > this.actorHeight) {
                            this.collideFace(face);
                        }
                    }
                }
            }
            if (!(face.flags & FF.SOLID) || (face.flags & FF.WATER)) continue;
            if (i <= sector.faceEnd) this.collideFace(face);
        }
    }

    actorTouchingFace(actor, face) {
        return !this.checkEdgeSide(actor.origin, 2, face, actor.height * 0.95) &&
               !this.checkEdgeSide(actor.origin, 0, face, actor.stepHeight) &&
               !this.checkEdgeSide(actor.origin, 3, face, 0) &&
               !this.checkEdgeSide(actor.origin, 1, face, 0);
    }

    checkActorPosition(actor, initialSector) {
        if (initialSector && !this.pointWithinSectorEdges(actor.origin, actor.sector)) {
            actor.origin.copy(actor.prevOrigin);
            actor.setSector(initialSector);
            return false;
        }
        const s = actor.sector;
        for (let i = s.faceStart; i <= s.faceEnd; ++i) {
            const face = this.faces[i];
            if (!(face.flags & FF.SOLID) || face.sector >= 0) continue;
            const d = this.pointOnFaceSide(actor.origin, face, actor.radius);
            if (d < 0 && d > -actor.radius) {
                if (this.actorTouchingFace(actor, face)) {
                    actor.origin.subSelf(this.normal(face).scale(d));
                    return false;
                }
            }
        }
        return true;
    }

    pointWithinSectorEdges(origin, sector, extent = 0) {
        for (let i = sector.faceStart; i < sector.faceEnd + 1; ++i) {
            if (this.pointOnFaceSide(origin, this.faces[i], extent) < 0) return false;
        }
        return true;
    }

    pointInsideSector(origin, sector, extent = 0, floorOffset = 0) {
        if (origin.z > this.getCeilingHeight(origin, sector)) return false;
        if (origin.z + floorOffset < this.getFloorHeight(origin, sector)) return false;
        return this.pointWithinSectorEdges(origin, sector, extent);
    }

    planeHeight(face, origin) {
        const x = this.xyz, v = face.vertexStart * 3, n = face.plane;
        return ((x[v] - origin.x) * n[0] + (x[v + 1] - origin.y) * n[1] + x[v + 2] * n[2]) / n[2];
    }

    getFloorHeight(origin, sector, testWater = false) {
        let face = this.faces[sector.faceEnd + 2];
        if (testWater && !(face.flags & FF.SOLID) && (face.flags & FF.PORTAL)) {
            let guard = 64;
            while (!(face.flags & FF.SOLID) && (face.flags & FF.PORTAL) && face.sector >= 0 && guard--) {
                face = this.faces[this.sectors[face.sector].faceEnd + 2];
            }
        }
        return this.planeHeight(face, origin);
    }

    getCeilingHeight(origin, sector, testWater = false) {
        let face = this.faces[sector.faceEnd + 1];
        if (testWater && !(face.flags & FF.SOLID) && (face.flags & FF.PORTAL)) {
            let guard = 64;
            while (!(face.flags & FF.SOLID) && (face.flags & FF.PORTAL) && face.sector >= 0 && guard--) {
                face = this.faces[this.sectors[face.sector].faceEnd + 1];
            }
        }
        return this.planeHeight(face, origin);
    }

    boundsIntersect(b) {
        return !(b.max[0] < this.bmin[0] || b.max[1] < this.bmin[1] || b.max[2] < this.bmin[2] ||
                 b.min[0] > this.bmax[0] || b.min[1] > this.bmax[1] || b.min[2] > this.bmax[2]);
    }

    getContactSectors(initial) {
        const list = this.sectorList;
        list.length = 0;
        list.push(initial);
        initial.validcount = this.validcount;
        for (let sc = 0; sc < list.length; ++sc) {
            const sec = list[sc];
            this.traceActorsInSector(sec);
            for (let i = sec.faceStart; i < sec.faceEnd + 3; ++i) {
                const face = this.faces[i];
                if (!(face.flags & FF.PORTAL) || face.sector <= -1) continue;
                const s = this.sectors[face.sector];
                if (s.validcount === this.validcount) continue;
                if (this.boundsIntersect(s.bounds)) {
                    list.push(s);
                    s.validcount = this.validcount;
                }
            }
        }
        this.validcount++;
    }

    checkSurroundingSectors() {
        const ma = this.moveActor;
        let best = null;
        let maxfloorz = ma.floorHeight;
        let maxceilingz = this.end.z;
        let changeFloor = false, changeCeiling = false;
        const list = this.sectorList;
        list.length = 0;
        list.push(ma.sector);
        ma.sector.validcount = this.validcount;
        for (let sc = 0; sc < list.length; ++sc) {
            const sec = list[sc];
            for (let i = sec.faceStart; i < sec.faceEnd + 1; ++i) {
                const face = this.faces[i];
                if (!(face.flags & FF.PORTAL) || face.sector <= -1) continue;
                const s = this.sectors[face.sector];
                if (!this.pointWithinSectorEdges(this.end, s, -this.actorRadius)) continue;
                if (s.validcount === this.validcount) continue;
                list.push(s);
                s.validcount = this.validcount;
                if (!this.checkEdgeSide(this.end, 2, face, this.actorRadius) &&
                    !this.checkEdgeSide(this.end, 0, face, this.actorRadius)) {
                    if (this.pointOnFaceSide(this.end, face, this.actorRadius) < 0) {
                        const ceilingz = this.getCeilingHeight(this.end, s, true);
                        const floorz = this.getFloorHeight(this.end, s, !(ma.flags & AF.NOENTERWATER));
                        if (Math.abs(ceilingz - floorz) < this.actorHeight) continue;
                        const diff = this.end.z - floorz;
                        if (diff <= 0 && diff >= -ma.stepHeight) {
                            if (Math.abs(s.floorFace.plane[2]) > 0.5 && floorz > maxfloorz && ma.movement.z <= 0) {
                                best = s; maxfloorz = floorz; changeFloor = true;
                            }
                        }
                        if (ceilingz > floorz && ceilingz - this.end.z < this.actorHeight) {
                            if (ceilingz > maxceilingz && Math.abs(s.ceilingFace.plane[2]) > 0.5) {
                                best = s; maxceilingz = ceilingz; changeCeiling = true;
                            }
                        }
                    }
                }
            }
        }
        if (changeFloor && best && (best.floorFace.flags & FF.SOLID)) {
            if (this.pointInsideSector(this.end, best, -this.actorRadius, ma.stepHeight)) {
                if (ma.isPuppet) {
                    const step = this.end.z - maxfloorz;
                    if (step < 0 && ma.owner.stepViewZ >= 0) ma.owner.stepViewZ = step;
                }
                this.end.z = maxfloorz;
                ma.floorHeight = maxfloorz;
            }
        }
        if (changeCeiling) {
            if (maxceilingz > maxfloorz && (maxceilingz - maxfloorz) > this.actorHeight) {
                this.end.z = maxceilingz - this.actorHeight;
                ma.ceilingHeight = maxceilingz;
            }
        }
        this.validcount++;
    }

    collideActorWithWorld() {
        const ma = this.moveActor;
        const sector = ma.sector;
        let moves = 0;
        const r = this.actorRadius * 2, h = this.actorHeight * 2;
        const normals = [];
        for (let i = 0; i < CONTACT_COUNT; ++i) {
            this.fraction = 1;
            this.end = this.start.add(this.moveDir);
            this.interceptVector = this.end.clone();
            this.contactNormal = new Vec3();
            this.contactFace = null;
            this.contactActor = null;
            this.contactSector = null;
            this.bmin[0] = this.end.x - r; this.bmin[1] = this.end.y - r; this.bmin[2] = this.end.z - h;
            this.bmax[0] = this.end.x + r; this.bmax[1] = this.end.y + r; this.bmax[2] = this.end.z + h;
            const md = this.moveDir;
            if (md.x < 0) this.bmin[0] += md.x - 1; else this.bmax[0] += md.x + 1;
            if (md.y < 0) this.bmin[1] += md.y - 1; else this.bmax[1] += md.y + 1;
            if (md.z < 0) this.bmin[2] += md.z - 1; else this.bmax[2] += md.z + 1;
            this.getContactSectors(sector);
            const list = this.sectorList.slice();
            for (const s of list) this.slideAgainstFaces(s);
            this.sectorList = list;
            if (this.fraction >= 1) break;
            if (moves >= CONTACT_COUNT) break;
            if (this.contactActor) {
                this.pushFromRadialBounds(this.contactActor.origin.x, this.contactActor.origin.y, this.contactActor.radius);
            }
            if (this.contactFace && !(ma.flags & AF.COLLIDEDWALL)) {
                ma.flags |= AF.COLLIDEDWALL;
                ma.collidedWallAngle = this.contactFace.angle;
                ma.collidedWallNormal = this.normal(this.contactFace);
            }
            if (!ma.onCollide(this)) return;
            normals[moves++] = this.contactNormal.clone();
            const projAmt = 1.0 - this.fraction + 0.1;
            for (let j = 0; j < moves; ++j) {
                if (this.moveDir.dot(normals[j]) >= 0) continue;
                this.project(this.moveDir, normals[j], projAmt);
                for (let k = 0; k < moves; ++k) {
                    if (k === j || this.moveDir.dot(normals[k]) >= 0) continue;
                    this.project(this.moveDir, normals[k], projAmt);
                    if (this.moveDir.dot(normals[j]) >= 0) continue;
                    const cDir = normals[j].cross(normals[k]).normalize();
                    const d = cDir.dot(this.moveDir);
                    this.moveDir = cDir.scale(d);
                }
            }
        }
    }

    project(v, n, amt) {
        const d = v.dot(n) * amt;
        v.x -= n.x * d; v.y -= n.y * d; v.z -= n.z * d;
    }

    advanceActorToSector() {
        const ma = this.moveActor;
        let sector = ma.sector;
        const water1 = !!(sector.flags & SF.WATER);
        for (const s of this.sectorList) {
            const offset = (s.floorFace.flags & FF.WATER) ? 0 : ma.stepHeight;
            if (this.pointInsideSector(this.end, s, 0, offset)) {
                if (s.ceilingFace.flags & FF.WATER) {
                    if ((ma.flags & AF.NOENTERWATER) && ma.isAI && (ma.aiFlags & 4)) {
                        if (this.sectors[s.ceilingFace.sector] === sector) continue;
                    }
                }
                if ((s.ceilingFace.flags & FF.SOLID) && (s.ceilingFace.flags & FF.PORTAL)) {
                    if (this.sectors[s.ceilingFace.sector] === sector) continue;
                }
                sector = s;
            }
        }
        const floorz = this.getFloorHeight(this.end, sector, !(ma.flags & AF.NOENTERWATER));
        const ceilingz = this.getCeilingHeight(this.end, sector, !(ma.flags & AF.NOEXITWATER));
        const water2 = !!(sector.flags & SF.WATER);
        if (!(water1 ^ water2) && (sector.floorFace.flags & FF.SOLID)) {
            if (this.end.z - floorz < 0) { this.end.z = floorz; this.moveDir.z = 0; }
        }
        if ((!(water1 ^ water2) && (sector.ceilingFace.flags & FF.SOLID)) || (ma.flags & AF.NOEXITWATER)) {
            if (ceilingz - this.end.z < this.actorHeight) this.end.z = ceilingz - this.actorHeight;
        }
        ma.floorHeight = floorz;
        ma.ceilingHeight = ceilingz;
        ma.setSector(sector);
    }

    move(actor) {
        const sector = actor.sector;
        if (!sector) return false;
        actor.flags &= ~AF.COLLIDEDWALL;
        this.moveActor = actor;
        this.sourceActor = actor;
        this.actorRadius = actor.radius;
        this.actorHeight = actor.height;
        this.moveDir = actor.movement.clone();
        this.start = actor.origin.clone();
        actor.prevOrigin.copy(this.start);
        this.collideActorWithWorld();
        this.advanceActorToSector();
        this.checkSurroundingSectors();
        actor.origin.copy(this.end);
        actor.movement.copy(this.moveDir);
        this.checkActorPosition(actor, sector);
        return true;
    }

    trace(actor, sector, startPos, endPos, radius = 0, testActors = true) {
        if (!sector) return false;
        const list = this.sectorList;
        list.length = 0;
        this.moveActor = null;
        this.sourceActor = actor;
        this.actorRadius = 0;
        this.actorHeight = 0;
        this.start = startPos.clone();
        this.end = endPos.clone();
        this.moveDir = this.end.sub(this.start);
        this.fraction = 1;
        this.interceptVector = this.end.clone();
        this.contactNormal = new Vec3();
        this.contactSector = sector;
        this.contactFace = null;
        this.contactActor = null;
        list.push(sector);
        sector.validcount = this.validcount;
        const md = this.moveDir;
        for (let sc = 0; sc < list.length; ++sc) {
            const s = list[sc];
            if (testActors) this.traceActorsInSector(s);
            for (let i = s.faceStart; i < s.faceEnd + 3; ++i) {
                const face = this.faces[i];
                const n = face.plane;
                if (n[0] * md.x + n[1] * md.y + n[2] * md.z > 0) continue;
                if ((face.flags & FF.PORTAL) && face.sector >= 0) {
                    if (this.sectors[face.sector].validcount === this.validcount) continue;
                    if ((face.flags & FF.WATER) || this.traceFacePlane(face, 0, radius, true)) {
                        const next = this.sectors[face.sector];
                        if (face.flags & FF.WATER) {
                            if (this.planeDist(face, this.start) >= 0 && this.planeDist(face, this.end) >= 0) continue;
                        }
                        list.push(next);
                        next.validcount = this.validcount;
                        this.contactSector = next;
                    }
                } else if (face.flags & FF.SOLID) {
                    if (i <= s.faceEnd) this.traceFacePlane(face, 0, radius);
                    else this.testIntersectSector(face, radius);
                }
            }
        }
        this.validcount++;
        return this.fraction !== 1;
    }
}

