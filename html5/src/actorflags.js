// Flag constants shared by the engine and the transpiled game scripts.

export const AF = {
    NOENTERWATER: 1 << 0,
    DISABLEFRICTION: 1 << 1,
    SOLID: 1 << 2,
    NOADVANCEFRAMES: 1 << 3,
    RANDOMIZATION: 1 << 4,
    FLASH: 1 << 5,
    SHOOTABLE: 1 << 6,
    FULLBRIGHT: 1 << 7,
    MOVEABLE: 1 << 8,
    TOUCHABLE: 1 << 9,
    BOUNCY: 1 << 10,
    INWATER: 1 << 11,
    NODROPOFF: 1 << 12,
    EXPIRES: 1 << 13,
    HIDDEN: 1 << 14,
    NOEXITWATER: 1 << 15,
    COLLIDEDWALL: 1 << 16,
    STRETCHY: 1 << 17,
    VERTICALFRICTION: 1 << 18,
    NOSPRITECLIPFIX: 1 << 19,
    NOEXITLAVA: 1 << 20,
};

export const AIF = {
    TURNING: 1 << 0,
    LOOKALLAROUND: 1 << 1,
    FLYING: 1 << 2,
    ALWAYSRANGEATTACK: 1 << 3,
    RETREATAFTERMELEE: 1 << 4,
    NOLAVADAMAGE: 1 << 5,
    RETREATTURN: 1 << 6,
    FLYADJUSTVIEWLEVEL: 1 << 7,
    ONFIRE: 1 << 8,
    NOINFIGHTING: 1 << 9,
    CHASEWANDER: 1 << 10,
};

export const AIS = { IDLE: 0, CHASE: 1, PAIN: 2, MELEE: 3, RANGE: 4, DEAD: 5, CUSTOM: 6 };

export const PF = {
    JUMPING: 1 << 0, USERJUMPED: 1 << 1, NOCLIP: 1 << 2, FLY: 1 << 3, ABOVESURFACE: 1 << 4,
    JUMPWASHELD: 1 << 5, NEEDTOGASP: 1 << 6, FLOATING: 1 << 7, ELECTROCUTE: 1 << 8,
    DEAD: 1 << 9, GOD: 1 << 10, STUNNED: 1 << 11,
};

export const PA = {
    SANDALS: 1 << 0, MASK: 1 << 1, SHAWL: 1 << 2, ANKLETS: 1 << 3, SCEPTER: 1 << 4, FEATHER: 1 << 5,
    ALL: 0x3f,
};

export const PAB = { DOLPHIN: 1 << 0, VULTURE: 1 << 1 };

export const PW = {
    MACHETE: 0, PISTOL: 1, M60: 2, BOMBS: 3, FLAMETHROWER: 4, COBRASTAFF: 5, RINGOFRA: 6, MANACLE: 7,
};
export const NUMPLAYERWEAPONS = 8;

export const BC = {
    ATTACK: 1 << 0, JUMP: 1 << 1, FORWARD: 1 << 2, BACKWARD: 1 << 3, LEFT: 1 << 4, RIGHT: 1 << 5,
    STRAFELEFT: 1 << 6, STRAFERIGHT: 1 << 7, WEAPONRIGHT: 1 << 8, WEAPONLEFT: 1 << 9, USE: 1 << 10,
    MAPZOOMIN: 1 << 11, MAPZOOMOUT: 1 << 12,
};

export const ADT = { GENERIC: 0, MELEE: 1, BULLET: 2, EXPLOSIVE: 3, FIRE: 4, ELECTRIC: 5, CRUSH: 6, FALL: 7 };

export const DIFFICULTY = { NORMAL: 0, HARD: 1, PHARAOH: 2 };

export const WS = { IDLE: 0, RAISE: 1, LOWER: 2, HOLDSTER: 3, FIRE: 4 };
