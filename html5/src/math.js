// Small vector/matrix helpers. World space is Z-up; yaw 0 faces +Y and
// increases toward +X (kexVec3::ToYaw is atan2(x, y)).

export const PI = Math.PI;
export const TWO_PI = Math.PI * 2;

export class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vec3(this.x, this.y, this.z); }
    add(v) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
    sub(v) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
    scale(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
    mul(v) { return typeof v === 'number' ? this.scale(v) : new Vec3(this.x * v.x, this.y * v.y, this.z * v.z); }
    div(v) { return typeof v === 'number' ? this.scale(1 / v) : new Vec3(this.x / v.x, this.y / v.y, this.z / v.z); }
    neg() { return new Vec3(-this.x, -this.y, -this.z); }
    addSelf(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    subSelf(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    scaleSelf(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    cross(v) { return new Vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.lengthSq()); }
    distance(v) { return Math.sqrt(this.distanceSq(v)); }
    distanceSq(v) { const x = this.x - v.x, y = this.y - v.y, z = this.z - v.z; return x * x + y * y + z * z; }
    normalize() { const l = this.length(); if (l > 0) { this.x /= l; this.y /= l; this.z /= l; } return this; }
    lerp(v, t) { return new Vec3(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t); }
    clear() { this.x = this.y = this.z = 0; return this; }
    toYaw() { return (this.x * this.x + this.y * this.y) === 0 ? 0 : Math.atan2(this.x, this.y); }
    toPitch() {
        const d = this.x * this.x + this.y * this.y;
        if (d === 0) return this.z > 0 ? Math.PI / 2 : -Math.PI / 2;
        return Math.atan2(this.z, Math.sqrt(d));
    }
    unit() { return this.length(); }
    toString() { return `(${this.x.toFixed(1)}, ${this.y.toFixed(1)}, ${this.z.toFixed(1)})`; }
}

export function clampAngle(a) {
    while (a < -PI) a += TWO_PI;
    while (a > PI) a -= TWO_PI;
    return a;
}

export function angleDiff(a, b) {
    return clampAngle(a - b);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function deg2rad(d) { return d * PI / 180; }
export function rad2deg(r) { return r * 180 / PI; }

export const mat4 = {
    identity() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    perspective(fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
        return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    },
    ortho(l, r, b, t, n, f) {
        return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0,
            -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
    },
    multiply(a, b) {
        const o = new Float32Array(16);
        for (let i = 0; i < 4; ++i) for (let j = 0; j < 4; ++j) {
            o[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
        }
        return o;
    },
    // Camera at eye looking along yaw/pitch in Z-up world.
    view(eye, yaw, pitch, roll = 0) {
        const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.cos(yaw) * Math.cos(pitch), fz = Math.sin(pitch);
        let rx = Math.cos(yaw), ry = -Math.sin(yaw), rz = 0;
        let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
        if (roll) {
            const c = Math.cos(roll), s = Math.sin(roll);
            const nrx = rx * c + ux * s, nry = ry * c + uy * s, nrz = rz * c + uz * s;
            ux = ux * c - rx * s; uy = uy * c - ry * s; uz = uz * c - rz * s;
            rx = nrx; ry = nry; rz = nrz;
        }
        return new Float32Array([
            rx, ux, -fx, 0,
            ry, uy, -fy, 0,
            rz, uz, -fz, 0,
            -(rx * eye.x + ry * eye.y + rz * eye.z), -(ux * eye.x + uy * eye.y + uz * eye.z), (fx * eye.x + fy * eye.y + fz * eye.z), 1,
        ]);
    },
};

// kexQuat as registered for scripts (axis-angle constructor, KEX multiply order)
export class Quat {
    constructor(angle = 0, x = 0, y = 0, z = 0) {
        if (arguments.length === 4) {
            const s = Math.sin(angle * 0.5), c = Math.cos(angle * 0.5);
            this.x = x * s; this.y = y * s; this.z = z * s; this.w = c;
        } else if (arguments.length === 2 && typeof x === 'object') {
            const s = Math.sin(angle * 0.5), c = Math.cos(angle * 0.5);
            this.x = x.x * s; this.y = x.y * s; this.z = x.z * s; this.w = c;
        } else {
            this.x = 0; this.y = 0; this.z = 0; this.w = 1;
        }
    }
    clone() { const q = new Quat(); q.x = this.x; q.y = this.y; q.z = this.z; q.w = this.w; return q; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    mul(q) {
        const o = new Quat();
        o.x = this.x * q.w - this.y * q.z + q.x * this.w + q.y * this.z;
        o.y = this.x * q.z + this.y * q.w - q.x * this.z + this.w * q.y;
        o.z = q.x * this.y + this.w * q.z + this.z * q.w - this.x * q.y;
        o.w = this.w * q.w - q.y * this.y + this.z * q.z + q.x * this.x;
        return o;
    }
    Normalize() {
        const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
        this.x /= l; this.y /= l; this.z /= l; this.w /= l;
        return this;
    }
}

// vector * quaternion (kexVec3::operator*(const kexQuat&))
export function rotateByQuat(v, q) {
    const xx = q.x * q.x, yx = q.y * q.x, zx = q.z * q.x, wx = q.w * q.x;
    const yy = q.y * q.y, zy = q.z * q.y, wy = q.w * q.y;
    const zz = q.z * q.z, wz = q.w * q.z, ww = q.w * q.w;
    return new Vec3(
        ((yx + yx) - (wz + wz)) * v.y + (wy + wy + zx + zx) * v.z + (((ww + xx) - yy) - zz) * v.x,
        ((yy + (ww - xx)) - zz) * v.y + ((zy + zy) - (wx + wx)) * v.z + ((wz + wz) + (yx + yx)) * v.x,
        ((wx + wx) + (zy + zy)) * v.y + (((ww - xx) - yy) + zz) * v.z + ((zx + zx) - (wy + wy)) * v.x,
    );
}

// AngelScript-facing kVec3 methods (in-place where the engine's are)
Object.assign(Vec3.prototype, {
    Length() { return this.length(); },
    LengthSq() { return this.lengthSq(); },
    Unit() { return this.length(); },
    UnitSq() { return this.lengthSq(); },
    Distance(v) { return this.distance(v); },
    DistanceSq(v) { return this.distanceSq(v); },
    Dot(v) { return this.dot(v); },
    Cross(v) { return this.cross(v); },
    Normalize() { return this.normalize(); },
    Lerp(v, t) {
        this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t;
        return this;
    },
    ToYaw() { return this.toYaw(); },
    ToPitch() { return this.toPitch(); },
    Clear() { this.clear(); },
    Set(x, y, z) { this.set(x, y, z); },
});
