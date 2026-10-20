// Static type information for the engine API exposed to AngelScript.
// Signatures were recovered from the AngelScript registration strings in
// anubis_Shipping_Galaxy_x64.exe (REA string search).

export function typeBase(t) {
    if (!t) return t;
    return String(t).replace(/^const\s+/, '').replace(/[@&\s]+$/g, '');
}

const ACTOR = {
    GetOrigin: 'kVec3', GetVelocity: 'kVec3', GetRotation: 'slaveRotation_s', GetTarget: 'kexSlaveActor',
    SetTarget: 'void', GetSector: 'int', LinkSector: 'void', ChangeAnim: 'void', PlaySound: 'void',
    GetFlags: 'int', GetHealth: 'int16', Remove: 'void', GetScale: 'float', GetHeight: 'float',
    GetRadius: 'float', GetStepHeight: 'float', GetGameTicks: 'int', GetFloorHeight: 'float',
    GetCeilingHeight: 'float', GetType: 'int', GetColor: 'kVec3', GetTransparency: 'uint8',
    GetFrameID: 'int16', SetFrameID: 'void', GetTaggedActor: 'kexSlaveActor', SetTaggedActor: 'void',
    GetSourceOwner: 'kexSlaveActor', SetSourceOwner: 'void', FireActor: 'kexSlaveActor',
    CastToActor: 'kexSlaveActor', GetCollidableRadius: 'float', CanSeeLocation: 'bool', IsFacing: 'bool',
    InflictDamage: 'void', GetCollidedWallAngle: 'float', MarkCheckpoint: 'void', RandomDecision: 'bool',
    m_fScratchParam0: 'float', m_fScratchParam1: 'float', m_fScratchParam2: 'float', m_fScratchParam3: 'float',
    m_fScratchParam4: 'float', m_fScratchParam5: 'float', m_fScratchParam6: 'float', m_fScratchParam7: 'float',
    m_fScratchParam8: 'float', m_fScratchParam9: 'float',
};

export const API = {
    kexSlaveActor: ACTOR,
    kexSlaveAI: {
        $extends: 'kexSlaveActor',
        GetMoveSpeed: 'float', GetPainChance: 'int', GetTurnSpeed: 'float', GetSightDistance: 'float',
        GetMeleeExtraDistance: 'float', ClearIgniteFlames: 'void',
    },
    kexSlavePuppet: { $extends: 'kexSlaveActor', Stun: 'void' },
    kexSlavePlayer: {
        GetArtifacts: 'int', GetKeys: 'int16', GetQuestItems: 'int16', GetTeamDolls: 'uint32',
        GetAbilities: 'int', GetHealth: 'int16', GetButtons: 'int', GetActor: 'kexSlavePuppet',
        IsWeaponOwned: 'bool', HoldsterWeapon: 'void', SetShakeTime: 'void', SetLockTime: 'void',
    },
    kexSlaveObjectFactory: { SpawnActor: 'kexSlaveActor' },
    kexSlaveAutomap: { IsAlreadyMapped: 'bool', ToggleMapAll: 'void' },
    slaveRotation_s: { x: 'float', y: 'float', z: 'float' },
    kVec3: {
        x: 'float', y: 'float', z: 'float',
        Length: 'float', LengthSq: 'float', Unit: 'float', UnitSq: 'float', Distance: 'float', DistanceSq: 'float',
        Dot: 'float', Cross: 'kVec3', Normalize: 'kVec3', Lerp: 'kVec3', ToYaw: 'float', ToPitch: 'float',
        Clear: 'void', Set: 'void', ToQuat: 'kQuat',
    },
    kQuat: { x: 'float', y: 'float', z: 'float', w: 'float', Normalize: 'kQuat' },
    kAngle: { Diff: 'float', ToYaw: 'float', ToPitch: 'float' },
    kStr: { Atoi: 'int', Atof: 'float', IndexOf: 'int64', Contains: 'bool', Hash: 'uint' },
};

export const GLOBAL_FUNCS = {
    Player: 'kexSlavePlayer', ObjectFactory: 'kexSlaveObjectFactory', Automap: 'kexSlaveAutomap',
    GetDifficulty: 'int', GetLanguageID: 'uint', RandomDecision: 'bool', Print: 'void', Warning: 'void',
    VideoWidth: 'int', VideoHeight: 'int',
};

export const NAMESPACES = {
    Math: {
        Sin: 'float', Cos: 'float', Tan: 'float', ATan2: 'float', ACos: 'float', Sqrt: 'float', InvSqrt: 'float',
        Fabs: 'float', Abs: 'int', Floor: 'float', Ceil: 'float', Pow: 'float', Log: 'float',
        Deg2Rad: 'float', Rad2Deg: 'float', RandFloat: 'float', RandCFloat: 'float', RandRange: 'float',
        RandMax: 'int', RandByte: 'uint8', Rand: 'int', SysRand: 'int', Lerp: 'float', Min: 'float', Max: 'float',
        IncMax: 'float', SmoothStep: 'float', HermiteBlend: 'float', CosArc: 'float', CosTween: 'float',
        Accelerate: 'float', NLerp: 'float', Clamp: 'void',
    },
    kexSlaveRandomizer: {
        UInt8: 'uint8', UInt16: 'uint16', UInt32: 'uint32', Int8: 'int8', Int16: 'int16', Int32: 'int32',
        RInt8: 'int8', RInt16: 'int16', RInt32: 'int32', Float: 'float', RFloat: 'float', FloatVal: 'float',
        RFloatVal: 'float', RFloatMinMax: 'float', Max: 'uint32', Size: 'uint32', Bit: 'uint8', Dice: 'uint8',
    },
    kexSlaveEvents: {
        FireRemoteEventFromTag: 'void', FireActorEventFromTag: 'void', StopMusic: 'void', PlayMusic: 'void',
        PlayMusicNoLoop: 'void', PlaySound: 'void', StopAllSounds: 'void', MoveScriptedSector: 'void',
        GetActorFromMapActorIdx: 'kexSlaveActor', ChangeMap: 'void', EndGame: 'void',
        OpenDoor: 'void', CloseDoor: 'void', CloseDoorSlow: 'void', FloorLower: 'void',
        LiftLowerWaitRaise: 'void', LiftRaiseWaitLower: 'void',
    },
    kexSlaveLevelScript: { CallDelayed: 'void', Halt: 'void' },
};

// Getter methods whose reference return value scripts assign to.
export const PROP_REFS = {
    GetScale: 'scale', GetHealth: 'health', GetFlags: 'flags', GetTransparency: 'transparency',
    GetFloorHeight: 'floorHeight', GetCeilingHeight: 'ceilingHeight', GetMoveSpeed: 'moveSpeed',
    GetPainChance: 'painChance', GetTurnSpeed: 'turnSpeed', GetSightDistance: 'sightDistance',
    GetMeleeExtraDistance: 'meleeExtraDistance', GetArtifacts: 'artifacts', GetKeys: 'keys',
    GetQuestItems: 'questItems', GetTeamDolls: 'teamDolls', GetAbilities: 'abilities',
    GetSector: 'sectorRef', GetFrameID: 'frameID', GetType: 'type',
};
