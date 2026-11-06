'use strict';
/**
 * Mezzo PBus address map (protocol spec 1.2.3, verified on DMZO324_ND FW 1.6.1.24)
 * plus decoding of status blocks and encoding of control commands.
 */

const A = {
    INFO: 0x0000,          // 0x7a bytes, read only
    NICKNAME: 0x00f4,      // char[80]
    NET_INFO: 0x1300,      // 12 bytes, ip/mask/gw (big endian bytes)
    MATRIX: 0x3000,        // 0x68 bytes
    USER: 0x4000,          // 0x38 bytes
    WAYS: 0x7000,          // 0xa0 bytes
    STANDBY_TRIGGER: 0xa000, // uint32, write only
    AUTO_TURN_ON: 0xa004,  // uint32 (NAK on read with FW 1.6.1.24)
    AUTO_POWER_DOWN: 0xa008, // uint32
    SM_ALI: 0xb000,        // 8 floats
    SM_CH_TEMP: 0xb0f4,    // 4 floats
    SM_STANDBY: 0xb638,    // uint32
    SM_CH_ALARMS: 0xb640,  // 12 bytes
    SM_ALARMS: 0xb650,     // 12 bytes
    SM_MUTE_CODES: 0xb700, // 4 x uint32
    SM_EXT_GAIN: 0xb5e8,   // 4 floats
    FM_WAYS: 0xbac0,       // 0xf8 bytes up to 0xbbb8
    FM_INPUT_MATRIX: 0xba40, // 8 floats
    BLINK: 0x100000,       // uint8 write
    REBOOT: 0x100001,      // uint8 write 0xAC
};

const FAULT_CODES = ['No Fault', 'HWGoodT', 'PGoodPOn', 'CtrlVer', 'RailsPOn', 'RailsOverV', 'RailsUnderV',
    'OutDC', 'Fan Broken', 'Fan Short', 'Fan Stuck', 'Software', 'MainBoardVer', 'PGoodMon', 'FuseBlown',
    'PsuTemp', 'HiFreq', 'Model', 'OverCurrPOn'];

const MUTE_CODES = { 3: 'Positive rail out of range', 4: 'Negative rail out of range', 5: 'Short circuit',
    8: 'Over temperature', 9: 'High frequency', 14: 'Mains under voltage', 15: 'Mains over voltage' };

// ---------------------------------------------------------------- helpers
const cstr = (b) => { const i = b.indexOf(0); return b.toString('latin1', 0, i < 0 ? b.length : i); };
const ip = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const f32 = (b, o) => b.readFloatLE(o);
const r2 = (v, n = 2) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** n) / 10 ** n;
// linear -> dB; 0 (= -inf dB, i.e. off) is returned as null so it survives JSON
const lin2db = (v) => (v > 0 ? r2(20 * Math.log10(v), 2) : null);
const db2lin = (db) => (db === -Infinity || db <= -200 ? 0 : Math.pow(10, db / 20));
const f4 = (b, o) => [0, 1, 2, 3].map(i => f32(b, o + 4 * i));
const u8x4 = (b, o) => [0, 1, 2, 3].map(i => b[o + i]);
const bool4 = (b, o) => u8x4(b, o).map(Boolean);
const flagList = (v, table) => Object.keys(table).filter(k => v & (1 << Number(k))).map(k => table[k]);

function decodeInfo(b) {
    return {
        model: cstr(b.subarray(0, 20)),
        serial: cstr(b.subarray(20, 36)),
        manufacturerId: cstr(b.subarray(36, 56)),
        manufacturerModel: cstr(b.subarray(56, 76)),
        manufacturerSerial: cstr(b.subarray(76, 96)),
        firmware: cstr(b.subarray(96, 116)),
        mac: [...b.subarray(116, 122)].map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':'),
    };
}

// Status poll: one multicommand frame. Keep each entry within a single PBus area.
const STATUS_READS = [
    ['nick', A.NICKNAME, 80],
    ['net', A.NET_INFO, 12],
    ['apd', A.AUTO_POWER_DOWN, 4],
    ['ali', A.SM_ALI, 32],
    ['chtemp', A.SM_CH_TEMP, 16],
    ['standby', A.SM_STANDBY, 4],
    ['challarm', A.SM_CH_ALARMS, 12],
    ['alarm', A.SM_ALARMS, 12],
    ['mute', A.SM_MUTE_CODES, 16],
    ['user', A.USER, 0x38],
    ['ways', A.WAYS, 0xa0],
    ['matrix', A.MATRIX, 0x68],
];

const METER_READS = [
    ['fmways', A.FM_WAYS, 0xf8],
    ['fminput', A.FM_INPUT_MATRIX, 32],
];

function toBlocks(defs, replies) {
    const out = {};
    defs.forEach(([name], i) => { const r = replies[i]; out[name] = (r && !r.nak) ? r.data : null; });
    return out;
}

function decodeStatus(d) {
    const s = {};
    if (d.nick) s.nickname = cstr(d.nick);
    if (d.net) s.network = { ip: ip(d.net, 0), netmask: ip(d.net, 4), gateway: ip(d.net, 8) };
    if (d.standby) { s.standby = d.standby.readUInt32LE(0) === 1; s.on = !s.standby; }
    if (d.apd) s.autoPowerDown = d.apd.readUInt32LE(0) === 1;
    if (d.ali) {
        const v = [0, 1, 2, 3, 4, 5, 6, 7].map(i => f32(d.ali, 4 * i));
        s.supply = {
            tempTransformer: r2(v[0], 1), tempHeatsink: r2(v[1], 1), mainsVrms: r2(v[2], 1),
            vccP: r2(v[3]), vccN: r2(v[4]), fanCurrent: r2(v[5], 3), vauxP: r2(v[6]), vauxN: r2(v[7]),
        };
    }
    if (d.chtemp) s.channelTemp = f4(d.chtemp, 0).map(v => r2(v, 1));
    const alarms = {};
    if (d.challarm) {
        alarms.soaThermal = bool4(d.challarm, 0);
        alarms.temperature = bool4(d.challarm, 4);
        alarms.vrail = bool4(d.challarm, 8);
    }
    if (d.alarm) {
        alarms.fan = !!d.alarm[0];
        alarms.highOverTemperature = !!d.alarm[1];
        alarms.psTemperature = !!d.alarm[3];
        alarms.vaux = !!d.alarm[4];
        alarms.genericFault = !!d.alarm[5];
        alarms.faultCode = d.alarm[6];
        alarms.fault = FAULT_CODES[d.alarm[6]] || `code ${d.alarm[6]}`;
        const flags = d.alarm.readUInt32LE(8);
        alarms.faultFlags = flags;
        alarms.faults = FAULT_CODES.filter((_, i) => i > 0 && (flags & (1 << i)));
        s.gpoRelayClosed = !!d.alarm[7];
    }
    if (d.mute) {
        alarms.muteCodeFlags = [0, 1, 2, 3].map(i => d.mute.readUInt32LE(4 * i));
        alarms.protectionMutes = alarms.muteCodeFlags.map(v => flagList(v, MUTE_CODES));
    }
    if (Object.keys(alarms).length) {
        alarms.any = !!(alarms.fan || alarms.highOverTemperature || alarms.psTemperature || alarms.vaux ||
            alarms.genericFault || alarms.faultCode ||
            (alarms.soaThermal || []).some(Boolean) || (alarms.temperature || []).some(Boolean) ||
            (alarms.vrail || []).some(Boolean) || (alarms.muteCodeFlags || []).some(Boolean));
        s.alarms = alarms;
    }
    if (d.user) {
        s.user = {
            gainDb: f4(d.user, 0).map(lin2db),
            delay: f4(d.user, 0x10).map(v => r2(v, 6)),
            polarityInverted: bool4(d.user, 0x20),
            mute: bool4(d.user, 0x24),
            shadingDb: f4(d.user, 0x28).map(lin2db),
        };
    }
    if (d.ways) {
        s.output = {
            name: [0, 1, 2, 3].map(i => cstr(d.ways.subarray(0x50 + 16 * i, 0x60 + 16 * i))),
            gainDb: f4(d.ways, 0x10).map(lin2db),
            delay: f4(d.ways, 0x20).map(v => r2(v, 6)),
            polarityInverted: [0, 1, 2, 3].map(i => d.ways.readUInt32LE(0x30 + 4 * i) !== 0),
            mute: [0, 1, 2, 3].map(i => d.ways.readUInt32LE(0x40 + 4 * i) !== 0),
        };
    }
    if (d.matrix) {
        const m = d.matrix;
        s.input = { mute: bool4(m, 4), gainDb: f4(m, 8).map(lin2db) };
        s.matrix = {
            type: m.readUInt32LE(0),
            gainDb: [0, 1, 2, 3].map(src => f4(m, 0x18 + 16 * src).map(lin2db)), // [source][output]
            mute: [0, 1, 2, 3].map(src => bool4(m, 0x58 + 4 * src)),
        };
    }
    return s;
}

function decodeMeters(d) {
    const m = {};
    if (d.fmways) {
        const w = d.fmways;
        m.output = {
            vPeak: f4(w, 0x00).map(v => r2(v)), vRms: f4(w, 0x10).map(v => r2(v)),
            iPeak: f4(w, 0x20).map(v => r2(v, 3)), iRms: f4(w, 0x30).map(v => r2(v, 3)),
            gainReduction: f4(w, 0xd0).map(v => r2(v, 4)), // linear, 1 = no reduction
            gainReductionDb: f4(w, 0xd0).map(lin2db),
            signalPresence: bool4(w, 0xe0),
            headroom: f4(w, 0xe8).map(v => r2(v)), // linear ratio (unit not documented)
            headroomDb: f4(w, 0xe8).map(lin2db),
        };
    }
    if (d.fminput) {
        m.input = { peak: f4(d.fminput, 0).map(v => r2(v, 4)), rms: f4(d.fminput, 16).map(v => r2(v, 4)) };
        m.input.peakDb = m.input.peak.map(lin2db);
        m.input.rmsDb = m.input.rms.map(lin2db);
    }
    return m;
}

// ---------------------------------------------------------------- commands
const u8 = (v) => Buffer.from([v & 0xff]);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };

function toBool(v) {
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['1', 'true', 'on', 'yes', 'ein', 'an'].includes(s)) return true;
        if (['0', 'false', 'off', 'no', 'aus'].includes(s)) return false;
        throw new Error(`cannot interpret "${v}" as boolean`);
    }
    return !!v;
}

function chIndex(ch, name = 'channel') {
    const n = Number(ch);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error(`${name} must be 1..4 (got ${ch})`);
    return n - 1;
}

const MAX_GAIN_DB = 15; // safety clamp
/**
 * Clamp a dB value to optional cmd.min/cmd.max (manual entry ranges, e.g. -60..0).
 * Non-numeric input throws; -inf/off is passed through unchanged. Records cmd.appliedDb/cmd.clamped.
 */
function clampDb(v, cmd) {
    if (v === null || v === '-inf' || v === 'off' || v === -Infinity) { cmd.appliedDb = null; return v; }
    if (v === '' || v === undefined || typeof v === 'boolean') throw new Error(`invalid gain "${v}"`);
    let n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    if (!isFinite(n)) throw new Error(`invalid gain "${v}"`);
    const has = (x) => x !== undefined && x !== null && x !== '' && isFinite(Number(x));
    const orig = n;
    if (has(cmd.min) && n < Number(cmd.min)) n = Number(cmd.min);
    if (has(cmd.max) && n > Number(cmd.max)) n = Number(cmd.max);
    n = Math.round(n * 10) / 10;
    cmd.appliedDb = n;
    cmd.clamped = n !== Math.round(orig * 10) / 10;
    return n;
}

function gainLin(db) {
    if (db === null || db === '-inf' || db === 'off' || db === -Infinity) return 0;
    const n = Number(db);
    if (!isFinite(n)) throw new Error(`invalid gain "${db}"`);
    if (n > MAX_GAIN_DB) throw new Error(`gain ${n} dB above safety limit ${MAX_GAIN_DB} dB`);
    return db2lin(n);
}

/** Channel-ish helper: either a single channel or "all"/0 -> all four */
function channels(ch) {
    if (ch === undefined || ch === null || ch === 'all' || ch === 0 || ch === '0') return [0, 1, 2, 3];
    if (Array.isArray(ch)) return ch.map(c => chIndex(c));
    return [chIndex(ch)];
}

/**
 * Translate a command into PBus write operations.
 * cmd: { command, value, channel, source, output }
 */
function encodeCommand(cmd) {
    const c = String(cmd.command || '').trim();
    const v = cmd.value;
    switch (c.toLowerCase()) {
        case 'standby': return [{ op: 'W', addr: A.STANDBY_TRIGGER, data: u32(toBool(v) ? 1 : 0) }];
        case 'power': case 'on': return [{ op: 'W', addr: A.STANDBY_TRIGGER, data: u32(toBool(v) ? 0 : 1) }];
        case 'blink': case 'identify': return [{ op: 'W', addr: A.BLINK, data: u8(v === undefined ? 1 : (toBool(v) ? 1 : 0)) }];
        case 'autopowerdown': return [{ op: 'W', addr: A.AUTO_POWER_DOWN, data: u32(toBool(v) ? 1 : 0) }];
        case 'nickname': {
            const b = Buffer.alloc(80); b.write(String(v).slice(0, 79), 0, 'latin1');
            return [{ op: 'W', addr: A.NICKNAME, data: b }];
        }
        case 'mute': // user block mute (channel)
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.USER + 0x24 + i, data: u8(toBool(v) ? 1 : 0) }));
        case 'gain': {
            const g = clampDb(v, cmd);
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.USER + 4 * i, data: fl(gainLin(g)) }));
        }
        case 'polarity':
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.USER + 0x20 + i, data: u8(toBool(v) ? 1 : 0) }));
        case 'outputmute':
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.WAYS + 0x40 + 4 * i, data: u32(toBool(v) ? 1 : 0) }));
        case 'outputgain': {
            const g = clampDb(v, cmd);
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.WAYS + 0x10 + 4 * i, data: fl(gainLin(g)) }));
        }
        case 'inputmute':
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.MATRIX + 0x04 + i, data: u8(toBool(v) ? 1 : 0) }));
        case 'inputgain': {
            const g = clampDb(v, cmd);
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.MATRIX + 0x08 + 4 * i, data: fl(gainLin(g)) }));
        }
        case 'matrixgain': {
            const s = chIndex(cmd.source, 'source'), o = chIndex(cmd.output, 'output');
            return [{ op: 'W', addr: A.MATRIX + 0x18 + 16 * s + 4 * o, data: fl(gainLin(v)) }];
        }
        case 'matrixmute': {
            const s = chIndex(cmd.source, 'source'), o = chIndex(cmd.output, 'output');
            return [{ op: 'W', addr: A.MATRIX + 0x58 + 4 * s + o, data: u8(toBool(v) ? 1 : 0) }];
        }
        case 'reboot': return [{ op: 'W', addr: A.REBOOT, data: u8(0xac) }];
        case 'write': { // raw: value = {address, data: Buffer|hex|number[]}
            const addr = Number(v.address);
            let data = v.data;
            if (typeof data === 'string') data = Buffer.from(data.replace(/[^0-9a-f]/gi, ''), 'hex');
            else if (Array.isArray(data)) data = Buffer.from(data);
            if (!Buffer.isBuffer(data) || !data.length) throw new Error('raw write needs value.data');
            return [{ op: 'W', addr, data }];
        }
        default:
            throw new Error(`unknown command "${c}"`);
    }
}

// ---------------------------------------------------------------- relative gain (volume +/-)
// Which gain block a relative command acts on: 4 consecutive float32 (linear), one per channel.
const STEP_BLOCKS = {
    gain: A.USER,                 // user block gain (default "volume")
    output: A.WAYS + 0x10,        // way (output) gain
    input: A.MATRIX + 0x08,       // matrix pre gain
};

/** Is this a relative gain command? Returns {block, step} or null. */
function stepCommand(cmd) {
    const c = String(cmd.command || '').toLowerCase();
    const step = Math.abs(Number(cmd.step != null && cmd.step !== '' ? cmd.step : 1));
    const block = String(cmd.block || 'gain').replace(/gain$/i, '').toLowerCase() || 'gain';
    const blk = STEP_BLOCKS[block] !== undefined ? block : 'gain';
    if (c === 'volumeup') return { block: blk, step };
    if (c === 'volumedown') return { block: blk, step: -step };
    if (c === 'gainstep' || c === 'outputgainstep' || c === 'inputgainstep') {
        const s = Number(cmd.value);
        if (!isFinite(s) || s === 0) throw new Error(`${cmd.command} needs a step in dB as payload (e.g. 1 or -1)`);
        return { block: c === 'gainstep' ? 'gain' : c.replace('gainstep', ''), step: s };
    }
    return null;
}

/**
 * Compute new linear gains for a relative step.
 * current: Buffer of 4 float32 (as read from the block), chans: [0..3], limits in dB.
 * Rules: result rounded to 0.1 dB; never above max (and never above MAX_GAIN_DB);
 * stepping down stops at min (does not go to -inf); stepping up from -inf/below min starts at min.
 */
function applyStep(current, chans, step, min = -60, max = MAX_GAIN_DB) {
    min = Number(min); max = Math.min(Number(max), MAX_GAIN_DB);
    if (!(min < max)) throw new Error(`invalid volume range min ${min} / max ${max}`);
    return chans.map((i) => {
        const lin = current.readFloatLE(4 * i);
        const db = lin > 0 ? 20 * Math.log10(lin) : -Infinity;
        let nd;
        if (db < min) nd = step > 0 ? min : db;           // below range: up -> min, down -> unchanged
        else nd = Math.round((db + step) * 10) / 10;
        if (nd > max) nd = max;
        if (db >= min && nd < min) nd = min;
        // "+ 0" turns -0 (e.g. -1 + 1 after rounding) into 0
        return { channel: i + 1, fromDb: db === -Infinity ? null : r2(db, 1) + 0, toDb: nd === -Infinity ? null : nd + 0, lin: db2lin(nd) };
    });
}

const COMMANDS = ['standby', 'power', 'blink', 'mute', 'gain', 'volumeUp', 'volumeDown', 'gainStep', 'polarity', 'outputMute', 'outputGain',
    'inputMute', 'inputGain', 'matrixGain', 'matrixMute', 'nickname', 'autoPowerDown', 'reboot', 'write'];

module.exports = {
    A, FAULT_CODES, MUTE_CODES, STATUS_READS, METER_READS, COMMANDS, STEP_BLOCKS, MAX_GAIN_DB,
    stepCommand, applyStep, channels,
    decodeInfo, decodeStatus, decodeMeters, toBlocks, encodeCommand, lin2db, db2lin, toBool,
};
