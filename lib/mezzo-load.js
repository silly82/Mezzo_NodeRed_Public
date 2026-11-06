'use strict';
/**
 * Load monitor (speaker impedance supervision) for Powersoft Mezzo.
 *
 * Implemented from "Mezzo Communication Protocol Specifications" issue 1.4.0.
 * NOT yet verified on a device (Mezzo 324 A, FW 1.6.1.24).
 *
 * Spec areas used:
 *   0x78E8  u8[4]   R/W  Way Load Monitor Enable (way 1..4)
 *   0x78EC  f32[4]  R/W  Way Load Monitor Frequency (Hz assumed; "may be rounded to closest integer")
 *   0x78FC  f32[4]  R/W  Way Load Monitor Lowth  (low threshold, Ohm assumed)
 *   0x790C  f32[4]  R/W  Way Load Monitor Highth (high threshold, Ohm assumed)
 *   0x79C0  f32[4]  R/W  Vrms Load Monitor Sensibility (volatile, default 0.5 Vrms, 0.01..10 Vrms)
 *   0xB488  f32[4]  R    PilotToneDetectionImpedance (detected impedance with pilot tone)
 *   0xB4AC  u8[4]   R    PilotToneDetectedImpedance (1 = impedance inside specified range)
 *   0xB4B8  u32[4]  R    PilotToneDetectionImpedanceRmsIsValid (1 = impedance reading valid)
 *
 * Boundary: pilot tone generator / pilot tone settings (0x7890..0x78E8) and the pilot tone
 * rms readings (0xB478, 0xB4A8, 0xB4B4) belong to the pilot tone module.
 */
const { channels, toBool } = require('./mezzo-map');

const A = {
    LM_ENABLE: 0x78e8,      // u8 x4
    LM_FREQ: 0x78ec,        // f32 x4
    LM_LOW: 0x78fc,         // f32 x4
    LM_HIGH: 0x790c,        // f32 x4
    LM_SENS: 0x79c0,        // f32 x4 (volatile)
    SM_IMPEDANCE: 0xb488,   // f32 x4
    SM_IMP_INRANGE: 0xb4ac, // u8 x4
    SM_IMP_VALID: 0xb4b8,   // u32 x4
};

const SENS_MIN = 0.01, SENS_MAX = 10, SENS_DEFAULT = 0.5;
// Spec gives no ranges for frequency/thresholds; these are plausibility limits only.
const FREQ_MIN = 1, FREQ_MAX = 24000;
const OHM_MIN = 0, OHM_MAX = 1000;

// [name, addr, size] - 5 reads, 104 bytes payload in total.
const READS = [
    ['lmcfg', A.LM_ENABLE, 0x34],      // enable + frequency + low + high (0x78E8..0x791C)
    ['lmsens', A.LM_SENS, 16],
    ['lmimp', A.SM_IMPEDANCE, 16],
    ['lminrange', A.SM_IMP_INRANGE, 4],
    ['lmvalid', A.SM_IMP_VALID, 16],
];

const r = (v, n) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** n) / 10 ** n;
const f4 = (b, o) => [0, 1, 2, 3].map(i => b.readFloatLE(o + 4 * i));

/** blocks: {lmcfg, lmsens, lmimp, lminrange, lmvalid} (Buffer or null) -> status.loadMonitor or null */
function decode(blocks) {
    const d = blocks || {};
    const lm = {};
    if (d.lmcfg && d.lmcfg.length >= 0x34) {
        const b = d.lmcfg;
        lm.enabled = [0, 1, 2, 3].map(i => b[i] !== 0);
        lm.frequency = f4(b, 0x04).map(v => r(v, 1));
        lm.low = f4(b, 0x14).map(v => r(v, 2));
        lm.high = f4(b, 0x24).map(v => r(v, 2));
    }
    if (d.lmsens && d.lmsens.length >= 16) lm.sensibility = f4(d.lmsens, 0).map(v => r(v, 3));
    if (d.lmimp && d.lmimp.length >= 16) lm.impedance = f4(d.lmimp, 0).map(v => r(v, 2));
    if (d.lminrange && d.lminrange.length >= 4) lm.inRange = [0, 1, 2, 3].map(i => d.lminrange[i] !== 0);
    if (d.lmvalid && d.lmvalid.length >= 16) lm.impedanceValid = [0, 1, 2, 3].map(i => d.lmvalid.readUInt32LE(4 * i) !== 0);
    if (!Object.keys(lm).length) return null;

    // Derived: enabled, valid (if known) and impedance outside [low, high].
    lm.outOfRange = [0, 1, 2, 3].map((i) => {
        if (!lm.enabled || !lm.enabled[i]) return false;
        if (lm.impedanceValid && !lm.impedanceValid[i]) return false;
        const z = lm.impedance ? lm.impedance[i] : null;
        if (z === null || lm.low[i] === null || lm.high[i] === null) return false;
        return z < lm.low[i] || z > lm.high[i];
    });
    lm.any = lm.outOfRange.some(Boolean);
    return lm;
}

// ---------------------------------------------------------------- encoding
const u8 = (v) => Buffer.from([v & 0xff]);
const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };
const has = (x) => x !== undefined && x !== null && x !== '';

function num(v, name, min, max) {
    const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    if (typeof v === 'boolean' || !isFinite(n)) throw new Error(`${name}: invalid number "${v}"`);
    if (n < min || n > max) throw new Error(`${name} must be ${min}..${max} (got ${n})`);
    return n;
}

const COMMANDS = ['loadMonitor', 'loadMonitorEnable', 'loadMonitorFrequency', 'loadMonitorLow', 'loadMonitorHigh', 'loadSensibility'];

/**
 * Translate a load monitor command into PBus writes, or null if the command is not ours.
 *  loadMonitor          {channel, enable?, frequency?, low?, high?}  (fields also accepted in cmd.value)
 *  loadMonitorEnable    {channel, value: bool}
 *  loadMonitorFrequency {channel, value: Hz}
 *  loadMonitorLow/High  {channel, value: Ohm}
 *  loadSensibility      {channel, value: Vrms 0.01..10}  (volatile)
 * channel: 1..4, 'all'/0/undefined = all four, or an array.
 */
function encode(cmd) {
    const c = String((cmd && cmd.command) || '').trim().toLowerCase();
    if (!COMMANDS.some(k => k.toLowerCase() === c)) return null;
    const v = cmd.value;
    const ch = channels(cmd.channel);
    const need = () => { if (!has(v)) throw new Error(`${cmd.command} needs a value`); return v; };
    const fwrite = (base, val) => ch.map(i => ({ op: 'W', addr: base + 4 * i, data: fl(val) }));
    switch (c) {
        case 'loadmonitorenable':
            return ch.map(i => ({ op: 'W', addr: A.LM_ENABLE + i, data: u8(toBool(need()) ? 1 : 0) }));
        case 'loadmonitorfrequency':
            return fwrite(A.LM_FREQ, num(need(), 'frequency', FREQ_MIN, FREQ_MAX));
        case 'loadmonitorlow':
            return fwrite(A.LM_LOW, num(need(), 'low', OHM_MIN, OHM_MAX));
        case 'loadmonitorhigh':
            return fwrite(A.LM_HIGH, num(need(), 'high', OHM_MIN, OHM_MAX));
        case 'loadsensibility':
            return fwrite(A.LM_SENS, num(need(), 'sensibility', SENS_MIN, SENS_MAX));
        case 'loadmonitor': {
            const p = Object.assign({}, (v && typeof v === 'object' && !Array.isArray(v)) ? v : {});
            for (const k of ['enable', 'frequency', 'low', 'high', 'sensibility']) if (has(cmd[k])) p[k] = cmd[k];
            if ((typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') && !has(p.enable)) p.enable = v;
            // validate everything before producing any op
            const freq = has(p.frequency) ? num(p.frequency, 'frequency', FREQ_MIN, FREQ_MAX) : null;
            const low = has(p.low) ? num(p.low, 'low', OHM_MIN, OHM_MAX) : null;
            const high = has(p.high) ? num(p.high, 'high', OHM_MIN, OHM_MAX) : null;
            const sens = has(p.sensibility) ? num(p.sensibility, 'sensibility', SENS_MIN, SENS_MAX) : null;
            const en = has(p.enable) ? toBool(p.enable) : null;
            if (low !== null && high !== null && !(low < high)) throw new Error(`low (${low}) must be below high (${high})`);
            const ops = [];
            // thresholds/frequency first, enable last so monitoring starts with the new limits
            if (freq !== null) ops.push(...fwrite(A.LM_FREQ, freq));
            if (low !== null) ops.push(...fwrite(A.LM_LOW, low));
            if (high !== null) ops.push(...fwrite(A.LM_HIGH, high));
            if (sens !== null) ops.push(...fwrite(A.LM_SENS, sens));
            if (en !== null) ops.push(...ch.map(i => ({ op: 'W', addr: A.LM_ENABLE + i, data: u8(en ? 1 : 0) })));
            if (!ops.length) throw new Error('loadMonitor needs at least one of enable, frequency, low, high, sensibility');
            return ops;
        }
    }
    return null;
}

// ---------------------------------------------------------------- value catalog (mezzo-values shape)
const lmv = (s) => s.loadMonitor;
const VALUES = [
    { key: 'loadMonitorEnabled', group: 'Lastüberwachung', label: 'Lastüberwachung aktiv', scope: 'ch', src: 'status', type: 'bool',
        write: 'loadMonitorEnable', get: (s, i) => lmv(s).enabled[i], text: ['ein', 'aus'] },
    { key: 'loadMonitorFrequency', group: 'Lastüberwachung', label: 'Messfrequenz', scope: 'ch', src: 'status', type: 'num',
        unit: 'Hz', dec: 0, write: 'loadMonitorFrequency', get: (s, i) => lmv(s).frequency[i] },
    { key: 'loadMonitorLow', group: 'Lastüberwachung', label: 'Impedanz Untergrenze', scope: 'ch', src: 'status', type: 'num',
        unit: 'Ω', dec: 1, write: 'loadMonitorLow', get: (s, i) => lmv(s).low[i] },
    { key: 'loadMonitorHigh', group: 'Lastüberwachung', label: 'Impedanz Obergrenze', scope: 'ch', src: 'status', type: 'num',
        unit: 'Ω', dec: 1, write: 'loadMonitorHigh', get: (s, i) => lmv(s).high[i] },
    { key: 'loadSensibility', group: 'Lastüberwachung', label: 'Empfindlichkeit (min. Vrms, flüchtig)', scope: 'ch', src: 'status', type: 'num',
        unit: 'V', dec: 2, write: 'loadSensibility', get: (s, i) => lmv(s).sensibility[i] },
    { key: 'loadImpedance', group: 'Lastüberwachung', label: 'Gemessene Impedanz', scope: 'ch', src: 'status', type: 'num',
        unit: 'Ω', dec: 1, get: (s, i) => lmv(s).impedance[i] },
    { key: 'loadImpedanceValid', group: 'Lastüberwachung', label: 'Impedanzmessung gültig', scope: 'ch', src: 'status', type: 'bool',
        get: (s, i) => lmv(s).impedanceValid[i], text: ['gültig', 'ungültig'] },
    { key: 'loadInRange', group: 'Lastüberwachung', label: 'Impedanz im Bereich (Gerät)', scope: 'ch', src: 'status', type: 'bool',
        get: (s, i) => lmv(s).inRange[i], text: ['✓ OK', '⚠ außerhalb'] },
    { key: 'loadOutOfRange', group: 'Lastüberwachung', label: 'Last ausserhalb Bereich', scope: 'ch', src: 'status', type: 'bool',
        get: (s, i) => lmv(s).outOfRange[i], text: ['⚠ LAST FEHLER', '✓ OK'] },
];

module.exports = { A, READS, decode, encode, COMMANDS, VALUES, SENS_MIN, SENS_MAX, SENS_DEFAULT };
