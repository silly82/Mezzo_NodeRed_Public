'use strict';
/**
 * Nota (spec 1.0.6): user EQ, dynamic EQ and AES67 routing – used through pbusx-ext.js.
 *
 * User EQ, output channel k, band b = 0..3: 0x180000 + k*0x20000 + 0x100 + b*0x80 (24 bytes, own area)
 *   u32 enabled, u32 type, f32 Q, f32 slope, u32 frequency (Hz), f32 gain – spec says "linear", but measured on the
 *   Nota 142 with music (10.11.2026): the value is in dB (factory 0 = 0 dB; +6 → about +5 dB with a 20 kHz low shelf)
 * Dynamic EQ, way k, band b = 0..2: 0x180000 + k*0x20000 + 0x6600 + b*0x80 (46 bytes, unaligned)
 *   u8 enabled, u32 filter type (0 peaking, 1 low shelf, 2 high shelf), f32 frequency, f32 Q, f32 min gain dB, f32 slope,
 *   f32 ratio, u32 limiter type, f32 threshold, f32 attack (s), f32 release (s), u32 position (0 pre RMS, 1 post RMS,
 *   2 post peak limiter), u8 sub position. Gain reduction in the limiter meter k-block +0x10410 (3 x f32, linear).
 * AES67 routing, AES67 transmit channel n = 0..3: 0x530000 + n*0x100 (6 bytes)
 *   f32 gain (linear), u8 tap type, u8 channel
 */
const { lin2db, db2lin, toBool } = require('./mezzo-map');

const CH = (k) => 0x180000 + k * 0x20000;
const UEQ = (k, b) => CH(k) + 0x100 + b * 0x80;
const DEQ = (k, b) => CH(k) + 0x6600 + b * 0x80;
const AES = (n) => 0x530000 + n * 0x100;
const UEQ_BANDS = 4, DEQ_BANDS = 3, AES_TX = 4;

const EQ_TYPES = { 0: 'peaking', 11: 'lowShelf', 12: 'highShelf', 13: 'lowPass', 14: 'highPass', 15: 'bandPass', 16: 'bandStop', 17: 'allPass' };
const DEQ_TYPES = { 0: 'peaking', 1: 'lowShelf', 2: 'highShelf' };
const DEQ_POS = { 0: 'preRmsLimiter', 1: 'postRmsLimiter', 2: 'postPeakLimiter' };
const TAPS = { 0: 'off', 1: 'sourceSelection', 2: 'matrix', 3: 'processing', 4: 'unprocessedInput', 5: 'processingCurrent', 6: 'processingVoltage' };
const LIM = { freq: [10, 22000], q: [0.1, 50], slope: [0, 100], eqGainDb: [-15, 15], minGainDb: [-60, 0], ratio: [0, 100],
    threshold: [-200, 200], time: [0.0001, 10], aesGainDb: [-80, 15] };

const range = (n) => Array.from({ length: n }, (_, i) => i);
const r2 = (v, n = 2) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** n) / 10 ** n;
const u8 = (v) => Buffer.from([v & 0xff]);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };
const name = (table, v) => (table[v] !== undefined ? table[v] : `code ${v}`);

function reads(l) {
    const r = [];
    for (const k of range(l.outputs)) {
        for (const b of range(UEQ_BANDS)) r.push([`xueq${k}_${b}`, UEQ(k, b), 24]);
        for (const b of range(DEQ_BANDS)) r.push([`xdeq${k}_${b}`, DEQ(k, b), 46]);
    }
    for (const n of range(AES_TX)) r.push([`xaes${n}`, AES(n), 6]);
    return r;
}

function decode(d, l) {
    const out = {};
    const ch = range(l.outputs);
    if (ch.some((k) => range(UEQ_BANDS).some((b) => d[`xueq${k}_${b}`]))) {
        out.userEq = ch.map((k) => range(UEQ_BANDS).map((b) => {
            const x = d[`xueq${k}_${b}`];
            if (!x) return null;
            const type = x.readUInt32LE(4);
            return { enabled: x.readUInt32LE(0) !== 0, type, typeName: name(EQ_TYPES, type), q: r2(x.readFloatLE(8), 3),
                slope: r2(x.readFloatLE(12), 3), frequency: x.readUInt32LE(16), gainDb: r2(x.readFloatLE(20), 2) };
        }));
    }
    if (ch.some((k) => range(DEQ_BANDS).some((b) => d[`xdeq${k}_${b}`]))) {
        out.dynamicEq = ch.map((k) => range(DEQ_BANDS).map((b) => {
            const x = d[`xdeq${k}_${b}`];
            if (!x) return null;
            const type = x.readUInt32LE(1), pos = x.readUInt32LE(0x29);
            return {
                enabled: x[0] !== 0, type, typeName: name(DEQ_TYPES, type), frequency: r2(x.readFloatLE(5), 1), q: r2(x.readFloatLE(9), 3),
                minGainDb: r2(x.readFloatLE(0xd), 2), slope: r2(x.readFloatLE(0x11), 3), ratio: r2(x.readFloatLE(0x15), 4),
                limiterType: x.readUInt32LE(0x19), threshold: r2(x.readFloatLE(0x1d), 3), attack: r2(x.readFloatLE(0x21), 4),
                release: r2(x.readFloatLE(0x25), 4), position: pos, positionName: name(DEQ_POS, pos), subPosition: x[0x2d],
            };
        }));
    }
    if (range(AES_TX).some((n) => d[`xaes${n}`])) {
        out.aes67Routing = range(AES_TX).map((n) => {
            const x = d[`xaes${n}`];
            if (!x) return null;
            return { gainDb: lin2db(x.readFloatLE(0)), tap: x[4], tapName: name(TAPS, x[4]), channel: x[5] };
        });
    }
    return out;
}

// ---------------------------------------------------------------- commands
function idx(v, n, what) {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1 || x > n) throw new Error(`${what} must be 1..${n} (got ${v})`);
    return x - 1;
}
const list = (v, n, what) => (v === undefined || v === null || v === '' || v === 'all' || v === 0 || v === '0'
    ? range(n) : Array.isArray(v) ? v.map((x) => idx(x, n, what)) : [idx(v, n, what)]);
function num(v, [lo, hi], what) {
    const x = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !isFinite(x)) throw new Error(`${what}: invalid value "${v}"`);
    if (x < lo || x > hi) throw new Error(`${what} ${x} out of range ${lo}..${hi} – refused`);
    return x;
}
/** Enum by number or name (case-insensitive). */
function enumOf(v, table, what) {
    const keys = Object.keys(table).map(Number);
    const n = Number(v);
    if (Number.isInteger(n) && keys.includes(n)) return n;
    const hit = keys.find((k) => table[k].toLowerCase() === String(v).toLowerCase());
    if (hit === undefined) throw new Error(`${what} must be one of ${keys.map((k) => `${k}/${table[k]}`).join(', ')} (got ${v})`);
    return hit;
}
const params = (cmd) => (cmd.value && typeof cmd.value === 'object' && !Array.isArray(cmd.value) ? { ...cmd, ...cmd.value } : cmd);
const has = (o, k) => o[k] !== undefined && o[k] !== null && o[k] !== '';

/** Field writes [offset, data] → ops for every addressed block; enable written last when switching on, first when off. */
function ops(bases, fields, en, enOff, enData) {
    const w = [...fields];
    if (en === true) w.push([enOff, enData(1)]); else if (en === false) w.unshift([enOff, enData(0)]);
    if (!w.length) throw new Error('nothing to write');
    return bases.flatMap((base) => w.map(([o, data]) => ({ op: 'W', addr: base + o, data })));
}

function encode(cmd, l) {
    const c = String(cmd.command || '').trim().toLowerCase();
    const p = params(cmd), v = cmd.value;
    const plainEnable = () => (typeof v !== 'object' && v !== undefined ? toBool(v) : null);
    switch (c) {
        case 'usereq': {
            const ks = list(cmd.channel, l.outputs, 'channel'), bs = list(p.band, UEQ_BANDS, 'band');
            const f = [];
            if (has(p, 'type')) f.push([4, u32(enumOf(p.type, EQ_TYPES, 'EQ type'))]);
            if (has(p, 'q')) f.push([8, fl(num(p.q, LIM.q, 'Q'))]);
            if (has(p, 'slope')) f.push([12, fl(num(p.slope, LIM.slope, 'slope'))]);
            if (has(p, 'frequency')) f.push([16, u32(Math.round(num(p.frequency, LIM.freq, 'frequency')))]);
            if (has(p, 'gainDb') || has(p, 'gain')) f.push([20, fl(num(has(p, 'gainDb') ? p.gainDb : p.gain, LIM.eqGainDb, 'EQ gain dB'))]);
            const en = has(p, 'enable') ? toBool(p.enable) : plainEnable();
            return ops(ks.flatMap((k) => bs.map((b) => UEQ(k, b))), f, en, 0, u32);
        }
        case 'dynamiceq': {
            const ks = list(cmd.channel, l.outputs, 'channel'), bs = list(p.band, DEQ_BANDS, 'band');
            const f = [];
            if (has(p, 'type')) f.push([1, u32(enumOf(p.type, DEQ_TYPES, 'dynamic EQ type'))]);
            if (has(p, 'frequency')) f.push([5, fl(num(p.frequency, LIM.freq, 'frequency'))]);
            if (has(p, 'q')) f.push([9, fl(num(p.q, LIM.q, 'Q'))]);
            if (has(p, 'minGainDb')) f.push([0xd, fl(num(p.minGainDb, LIM.minGainDb, 'min gain dB'))]);
            if (has(p, 'slope')) f.push([0x11, fl(num(p.slope, LIM.slope, 'slope'))]);
            if (has(p, 'ratio')) f.push([0x15, fl(num(p.ratio, LIM.ratio, 'ratio'))]);
            if (has(p, 'threshold')) f.push([0x1d, fl(num(p.threshold, LIM.threshold, 'threshold'))]);
            if (has(p, 'attack')) f.push([0x21, fl(num(p.attack, LIM.time, 'attack s'))]);
            if (has(p, 'release')) f.push([0x25, fl(num(p.release, LIM.time, 'release s'))]);
            if (has(p, 'position')) f.push([0x29, u32(enumOf(p.position, DEQ_POS, 'position'))]);
            const en = has(p, 'enable') ? toBool(p.enable) : plainEnable();
            return ops(ks.flatMap((k) => bs.map((b) => DEQ(k, b))), f, en, 0, u8);
        }
        case 'aes67route': {
            // AES67 transmit channel 1..4 = output (or channel); tap + source channel + gain dB
            const ns = list(has(p, 'output') ? p.output : cmd.channel, AES_TX, 'AES67 output');
            const f = [];
            if (has(p, 'gainDb') || has(p, 'gain')) {
                const g = has(p, 'gainDb') ? p.gainDb : p.gain;
                f.push([0, fl(g === 'off' ? 0 : db2lin(num(g, LIM.aesGainDb, 'AES67 gain dB')))]);
            }
            if (has(p, 'tap')) f.push([4, u8(enumOf(p.tap, TAPS, 'AES67 tap'))]);
            if (has(p, 'source')) f.push([5, u8(num(p.source, [0, 255], 'AES67 source channel'))]);
            if (!has(p, 'tap') && typeof v !== 'object' && v !== undefined) f.push([4, u8(enumOf(v, TAPS, 'AES67 tap'))]);
            return ops(ns.map(AES), f, null);
        }
        default: return null;
    }
}

const COMMANDS = ['userEq', 'dynamicEq', 'aes67Route'];

module.exports = { reads, decode, encode, COMMANDS, EQ_TYPES, DEQ_TYPES, DEQ_POS, TAPS, LIM };
