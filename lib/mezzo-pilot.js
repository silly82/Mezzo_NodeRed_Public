'use strict';
/**
 * Pilot tone (Pilotton) – generator and detection used to supervise speaker lines.
 *
 * Implemented from "Mezzo Communication Protocol Specifications" issue 1.4.0.
 * NOT yet verified on a device (Mezzo 324 A, FW 1.6.1.24).
 *
 * Areas used:
 *   Sources            0x2270..0x22B4  input-side pilot tone detection per channel (enable/freq/thresholds/GPO)
 *   Diagnostic         0x7890..0x78E8  way-side pilot tone generator (0x7890) + way detection (0x78B4)
 *   SlowMeter SrcSel   0xB310..0xB360  detected rms [ch][source] + validity [ch][source]
 *   SlowMeter Ways     0xB478 (rms), 0xB4A8 (in range), 0xB4B4 (reading valid)
 * NOT handled here (load monitor / impedance module): 0x78E8..0x791C, 0x79C0, 0xB488, 0xB4AC, 0xB4B8.
 * Deprecated "Old Sources" pilot fields 0x2124/0x2158.. (spec: deprecated since 1.1.1) are not used.
 */
const { channels, toBool } = require('./mezzo-map');

const A = {
    SRC_ENABLE: 0x2270,     // u8[4]   ch
    SRC_FREQ: 0x2274,       // f32[4]  Hz
    SRC_HIGH: 0x2284,       // f32[4]  Vrms (detail table; block table says "Hz")
    SRC_LOW: 0x2294,        // f32[4]  Vrms
    SRC_GPO: 0x22a4,        // u32[4]  1 = trigger GPO if no source of the channel has a valid pilot tone
    GEN_ENABLE: 0x7890,     // u8[4]   way
    GEN_FREQ: 0x7894,       // f32[4]  Hz (may be rounded to integer by the device)
    GEN_AMPL: 0x78a4,       // f32[4]  unit not documented
    DET_ENABLE: 0x78b4,     // u8[4]   way
    DET_FREQ: 0x78b8,       // f32[4]  Hz
    DET_LOW: 0x78c8,        // f32[4]  "Lowth", unit not documented
    DET_HIGH: 0x78d8,       // f32[4]  "Highth", unit not documented
    SM_SRC_RMS: 0xb310,     // f32[4][4] [ch][source]
    SM_SRC_VALID: 0xb350,   // u8[4][4]  [ch][source]
    SM_WAY_RMS: 0xb478,     // f32[4]
    SM_WAY_INRANGE: 0xb4a8, // u8[4]  1 = detected voltage inside low..high
    SM_WAY_VALID: 0xb4b4,   // u8[4]  1 = rms reading valid
};

// Plugin safety limits (the spec defines NO ranges for these fields). Out-of-range values are refused.
const LIMITS = {
    freqMin: 10,          // Hz
    freqMax: 22000,       // Hz (DSP runs at 48 kHz; stay well below Nyquist)
    amplitudeMax: 1.0,    // raw spec value, unit undocumented -> conservative hard cap
    thresholdMax: 100,    // raw spec value (Vrms for source thresholds)
};

// Status poll: compact, each entry within one documented block group (total payload 260 bytes).
const READS = [
    ['ptSrc', A.SRC_ENABLE, 0x44],      // 0x2270..0x22B4
    ['ptWay', A.GEN_ENABLE, 0x58],      // 0x7890..0x78E8 (generator + detection, Diagnostic area)
    ['ptSrcMeter', A.SM_SRC_RMS, 0x50], // 0xB310..0xB360
    ['ptWayRms', A.SM_WAY_RMS, 16],
    ['ptWayInRange', A.SM_WAY_INRANGE, 4],
    ['ptWayValid', A.SM_WAY_VALID, 4],
];

// ---------------------------------------------------------------- decode
const r = (v, n) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** n) / 10 ** n;
const f4 = (b, o, n) => [0, 1, 2, 3].map(i => r(b.readFloatLE(o + 4 * i), n));
const b4 = (b, o) => [0, 1, 2, 3].map(i => b[o + i] !== 0);
const u32b4 = (b, o) => [0, 1, 2, 3].map(i => b.readUInt32LE(o + 4 * i) !== 0);
const ok = (b, size) => Buffer.isBuffer(b) && b.length >= size;

/** blocks: {name: Buffer|null} as produced by toBlocks(READS, replies). Returns status.pilotTone or undefined. */
function decode(d) {
    const p = {};
    if (ok(d.ptSrc, 0x44) || ok(d.ptSrcMeter, 0x50)) {
        const s = p.source = {};
        if (ok(d.ptSrc, 0x44)) {
            const b = d.ptSrc;
            s.enable = b4(b, 0);
            s.frequency = f4(b, 0x04, 1);
            s.highThreshold = f4(b, 0x14, 4);
            s.lowThreshold = f4(b, 0x24, 4);
            s.gpoEnable = u32b4(b, 0x34);
        }
        if (ok(d.ptSrcMeter, 0x50)) {
            const b = d.ptSrcMeter;
            s.rms = [0, 1, 2, 3].map(ch => f4(b, 16 * ch, 4));               // [ch][source]
            s.valid = [0, 1, 2, 3].map(ch => b4(b, 0x40 + 4 * ch));          // [ch][source]
            s.detected = s.valid.map(v => v.some(Boolean));                  // any source of the channel valid
        }
        if (s.enable && s.detected) s.missing = s.enable.map((en, i) => en && !s.detected[i]);
    }
    if (ok(d.ptWay, 0x58)) {
        const b = d.ptWay;
        p.generator = { enable: b4(b, 0x00), frequency: f4(b, 0x04, 1), amplitude: f4(b, 0x14, 4) };
        p.detect = { enable: b4(b, 0x24), frequency: f4(b, 0x28, 1), low: f4(b, 0x38, 4), high: f4(b, 0x48, 4) };
    }
    if (ok(d.ptWayRms, 16) || ok(d.ptWayInRange, 4) || ok(d.ptWayValid, 4)) {
        const det = p.detect = p.detect || {};
        if (ok(d.ptWayRms, 16)) det.rms = f4(d.ptWayRms, 0, 4);
        if (ok(d.ptWayInRange, 4)) det.inRange = b4(d.ptWayInRange, 0);
        if (ok(d.ptWayValid, 4)) det.valid = b4(d.ptWayValid, 0);
        // missing = detection enabled but measured level outside low..high (line open/short/no tone)
        if (det.enable && det.inRange) det.missing = det.enable.map((en, i) => en && !det.inRange[i]);
    }
    if (!Object.keys(p).length) return undefined;
    p.alarm = !!((p.source && p.source.missing || []).some(Boolean) || (p.detect && p.detect.missing || []).some(Boolean));
    return p;
}

// ---------------------------------------------------------------- encode
const u8 = (v) => Buffer.from([v ? 1 : 0]);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v ? 1 : 0, 0); return b; };
const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };
const given = (v) => v !== undefined && v !== null && v !== '';

function num(v, name, min, max, unit = '') {
    if (typeof v === 'boolean' || Array.isArray(v) || (typeof v === 'object' && v !== null)) throw new Error(`invalid ${name} "${v}"`);
    const n = Number(typeof v === 'string' ? v.trim().replace(',', '.') : v);
    if (!isFinite(n)) throw new Error(`invalid ${name} "${v}"`);
    if (n < min || n > max) throw new Error(`${name} ${n}${unit} out of range ${min}..${max}${unit} – refused`);
    return n;
}
const freq = (v) => num(v, 'pilot tone frequency', LIMITS.freqMin, LIMITS.freqMax, ' Hz');
const thr = (v, name) => num(v, name, 0, LIMITS.thresholdMax);

// single-field shortcuts (used by the mezzo-value catalog: value = msg.payload)
const FIELD_CMDS = {
    pilotgeneratorenable: ['pilotgenerator', 'enable'],
    pilotgeneratorfrequency: ['pilotgenerator', 'frequency'],
    pilotgeneratoramplitude: ['pilotgenerator', 'amplitude'],
    pilotdetectenable: ['pilotdetect', 'enable'],
    pilotdetectfrequency: ['pilotdetect', 'frequency'],
    pilotdetectlow: ['pilotdetect', 'low'],
    pilotdetecthigh: ['pilotdetect', 'high'],
    pilotsourceenable: ['pilotsource', 'enable'],
    pilotsourcefrequency: ['pilotsource', 'frequency'],
    pilotsourcelow: ['pilotsource', 'low'],
    pilotsourcehigh: ['pilotsource', 'high'],
    pilotsourcegpo: ['pilotsource', 'gpo'],
};

/** Collect parameters from cmd and cmd.value (object), or a scalar cmd.value as `enable`. */
function params(cmd, field) {
    const v = cmd.value;
    if (field) return { [field]: v };
    if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v)) return Object.assign({}, cmd, v);
    const p = Object.assign({}, cmd);
    if (!given(p.enable) && given(v)) p.enable = v;
    return p;
}

/**
 * cmd: {command, channel (1..4 | 'all' | array), value, enable, frequency, amplitude, low, high, gpo}
 * Returns [{op:'W', addr, data}] or null if the command is not a pilot tone command.
 * All values are validated before any op is produced (nothing is written on error).
 */
function encode(cmd) {
    let c = String(cmd && cmd.command || '').trim().toLowerCase();
    let field;
    if (FIELD_CMDS[c]) [c, field] = FIELD_CMDS[c];
    if (!['pilotgenerator', 'pilotdetect', 'pilotsource'].includes(c)) return null;
    const p = params(cmd, field);
    const chans = channels(p.channel !== undefined ? p.channel : cmd.channel);
    const has = (k) => given(p[k]);
    const en = has('enable') ? toBool(p.enable) : undefined;
    const ops = [];
    const each = (base, size, enc) => chans.forEach(i => ops.push({ op: 'W', addr: base + size * i, data: enc }));

    if (c === 'pilotgenerator') {
        const f = has('frequency') ? freq(p.frequency) : undefined;
        const a = has('amplitude') ? num(p.amplitude, 'pilot tone amplitude', 0, LIMITS.amplitudeMax) : undefined;
        if (en === undefined && f === undefined && a === undefined) throw new Error('pilotGenerator needs enable, frequency and/or amplitude');
        if (en === false) each(A.GEN_ENABLE, 1, u8(0));             // switch off first
        if (f !== undefined) each(A.GEN_FREQ, 4, fl(f));
        if (a !== undefined) each(A.GEN_AMPL, 4, fl(a));
        if (en === true) each(A.GEN_ENABLE, 1, u8(1));              // switch on last, after freq/amplitude
        return ops;
    }
    const lo = has('low') ? thr(p.low, 'pilot tone low threshold') : undefined;
    const hi = has('high') ? thr(p.high, 'pilot tone high threshold') : undefined;
    if (lo !== undefined && hi !== undefined && !(lo < hi)) throw new Error(`pilot tone low threshold ${lo} must be below high threshold ${hi}`);
    const f = has('frequency') ? freq(p.frequency) : undefined;
    if (c === 'pilotdetect') {
        if (en === undefined && f === undefined && lo === undefined && hi === undefined) throw new Error('pilotDetect needs enable, frequency, low and/or high');
        if (f !== undefined) each(A.DET_FREQ, 4, fl(f));
        if (lo !== undefined) each(A.DET_LOW, 4, fl(lo));
        if (hi !== undefined) each(A.DET_HIGH, 4, fl(hi));
        if (en !== undefined) each(A.DET_ENABLE, 1, u8(en));
        return ops;
    }
    // pilotsource
    const gpo = has('gpo') ? toBool(p.gpo) : undefined;
    if (en === undefined && f === undefined && lo === undefined && hi === undefined && gpo === undefined) {
        throw new Error('pilotSource needs enable, frequency, low, high and/or gpo');
    }
    if (f !== undefined) each(A.SRC_FREQ, 4, fl(f));
    if (lo !== undefined) each(A.SRC_LOW, 4, fl(lo));
    if (hi !== undefined) each(A.SRC_HIGH, 4, fl(hi));
    if (en !== undefined) each(A.SRC_ENABLE, 1, u8(en));
    if (gpo !== undefined) each(A.SRC_GPO, 4, u32(gpo));
    return ops;
}

const COMMANDS = ['pilotGenerator', 'pilotDetect', 'pilotSource',
    'pilotGeneratorEnable', 'pilotGeneratorFrequency', 'pilotGeneratorAmplitude',
    'pilotDetectEnable', 'pilotDetectFrequency', 'pilotDetectLow', 'pilotDetectHigh',
    'pilotSourceEnable', 'pilotSourceFrequency', 'pilotSourceLow', 'pilotSourceHigh', 'pilotSourceGpo'];

// ---------------------------------------------------------------- value catalog (mezzo-values shape)
const pt = (s, a, b) => (s.pilotTone && s.pilotTone[a] && s.pilotTone[a][b]) || undefined;
const at = (s, a, b, i) => { const x = pt(s, a, b); return x ? x[i] : undefined; };
const G = 'Pilotton';
const VALUES = [
    // generator (way / output)
    { key: 'pilotGenEnable', group: G, label: 'Generator ein (Ausgang)', scope: 'ch', src: 'status', type: 'bool', write: 'pilotGeneratorEnable',
        get: (s, i) => at(s, 'generator', 'enable', i), text: ['ein', 'aus'] },
    { key: 'pilotGenFrequency', group: G, label: 'Generator Frequenz', scope: 'ch', src: 'status', type: 'num', unit: 'Hz', dec: 0,
        write: 'pilotGeneratorFrequency', get: (s, i) => at(s, 'generator', 'frequency', i) },
    { key: 'pilotGenAmplitude', group: G, label: 'Generator Amplitude (Einheit lt. Spez. offen)', scope: 'ch', src: 'status', type: 'num', dec: 3,
        write: 'pilotGeneratorAmplitude', get: (s, i) => at(s, 'generator', 'amplitude', i) },
    // detection (way / output)
    { key: 'pilotDetectEnable', group: G, label: 'Überwachung ein (Ausgang)', scope: 'ch', src: 'status', type: 'bool', write: 'pilotDetectEnable',
        get: (s, i) => at(s, 'detect', 'enable', i), text: ['ein', 'aus'] },
    { key: 'pilotDetectFrequency', group: G, label: 'Überwachung Frequenz', scope: 'ch', src: 'status', type: 'num', unit: 'Hz', dec: 0,
        write: 'pilotDetectFrequency', get: (s, i) => at(s, 'detect', 'frequency', i) },
    { key: 'pilotDetectLow', group: G, label: 'Überwachung untere Schwelle', scope: 'ch', src: 'status', type: 'num', dec: 3,
        write: 'pilotDetectLow', get: (s, i) => at(s, 'detect', 'low', i) },
    { key: 'pilotDetectHigh', group: G, label: 'Überwachung obere Schwelle', scope: 'ch', src: 'status', type: 'num', dec: 3,
        write: 'pilotDetectHigh', get: (s, i) => at(s, 'detect', 'high', i) },
    { key: 'pilotDetectRms', group: G, label: 'Pilotton-Pegel Ausgang (RMS)', scope: 'ch', src: 'status', type: 'num', unit: 'V', dec: 3,
        get: (s, i) => at(s, 'detect', 'rms', i) },
    { key: 'pilotDetectOk', group: G, label: 'Pilotton Ausgang im Bereich', scope: 'ch', src: 'status', type: 'bool',
        get: (s, i) => at(s, 'detect', 'inRange', i), text: ['✓ OK', '✗ außerhalb'] },
    { key: 'pilotDetectMissing', group: G, label: 'Pilotton Ausgang fehlt (Leitungsalarm)', scope: 'ch', src: 'status', type: 'bool',
        get: (s, i) => at(s, 'detect', 'missing', i), text: ['⚠ FEHLT', '✓ OK'] },
    // source side (input detection per channel)
    { key: 'pilotSourceEnable', group: G, label: 'Eingangs-Pilotton-Erkennung ein', scope: 'ch', src: 'status', type: 'bool', write: 'pilotSourceEnable',
        get: (s, i) => at(s, 'source', 'enable', i), text: ['ein', 'aus'] },
    { key: 'pilotSourceFrequency', group: G, label: 'Eingangs-Pilotton Frequenz', scope: 'ch', src: 'status', type: 'num', unit: 'Hz', dec: 0,
        write: 'pilotSourceFrequency', get: (s, i) => at(s, 'source', 'frequency', i) },
    { key: 'pilotSourceLow', group: G, label: 'Eingangs-Pilotton untere Schwelle', scope: 'ch', src: 'status', type: 'num', unit: 'Vrms', dec: 3,
        write: 'pilotSourceLow', get: (s, i) => at(s, 'source', 'lowThreshold', i) },
    { key: 'pilotSourceHigh', group: G, label: 'Eingangs-Pilotton obere Schwelle', scope: 'ch', src: 'status', type: 'num', unit: 'Vrms', dec: 3,
        write: 'pilotSourceHigh', get: (s, i) => at(s, 'source', 'highThreshold', i) },
    { key: 'pilotSourceGpo', group: G, label: 'GPO bei fehlendem Eingangs-Pilotton', scope: 'ch', src: 'status', type: 'bool', write: 'pilotSourceGpo',
        get: (s, i) => at(s, 'source', 'gpoEnable', i), text: ['ein', 'aus'] },
    { key: 'pilotSourceMissing', group: G, label: 'Eingangs-Pilotton fehlt', scope: 'ch', src: 'status', type: 'bool',
        get: (s, i) => at(s, 'source', 'missing', i), text: ['⚠ FEHLT', '✓ OK'] },
    // [channel][source]: mx scope -> source = Quelle 1..4, output = Kanal 1..4
    { key: 'pilotSourceRms', group: G, label: 'Eingangs-Pilotton Pegel (Quelle → Kanal)', scope: 'mx', src: 'status', type: 'num', dec: 3,
        get: (s, i, si, oi) => { const x = pt(s, 'source', 'rms'); return x ? x[oi][si] : undefined; } },
    { key: 'pilotSourceValid', group: G, label: 'Eingangs-Pilotton gültig (Quelle → Kanal)', scope: 'mx', src: 'status', type: 'bool',
        get: (s, i, si, oi) => { const x = pt(s, 'source', 'valid'); return x ? x[oi][si] : undefined; }, text: ['✓ gültig', '✗ ungültig'] },
    { key: 'pilotAlarm', group: G, label: 'Pilotton-Alarm (beliebiger Kanal)', scope: 'dev', src: 'status', type: 'bool',
        get: (s) => (s.pilotTone ? s.pilotTone.alarm : undefined), text: ['⚠ ALARM', '✓ OK'] },
];

module.exports = { A, LIMITS, READS, COMMANDS, VALUES, decode, encode };
