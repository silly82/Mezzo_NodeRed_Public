'use strict';
/**
 * PBusX address map for Nota 142 (verified on the device) and DC Rider (from the official
 * "Dc Rider Communication Protocol Specifications" 1.0.3, not yet tested on a device) –
 * see docs/PBUSX.md. All values little endian, gains linear float32 (1.0 = 0 dB), times in seconds.
 *
 * Layout: one block per matrix input  q: 0x010000 + q*0x8000
 *         one block per output channel k: 0x180000 + k*0x20000 (user block, way, EQ, limiters …)
 * Channel counts are detected at runtime (a missing block answers NAK).
 * Where Nota and DC Rider differ (readings, input / limiter meters, alarms, extra commands)
 * the model family selects a profile (FAMILIES).
 */
const { lin2db, db2lin, toBool, applyStep, MAX_GAIN_DB } = require('./mezzo-map');
const ext = require('./pbusx-ext');

const A = {
    INFO: 0x000000,        // model id char[32] @0, model name char[32] @0x20, serial char[16] @0x40
    MAC: 0x000140,         // u8[6] big endian (DC Rider spec)
    FW: 0x000150,          // char[20] (DC Rider spec)
    NAME: 0x510000,        // AES67 device name char[64]
    SAMPLE_RATE: 0x51005c, // u32
    PROJECT_INFO: 0x600000, // char[128] free area (DC Rider)
    NICKNAME: 0x610000,    // char[20] (DC Rider client area)
    STANDBY: 0x640000,     // u32 1 = standby (DC Rider)
    STATE: 0x1000000,      // machine alarms u32 bitmask (DC Rider spec; Nota: 0 when "Ready")
    STATUS: 0x1010000,     // readings – layout differs per family
    REBOOT: 0x4000000,     // u32 0x8EB00790 → reboot (DC Rider)
    DEFAULTS: 0x4000004,   // u8 1 = sound defaults, 2 = all (DC Rider) – deliberately not exposed
    BLINK: 0x4000010,      // u8 1 = blink 10 s, 0 = stop (DC Rider)
    INPUT: 0x010000, INPUT_STRIDE: 0x8000,
    CH: 0x180000, CH_STRIDE: 0x20000,
};
const INFO_SIZE = 0x60;
const REBOOT_MAGIC = 0x8eb00790;

// offsets inside blocks
const IN_MX_PRE = 0x600;    // pre mute u32, pre gain f32 (DC Rider)
const IN_MX_MUTE = 0x700;   // u8 per output
const IN_MX_GAIN = 0x800;   // f32 per output
const IN_ALARMS = 0x4300;   // u32 bitmask (DC Rider)
const CH_USER = 0x0000;     // gain f32, delay f32, shading f32, polarity u32, mute u32 (20 bytes)
const CH_WAY = 0x5600;      // gain f32, delay f32, polarity u32, mute u32 (16 bytes; +0x10 way state u32)
const CH_WAY_NAME = 0x56a0; // char[16]
const CH_METER = 0x10000;   // 28 bytes: vPeak, vRms, iPeak, iRms, signal u32, clip u32, headroom
const CH_LIMITER_METER = 0x10400; // gain reduction f32 (DC Rider: peak, rms, clip, total)
const CH_ALARMS = 0x10900;  // u32 bitmask (DC Rider)

const MAX_CH = 16;
const USER_DELAY_MAX_MS = 100; // DC Rider user guide: input delay 0-100 ms

// alarm bit names per family (DC Rider spec 1.0.3, Nota spec 1.0.6)
const MACHINE_ALARMS = { 0: 'softwareMute', 1: 'temperatureProtection', 2: 'temperatureSensorBroken', 4: 'fanBroken' };
const OUTPUT_ALARMS = { 0: 'machineFault', 1: 'outputStageSelfMute', 2: 'vbattOutOfRange', 3: 'moduleTemperatureSensorBroken', 4: 'shortCircuit' };
const NOTA_MACHINE_ALARMS = { 0: 'hwFault', 1: 'highTemperature', 2: 'overTemperature' };
const NOTA_OUTPUT_ALARMS = { 0: 'hwFault', 1: 'shortCircuit', 2: 'outputPilotTone' };
const NOTA_INPUT_ALARMS = { 0: 'inputClipping', 1: 'inputPilotTone' };
const alarmFlags = (raw, names) => (raw ? Object.keys(names).filter((b) => raw & (1 << b)).map((b) => names[b])
    .concat(raw & ~Object.keys(names).reduce((m, b) => m | (1 << b), 0) ? [`unknown0x${(raw >>> 0).toString(16)}`] : []) : []);

/**
 * Model families: where the address maps of Nota and DC Rider differ.
 *   readings: size of the readings block at A.STATUS
 *   inMeter:  input fast meter offset/size inside the input block, peak/rms offsets
 *   limiter:  number of f32 in the limiter meter block
 */
const FAMILIES = {
    nota: {
        // official Nota spec 1.0.6 (FW 1.2.0.0); tested on the Nota 142 (FW 1.2.4.0): alarms, blink, nickname,
        // input pre gain/mute; standby (0x640000) answers NAK; reboot not tested
        // input fast meter: 4 sources per input – peak f32[4], rms f32[4], signal u8[4], clip u8[4], selected source u32
        name: 'Nota', readings: 45, inMeter: { off: 0x4000, size: 44, sources: 4 }, limiter: 7,
        alarms: { machine: NOTA_MACHINE_ALARMS, output: NOTA_OUTPUT_ALARMS, input: NOTA_INPUT_ALARMS },
        nameAddr: 0x1000, nameSize: 80, // device name set from the client (spec), falls back to the AES67 name
        alarmAreas: true, blinkPbusx: true, standby: false, nickname: true, inputPre: true, reboot: false, ext: true, verified: true,
    },
    dcrider: {
        name: 'DC Rider', readings: 33, inMeter: { off: 0x4080, size: 10, peak: 0x00, rms: 0x04, signal: 0x08, clip: 0x09 }, limiter: 4,
        alarms: { machine: MACHINE_ALARMS, output: OUTPUT_ALARMS, input: {} },
        alarmAreas: true, blinkPbusx: true, standby: true, nickname: true, inputPre: true, reboot: true, ext: false, verified: false,
    },
};
const family = (l) => FAMILIES[(l && l.family) || 'nota'] || FAMILIES.nota;

/**
 * Known models. verified=false → address map taken from the official DC Rider spec 1.0.3, not tested on a device.
 * The DC Rider spec does not list the model id strings, hence the loose patterns; the channel count is detected.
 */
const MODELS = [
    { id: 'nota142', name: 'Nota 142', family: 'nota', match: /^NOTA\s*142/i, inputs: 4, outputs: 2, verified: true },
    { id: 'dcrider408', name: 'DC Rider 408', family: 'dcrider', match: /RIDER.*408|DCR.*408/i, inputs: 8, outputs: 8, verified: false },
    { id: 'dcrider8016', name: 'DC Rider 8016', family: 'dcrider', match: /RIDER.*8016|DCR.*8016/i, inputs: 16, outputs: 16, verified: false },
    { id: 'dcrider', name: 'DC Rider', family: 'dcrider', match: /RIDER|^DCR/i, inputs: 16, outputs: 16, verified: false },
];
const modelById = (s) => MODELS.find((m) => m.id === s) || MODELS.find((m) => m.match.test(String(s || '')));

// ---------------------------------------------------------------- helpers
const cstr = (b) => { const i = b.indexOf(0); return b.toString('latin1', 0, i < 0 ? b.length : i); };
const r2 = (v, n = 2) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** n) / 10 ** n;
const inBase = (q) => A.INPUT + q * A.INPUT_STRIDE;
const chBase = (k) => A.CH + k * A.CH_STRIDE;
const range = (n) => Array.from({ length: n }, (_, i) => i);
// meters report denormal values (~1e-23) for silence → treat everything below -200 dB as -inf (null)
const meterDb = (v) => (v > 1e-10 ? lin2db(v) : null);

function decodeInfo(b) {
    return { model: cstr(b.subarray(0, 0x20)), model2: cstr(b.subarray(0x20, 0x40)), serial: cstr(b.subarray(0x40, 0x50)) };
}

/** Machine / output alarm bitmask → { raw, flags[] } (null when not read). */
const decodeAlarms = (buf, names) => {
    if (!buf) return null;
    const raw = buf.readUInt32LE(0);
    return { raw, flags: alarmFlags(raw, names) };
};

/** Read ops that probe how many input / channel blocks exist (NAK = missing). */
const LAYOUT_PROBE = [
    ...range(MAX_CH).map((q) => ({ op: 'R', addr: inBase(q) + IN_MX_GAIN, size: 4, kind: 'in' })),
    ...range(MAX_CH).map((k) => ({ op: 'R', addr: chBase(k) + CH_USER, size: 4, kind: 'ch' })),
];

/** Count consecutive non-NAK replies per kind. */
function layoutFromProbe(replies) {
    const count = (kind) => {
        const ok = LAYOUT_PROBE.map((o, i) => ({ o, r: replies[i] })).filter((x) => x.o.kind === kind).map((x) => x.r && !x.r.nak);
        const n = ok.indexOf(false);
        return n < 0 ? ok.length : n;
    };
    return { inputs: count('in'), outputs: count('ch') };
}

/** Status reads for a layout {inputs, outputs, family}. Entries: [name, addr, size]. */
function statusReads(l) {
    const f = family(l);
    const r = [['name', A.NAME, 64], ['state', A.STATE, 4], ['status', A.STATUS, f.readings]];
    if (f.nameAddr) r.push(['devname', f.nameAddr, f.nameSize]);
    if (f.standby) r.push(['standby', A.STANDBY, 4]);
    if (f.nickname) r.push(['nickname', A.NICKNAME, 20]);
    for (const k of range(l.outputs)) {
        r.push([`user${k}`, chBase(k) + CH_USER, 20], [`way${k}`, chBase(k) + CH_WAY, 16], [`wname${k}`, chBase(k) + CH_WAY_NAME, 16]);
        if (f.alarmAreas) r.push([`oal${k}`, chBase(k) + CH_ALARMS, 4]);
    }
    for (const q of range(l.inputs)) {
        r.push([`mxg${q}`, inBase(q) + IN_MX_GAIN, 4 * l.outputs], [`mxm${q}`, inBase(q) + IN_MX_MUTE, l.outputs]);
        if (f.alarmAreas) r.push([`ial${q}`, inBase(q) + IN_ALARMS, 4]);
        if (f.inputPre) r.push([`inpre${q}`, inBase(q) + IN_MX_PRE, 8]);
    }
    if (f.ext) r.push(...ext.reads(l));
    return r;
}

function meterReads(l) {
    const f = family(l);
    const r = [];
    for (const q of range(l.inputs)) r.push([`in${q}`, inBase(q) + f.inMeter.off, f.inMeter.size]);
    for (const k of range(l.outputs)) r.push([`out${k}`, chBase(k) + CH_METER, 28], [`lim${k}`, chBase(k) + CH_LIMITER_METER, 4 * f.limiter]);
    return r;
}

function toBlocks(defs, replies) {
    const out = {};
    defs.forEach(([name], i) => { const r = replies[i]; out[name] = (r && !r.nak) ? r.data : null; });
    return out;
}

/** Readings block: Nota = spec 1.0.6 (u8 + 11 x f32, unaligned); DC Rider = spec 1.0.3. */
function decodeReadings(b, fam) {
    if (fam === 'dcrider') {
        const rails = range(4).map((i) => r2(b.readFloatLE(4 * i)));
        return {
            statusCode: 0,
            supply: {
                rail: rails[0], rails, vbatt: [r2(b.readFloatLE(0x11)), r2(b.readFloatLE(0x15))],
                temperatureC: r2(b.readFloatLE(0x19), 1), temperaturePct: r2(b.readFloatLE(0x1d), 1),
            },
            callButton: b[0x10] !== 0,
        };
    }
    // Nota: call button, mic 1 peak/rms, mic 2 peak/rms, PVDD (rail), Vbatt, NTC/TAS/CPU temperature, combined °C, %
    const f = range(11).map((i) => b.readFloatLE(1 + 4 * i));
    return {
        callButton: b[0] !== 0,
        mic: [{ peak: r2(f[0], 4), rms: r2(f[1], 4) }, { peak: r2(f[2], 4), rms: r2(f[3], 4) }],
        supply: {
            rail: r2(f[4]), vbatt: r2(f[5]),
            temperatures: { ntc: r2(f[6], 1), tas: r2(f[7], 1), cpu: r2(f[8], 1) },
            temperatureC: r2(f[9], 1), temperaturePct: r2(f[10], 1),
        },
    };
}

function decodeStatus(d, l) {
    const fam = family(l);
    const s = { layout: { inputs: l.inputs, outputs: l.outputs, family: l.family || 'nota' } };
    if (d.name) s.aes67Name = cstr(d.name);
    s.name = (d.devname && cstr(d.devname)) || s.aes67Name; // Nota: device name (0x1000), else the AES67 name
    if (d.nickname) s.nickname = cstr(d.nickname);
    if (d.standby) s.standby = d.standby.readUInt32LE(0) !== 0;
    if (d.state) s.state = d.state.readUInt32LE(0);
    if (d.status) Object.assign(s, decodeReadings(d.status, l.family));
    const AL = fam.alarms;
    const machine = decodeAlarms(d.state, AL.machine);
    const output = fam.alarmAreas ? range(l.outputs).map((k) => decodeAlarms(d[`oal${k}`], AL.output)) : null;
    const input = fam.alarmAreas ? range(l.inputs).map((q) => decodeAlarms(d[`ial${q}`], AL.input)) : null;
    const anyOf = (a) => !!a && a.some((x) => x && x.raw);
    s.alarms = {
        any: !!s.state || anyOf(output) || anyOf(input),
        machine, output, input,
        verified: false, // bit meanings from the specs; no alarm state ≠ 0 observed on a device yet
    };
    if (fam.ext) Object.assign(s, ext.decode(d, l));
    const ch = range(l.outputs);
    const u = (k) => d[`user${k}`], w = (k) => d[`way${k}`];
    s.user = {
        gainDb: ch.map((k) => (u(k) ? lin2db(u(k).readFloatLE(0)) : null)),
        delay: ch.map((k) => (u(k) ? r2(u(k).readFloatLE(4), 6) : null)),
        shadingDb: ch.map((k) => (u(k) ? lin2db(u(k).readFloatLE(8)) : null)),
        polarityInverted: ch.map((k) => (u(k) ? u(k).readUInt32LE(12) !== 0 : null)),
        mute: ch.map((k) => (u(k) ? u(k).readUInt32LE(16) !== 0 : null)),
    };
    s.output = {
        name: ch.map((k) => (d[`wname${k}`] ? cstr(d[`wname${k}`]) : '')),
        gainDb: ch.map((k) => (w(k) ? lin2db(w(k).readFloatLE(0)) : null)),
        delay: ch.map((k) => (w(k) ? r2(w(k).readFloatLE(4), 6) : null)),
        polarityInverted: ch.map((k) => (w(k) ? w(k).readUInt32LE(8) !== 0 : null)),
        mute: ch.map((k) => (w(k) ? w(k).readUInt32LE(12) !== 0 : null)),
    };
    if (fam.inputPre) {
        const p = (q) => d[`inpre${q}`];
        s.input = {
            gainDb: range(l.inputs).map((q) => (p(q) ? lin2db(p(q).readFloatLE(4)) : null)),
            mute: range(l.inputs).map((q) => (p(q) ? p(q).readUInt32LE(0) !== 0 : null)),
        };
    }
    s.matrix = {
        gainDb: range(l.inputs).map((q) => ch.map((o) => (d[`mxg${q}`] ? lin2db(d[`mxg${q}`].readFloatLE(4 * o)) : null))),
        mute: range(l.inputs).map((q) => ch.map((o) => (d[`mxm${q}`] ? d[`mxm${q}`][o] !== 0 : null))),
    };
    return s;
}

function decodeMeters(d, l) {
    const fam = family(l), im = fam.inMeter;
    const ins = range(l.inputs), ch = range(l.outputs);
    const fi = (q, o) => (d[`in${q}`] ? d[`in${q}`].readFloatLE(o) : null);
    const bi = (q, o) => (d[`in${q}`] && o !== undefined ? d[`in${q}`][o] !== 0 : null);
    const fo = (k, o) => (d[`out${k}`] ? d[`out${k}`].readFloatLE(o) : null);
    const lim = (k, i) => (d[`lim${k}`] ? d[`lim${k}`].readFloatLE(4 * i) : null);
    // Nota: 4 sources per input → report the selected source (+0x28), all sources in input.sources
    const sel = ins.map((q) => (im.sources && d[`in${q}`] ? d[`in${q}`].readUInt32LE(0x28) : null));
    const srcOf = (q) => (sel[q] !== null && sel[q] < im.sources ? sel[q] : 0);
    const peak = ins.map((q) => fi(q, im.sources ? 4 * srcOf(q) : im.peak));
    const rms = ins.map((q) => fi(q, im.sources ? 0x10 + 4 * srcOf(q) : im.rms));
    const head = ch.map((k) => fo(k, 24));
    const m = {
        input: { peak: peak.map((v) => r2(v, 4)), rms: rms.map((v) => r2(v, 4)), peakDb: peak.map(meterDb), rmsDb: rms.map(meterDb) },
        output: {
            vPeak: ch.map((k) => r2(fo(k, 0))), vRms: ch.map((k) => r2(fo(k, 4))),
            iPeak: ch.map((k) => r2(fo(k, 8), 3)), iRms: ch.map((k) => r2(fo(k, 12), 3)),
            signalPresence: ch.map((k) => (d[`out${k}`] ? d[`out${k}`].readUInt32LE(16) !== 0 : null)),
            clip: ch.map((k) => (d[`out${k}`] ? d[`out${k}`].readUInt32LE(20) !== 0 : null)),
            headroom: head.map((v) => r2(v)),
            headroomDb: head.map(lin2db),
            limiterRaw: ch.map((k) => (d[`lim${k}`] ? range(fam.limiter).map((i) => r2(lim(k, i), 4)) : null)),
        },
    };
    if (im.signal !== undefined) {
        m.input.signalPresence = ins.map((q) => bi(q, im.signal));
        m.input.clip = ins.map((q) => bi(q, im.clip));
    }
    if (im.sources) {
        m.input.signalPresence = ins.map((q) => bi(q, 0x20 + srcOf(q)));
        m.input.clip = ins.map((q) => bi(q, 0x24 + srcOf(q)));
        m.input.selectedSource = sel.map((v) => (v === null ? null : v + 1)); // 1..4
        const all = (fn) => ins.map((q) => (d[`in${q}`] ? range(im.sources).map((s) => fn(q, s)) : null));
        m.input.sources = {
            peakDb: all((q, s) => meterDb(fi(q, 4 * s))),
            rmsDb: all((q, s) => meterDb(fi(q, 0x10 + 4 * s))),
            signalPresence: all((q, s) => bi(q, 0x20 + s)),
            clip: all((q, s) => bi(q, 0x24 + s)),
        };
    }
    // gain reduction (spec: GainReductionVoltageLimiterPeak / Rms / ClipLimiter / Total) as linear factor –
    // the Nota reads 1.0 without limiting, so 1.0 = 0 dB reduction; dB values are ≤ 0
    const grDb = (v) => (v == null ? null : v > 0 ? Math.min(0, lin2db(v)) : null);
    m.output.limiter = ch.map((k) => (d[`lim${k}`]
        ? { peak: r2(lim(k, 0), 4), rms: r2(lim(k, 1), 4), clip: r2(lim(k, 2), 4), total: r2(lim(k, 3), 4), totalDb: grDb(lim(k, 3)),
            ...(fam.limiter > 4 ? { dynamicEqDb: range(fam.limiter - 4).map((i) => grDb(lim(k, 4 + i))) } : {}) }
        : null));
    return m;
}

// ---------------------------------------------------------------- commands
const u8 = (v) => Buffer.from([v & 0xff]);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };

function idx(v, n, name) {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1 || x > n) throw new Error(`${name} must be 1..${n} (got ${v})`);
    return x - 1;
}

/** Single channel, "all"/0/empty → all channels of the layout. */
function channels(ch, n) {
    if (ch === undefined || ch === null || ch === '' || ch === 'all' || ch === 0 || ch === '0') return range(n);
    if (Array.isArray(ch)) return ch.map((c) => idx(c, n, 'channel'));
    return [idx(ch, n, 'channel')];
}

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

function delaySeconds(v) {
    const ms = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    if (!isFinite(ms) || ms < 0 || ms > USER_DELAY_MAX_MS) throw new Error(`delay must be 0..${USER_DELAY_MAX_MS} ms (got ${v})`);
    return ms / 1000;
}

/** Throw when the model family has no such feature (e.g. standby on the Nota). */
function needs(l, feature, cmd) {
    if (!family(l)[feature]) throw new Error(`command "${cmd.command}" is not available on ${family(l).name} (DC Rider only)`);
}

/** PBusX blink op (DC Rider: 1 = blink 10 s, 0 = stop); null → use the discovery text protocol (Nota). */
const blinkOp = (l, on) => (family(l).blinkPbusx ? { op: 'W', addr: A.BLINK, data: u8(on ? 1 : 0) } : null);

/** Translate a command into PBusX write operations. l = layout {inputs, outputs, family}. */
function encodeCommand(cmd, l) {
    const c = String(cmd.command || '').trim().toLowerCase();
    const v = cmd.value;
    if (ext.COMMANDS.some((x) => x.toLowerCase() === c)) {
        if (!family(l).ext) throw new Error(`command "${cmd.command}" is not available on ${family(l).name} (Nota only)`);
        return ext.encode(cmd, l);
    }
    const chs = () => channels(cmd.channel, l.outputs);
    switch (c) {
        case 'gain': { const g = clampDb(v, cmd); return chs().map((k) => ({ op: 'W', addr: chBase(k) + CH_USER, data: fl(gainLin(g)) })); }
        case 'delay': { const s = delaySeconds(v); return chs().map((k) => ({ op: 'W', addr: chBase(k) + CH_USER + 4, data: fl(s) })); }
        case 'polarity': return chs().map((k) => ({ op: 'W', addr: chBase(k) + CH_USER + 12, data: u32(toBool(v) ? 1 : 0) }));
        case 'mute': return chs().map((k) => ({ op: 'W', addr: chBase(k) + CH_USER + 16, data: u32(toBool(v) ? 1 : 0) }));
        case 'outputgain': { const g = clampDb(v, cmd); return chs().map((k) => ({ op: 'W', addr: chBase(k) + CH_WAY, data: fl(gainLin(g)) })); }
        case 'outputpolarity': return chs().map((k) => ({ op: 'W', addr: chBase(k) + CH_WAY + 8, data: u32(toBool(v) ? 1 : 0) }));
        case 'outputmute': return chs().map((k) => ({ op: 'W', addr: chBase(k) + CH_WAY + 12, data: u32(toBool(v) ? 1 : 0) }));
        case 'matrixgain': {
            const q = idx(cmd.source, l.inputs, 'source'), o = idx(cmd.output, l.outputs, 'output');
            return [{ op: 'W', addr: inBase(q) + IN_MX_GAIN + 4 * o, data: fl(gainLin(v)) }];
        }
        case 'matrixmute': {
            const q = idx(cmd.source, l.inputs, 'source'), o = idx(cmd.output, l.outputs, 'output');
            return [{ op: 'W', addr: inBase(q) + IN_MX_MUTE + o, data: u8(toBool(v) ? 1 : 0) }];
        }
        // ---- DC Rider only (spec 1.0.3)
        case 'inputgain': {
            needs(l, 'inputPre', cmd);
            const q = idx(cmd.source !== undefined && cmd.source !== '' ? cmd.source : cmd.channel, l.inputs, 'source');
            const g = clampDb(v, cmd);
            return [{ op: 'W', addr: inBase(q) + IN_MX_PRE + 4, data: fl(gainLin(g)) }];
        }
        case 'inputmute': {
            needs(l, 'inputPre', cmd);
            const q = idx(cmd.source !== undefined && cmd.source !== '' ? cmd.source : cmd.channel, l.inputs, 'source');
            return [{ op: 'W', addr: inBase(q) + IN_MX_PRE, data: u32(toBool(v) ? 1 : 0) }];
        }
        case 'standby': case 'power': {
            needs(l, 'standby', cmd);
            const on = c === 'power' ? !toBool(v) : toBool(v);
            return [{ op: 'W', addr: A.STANDBY, data: u32(on ? 1 : 0) }];
        }
        case 'nickname': {
            needs(l, 'nickname', cmd);
            const b = Buffer.alloc(20);
            Buffer.from(String(v == null ? '' : v), 'latin1').copy(b, 0, 0, 19);
            return [{ op: 'W', addr: A.NICKNAME, data: b }];
        }
        case 'reboot': {
            needs(l, 'reboot', cmd);
            if (v !== 'reboot' && v !== true) throw new Error('reboot needs payload "reboot" (safety)');
            return [{ op: 'W', addr: A.REBOOT, data: u32(REBOOT_MAGIC) }];
        }
        case 'write': {
            const addr = Number(v && v.address);
            let data = v && v.data;
            if (typeof data === 'string') data = Buffer.from(data.replace(/[^0-9a-f]/gi, ''), 'hex');
            else if (Array.isArray(data)) data = Buffer.from(data);
            if (!isFinite(addr) || !Buffer.isBuffer(data) || !data.length) throw new Error('raw write needs value.address and value.data');
            return [{ op: 'W', addr, data }];
        }
        default:
            throw new Error(`unknown command "${cmd.command}"`);
    }
}

// ---------------------------------------------------------------- relative gain (volume +/-)
const STEP_BLOCKS = { gain: CH_USER, output: CH_WAY };

function stepCommand(cmd) {
    const c = String(cmd.command || '').toLowerCase();
    const step = Math.abs(Number(cmd.step != null && cmd.step !== '' ? cmd.step : 1));
    const block = String(cmd.block || 'gain').replace(/gain$/i, '').toLowerCase() || 'gain';
    const blk = STEP_BLOCKS[block] !== undefined ? block : 'gain';
    if (c === 'volumeup') return { block: blk, step };
    if (c === 'volumedown') return { block: blk, step: -step };
    if (c === 'gainstep' || c === 'outputgainstep') {
        const s = Number(cmd.value);
        if (!isFinite(s) || s === 0) throw new Error(`${cmd.command} needs a step in dB as payload (e.g. 1 or -1)`);
        return { block: c === 'gainstep' ? 'gain' : 'output', step: s };
    }
    return null;
}

/** Address of the gain float of channel index k in a step block. */
const stepAddr = (block, k) => chBase(k) + STEP_BLOCKS[block];

const COMMANDS = ['blink', 'gain', 'volumeUp', 'volumeDown', 'gainStep', 'delay', 'polarity', 'mute',
    'outputGain', 'outputPolarity', 'outputMute', 'matrixGain', 'matrixMute',
    'inputGain', 'inputMute', 'standby', 'power', 'nickname', 'reboot', 'write', ...ext.COMMANDS];

module.exports = {
    A, INFO_SIZE, MODELS, FAMILIES, MAX_CH, MAX_GAIN_DB, USER_DELAY_MAX_MS, COMMANDS, STEP_BLOCKS, LAYOUT_PROBE,
    MACHINE_ALARMS, OUTPUT_ALARMS, NOTA_MACHINE_ALARMS, NOTA_OUTPUT_ALARMS, NOTA_INPUT_ALARMS, REBOOT_MAGIC,
    modelById, family, cstr, decodeInfo, layoutFromProbe, statusReads, meterReads, toBlocks, decodeStatus, decodeMeters,
    encodeCommand, blinkOp, channels, stepCommand, stepAddr, applyStep, lin2db, db2lin, toBool, inBase, chBase,
};
