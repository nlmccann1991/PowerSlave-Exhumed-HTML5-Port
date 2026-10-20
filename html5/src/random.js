// kexRand equivalents (xorshift so results are reproducible per seed).

let state = 0x2545f491;

function next() {
    let x = state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    state = x;
    return x;
}

export const rand = {
    seed(s) { state = (s >>> 0) || 0x2545f491; },
    int() { return next() & 0x7fffffff; },
    max(n) { return n <= 0 ? 0 : next() % n; },
    byte() { return next() & 0xff; },
    float() { return (next() & 0xffffff) / 0x1000000; },
    cfloat() { return ((next() & 0xffffff) / 0x800000) - 1; },
    range(a, b) { return a + (b - a) * ((next() & 0xffffff) / 0x1000000); },
};
