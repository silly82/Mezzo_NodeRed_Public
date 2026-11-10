'use strict';
/**
 * Nota-only PBusX features from the official Nota spec 1.0.6 (FW 1.2.0.0):
 * source selection / backup, input pilot tone, pilot tone generator + load monitor per way,
 * pilot tone / impedance detection, zone block, microphone activation; user EQ, dynamic EQ and AES67 routing
 * are in pbusx-eq.js (bundled here).
 * Not in the DC Rider spec 1.0.3 – used only when FAMILIES[x].ext is true.
 *
 * Input block q (0x010000 + q*0x8000):
 *   +0x000  int8[4]  source id per slot (-1..31)        +0x004 u8[4] slot index (0..3) for priority 1..4
 *   +0x008  u8       default priority index (0..3)       +0x00A u8 backup strategy enable   +0x00B u8 threshold mode (0/1)
 *   +0x00C  f32[4]   backup threshold per slot ("threshold for signal", linear assumed)
 *   +0x100  u32 pilot enable, f32 freq (Hz), f32 high (Vrms), f32 low (Vrms), u32 GPO enable
 *   +0x4180 f32[4]   detected pilot Vrms per source       +0x4190 u8[4] pilot valid per source
 * Output block k (0x180000 + k*0x20000):
 *   +0x7400 u8 generator enable, f32 freq, f32 amplitude (9 bytes, own area)
 *   +0x7409 u8 load monitor enable, f32 freq, f32 low, f32 high (13 bytes, own area – reading across both answers NAK)
 *   +0xA000 u32 zone enable, u32 mute, f32 gain, u32 source GUID, u32 zone GUID, f32 subzone gain
 *   +0x10800 f32 detected pilot Vrms, f32 impedance, u32 Vrms in range, u32 impedance in range, u32 Vrms valid, u32 impedance valid
 * 0x400000C u32 microphone activation: 0xB1A3C1A2 = on, 0x0FF0FF00 = off
 */
const { lin2db, db2lin, toBool } = require('./mezzo-map');
const eq = require('./pbusx-eq');

const IN = (q) => 0x010000 + q * 0x8000;
const CH = (k) => 0x180000 + k * 0x20000;
const OFF = { SRC: 0x0, PILOT: 0x100, PILOT_METER: 0x4180, DIAG: 0x7400, LM: 0x7409, ZONE: 0xa000, WAY_PILOT: 0x10800 };
const MIC = 0x400000c, MIC_ON = 0xb1a3c1a2, MIC_OFF = 0x0ff0ff00;
const LIMITS = { freq: [10, 22000], amplitude: [0, 10], vrms: [0, 100], ohm: [0, 1000], thresholdDb: [-120, 0], gainDb: [-80, 15] };

const range = (n) => Array.from({ length: n }, (_, i) => i);
const r2 = (v, n = 2) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** n) / 10 ** n;
const u8 = (v) => Buffer.from([v & 0xff]);
const i8 = (v) => { const b = Buffer.alloc(1); b.writeInt8(v, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const fl = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };

/** Read definitions [name, addr, size] for a layout {inputs, outputs}. */
function reads(l) {
    const r = [];
    for (const q of range(l.inputs)) {
        r.push([`xsrc${q}`, IN(q) + OFF.SRC, 28], [`xpil${q}`, IN(q) + OFF.PILOT, 20], [`xpilm${q}`, IN(q) + OFF.PILOT_METER, 20]);
    }
    for (const k of range(l.outputs)) {
        r.push([`xgen${k}`, CH(k) + OFF.DIAG, 9], [`xlm${k}`, CH(k) + OFF.LM, 13], [`xwpil${k}`, CH(k) + OFF.WAY_PILOT, 24],
            [`xzone${k}`, CH(k) + OFF.ZONE, 24]);
    }
    r.push(...eq.reads(l));
    return r;
}

/** Decode into {sources, pilotTone, loadMonitor, zone}; sections missing on the device stay null. */
function decode(d, l) {
    const ins = range(l.inputs), ch = range(l.outputs);
    const all = (prefix, n) => range(n).every((i) => !d[`${prefix}${i}`]);
    const out = {};

    if (!all('xsrc', l.inputs)) {
        const S = (q) => d[`xsrc${q}`];
        const map = (fn) => ins.map((q) => (S(q) ? fn(S(q)) : null));
        out.sources = {
            sourceId: map((b) => range(4).map((i) => b.readInt8(i))),
            priority: map((b) => range(4).map((i) => (b[4 + i] <= 3 ? b[4 + i] + 1 : null))), // slot 1..4 per priority 1..4
            defaultPriority: map((b) => (b[8] <= 3 ? b[8] + 1 : null)),
            backupEnable: map((b) => b[0xa] !== 0),
            backupThresholdMode: map((b) => b[0xb]),
            backupThresholdModeText: map((b) => (b[0xb] === 0 ? 'regulär' : b[0xb] === 1 ? 'mit Schwelle' : `code ${b[0xb]}`)),
            threshold: map((b) => range(4).map((i) => r2(b.readFloatLE(0xc + 4 * i), 6))),
            thresholdDb: map((b) => range(4).map((i) => lin2db(b.readFloatLE(0xc + 4 * i)))),
        };
    }

    const pilot = {};
    if (!all('xpil', l.inputs)) {
        const P = (q) => d[`xpil${q}`], M = (q) => d[`xpilm${q}`];
        const map = (fn, src = P) => ins.map((q) => (src(q) ? fn(src(q)) : null));
        pilot.source = {
            enable: map((b) => b.readUInt32LE(0) !== 0),
            frequency: map((b) => r2(b.readFloatLE(4), 1)),
            highThreshold: map((b) => r2(b.readFloatLE(8), 4)),
            lowThreshold: map((b) => r2(b.readFloatLE(12), 4)),
            gpoEnable: map((b) => b.readUInt32LE(16) !== 0),
            rms: map((b) => range(4).map((i) => r2(b.readFloatLE(4 * i), 4)), M),
            valid: map((b) => range(4).map((i) => b[16 + i] !== 0), M),
        };
        pilot.source.detected = ins.map((q) => (pilot.source.valid[q] ? pilot.source.valid[q].some(Boolean) : null));
        pilot.source.missing = ins.map((q) => (pilot.source.enable[q] === true && pilot.source.detected[q] === false));
    }
    const G = (k) => d[`xgen${k}`], LM = (k) => d[`xlm${k}`], W = (k) => d[`xwpil${k}`];
    if (!all('xgen', l.outputs) || !all('xlm', l.outputs) || !all('xwpil', l.outputs)) {
        const mapG = (fn) => ch.map((k) => (G(k) ? fn(G(k)) : null));
        const mapL = (fn) => ch.map((k) => (LM(k) ? fn(LM(k)) : null));
        const mapW = (fn) => ch.map((k) => (W(k) ? fn(W(k)) : null));
        pilot.generator = { enable: mapG((b) => b[0] !== 0), frequency: mapG((b) => r2(b.readFloatLE(1), 1)), amplitude: mapG((b) => r2(b.readFloatLE(5), 4)) };
        pilot.detect = {
            rms: mapW((b) => r2(b.readFloatLE(0), 4)),
            inRange: mapW((b) => b.readUInt32LE(8) !== 0),
            valid: mapW((b) => b.readUInt32LE(16) !== 0),
        };
        const lm = {
            enabled: mapL((b) => b[0] !== 0),
            frequency: mapL((b) => r2(b.readFloatLE(1), 1)),
            low: mapL((b) => r2(b.readFloatLE(5), 2)),
            high: mapL((b) => r2(b.readFloatLE(9), 2)),
            impedance: mapW((b) => r2(b.readFloatLE(4), 2)),
            inRange: mapW((b) => b.readUInt32LE(12) !== 0),
            impedanceValid: mapW((b) => b.readUInt32LE(20) !== 0),
        };
        lm.outOfRange = ch.map((k) => lm.enabled[k] === true && lm.impedanceValid[k] !== false && lm.impedance[k] !== null
            && lm.low[k] !== null && lm.high[k] !== null && (lm.impedance[k] < lm.low[k] || lm.impedance[k] > lm.high[k]));
        lm.any = lm.outOfRange.some(Boolean);
        out.loadMonitor = lm;
    }
    if (Object.keys(pilot).length) {
        pilot.alarm = !!(pilot.source && pilot.source.missing.some(Boolean));
        out.pilotTone = pilot;
    }

    if (!all('xzone', l.outputs)) {
        const Z = (k) => d[`xzone${k}`];
        const map = (fn) => ch.map((k) => (Z(k) ? fn(Z(k)) : null));
        out.zone = {
            enable: map((b) => b.readUInt32LE(0) !== 0),
            mute: map((b) => b.readUInt32LE(4) !== 0),
            gainDb: map((b) => lin2db(b.readFloatLE(8))),
            sourceGuid: map((b) => b.readUInt32LE(12)),
            zoneGuid: map((b) => b.readUInt32LE(16)),
            subzoneGainDb: map((b) => lin2db(b.readFloatLE(20))),
        };
    }
    Object.assign(out, eq.decode(d, l));
    return out;
}

// ---------------------------------------------------------------- commands
function idx(v, n, name) {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1 || x > n) throw new Error(`${name} must be 1..${n} (got ${v})`);
    return x - 1;
}
const list = (v, n, name) => (v === undefined || v === null || v === '' || v === 'all' || v === 0 || v === '0'
    ? range(n) : Array.isArray(v) ? v.map((x) => idx(x, n, name)) : [idx(v, n, name)]);
function num(v, [lo, hi], what) {
    const x = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !isFinite(x)) throw new Error(`${what}: invalid value "${v}"`);
    if (x < lo || x > hi) throw new Error(`${what} ${x} out of range ${lo}..${hi} – refused`);
    return x;
}
/** Parameters from cmd itself or from a cmd.value object; a plain value means `enable`. */
const params = (cmd) => (cmd.value && typeof cmd.value === 'object' && !Array.isArray(cmd.value) ? { ...cmd, ...cmd.value } : cmd);
const has = (o, k) => o[k] !== undefined && o[k] !== null && o[k] !== '';

/** Input index list for input-scoped commands: source, else channel (= input number). */
const inputs = (cmd, l) => list(has(cmd, 'source') ? cmd.source : cmd.channel, l.inputs, 'input');
const outputs = (cmd, l) => list(cmd.channel, l.outputs, 'channel');

function encode(cmd, l) {
    const c = String(cmd.command || '').trim().toLowerCase();
    const p = params(cmd), v = cmd.value;
    const each = (ks, fn) => ks.flatMap(fn);
    switch (c) {
        // ---- source selection / backup (per input)
        case 'backupenable': return each(inputs(cmd, l), (q) => [{ op: 'W', addr: IN(q) + 0xa, data: u8(toBool(v) ? 1 : 0) }]);
        case 'backupthresholdmode': {
            const m = /^(1|threshold|schwelle)$/i.test(String(v)) ? 1 : /^(0|regular|regulär|regulaer)$/i.test(String(v)) ? 0 : null;
            if (m === null) throw new Error('backupThresholdMode must be 0/regular or 1/threshold');
            return each(inputs(cmd, l), (q) => [{ op: 'W', addr: IN(q) + 0xb, data: u8(m) }]);
        }
        case 'sourcedefaultpriority': {
            const pr = idx(v, 4, 'default priority');
            return each(inputs(cmd, l), (q) => [{ op: 'W', addr: IN(q) + 0x8, data: u8(pr) }]);
        }
        case 'sourceid': {
            const slot = idx(p.slot, 4, 'slot'), id = num(p.id !== undefined ? p.id : v, [-1, 31], 'source id');
            if (!Number.isInteger(id)) throw new Error('source id must be an integer -1..31');
            return each(inputs(cmd, l), (q) => [{ op: 'W', addr: IN(q) + slot, data: i8(id) }]);
        }
        case 'sourcepriority': {
            if (Array.isArray(v)) {
                if (v.length !== 4) throw new Error('sourcePriority needs 4 slot numbers (priority 1..4)');
                const b = Buffer.from(v.map((s) => idx(s, 4, 'slot')));
                return each(inputs(cmd, l), (q) => [{ op: 'W', addr: IN(q) + 4, data: b }]);
            }
            const pr = idx(p.priority, 4, 'priority'), slot = idx(p.slot !== undefined ? p.slot : v, 4, 'slot');
            return each(inputs(cmd, l), (q) => [{ op: 'W', addr: IN(q) + 4 + pr, data: u8(slot) }]);
        }
        case 'backupthreshold': {
            const slot = idx(p.slot, 4, 'slot');
            const lin = v === 'off' ? 0 : db2lin(num(p.db !== undefined ? p.db : v, LIMITS.thresholdDb, 'backup threshold dB'));
            return each(inputs(cmd, l), (q) => [{ op: 'W', addr: IN(q) + 0xc + 4 * slot, data: fl(lin) }]);
        }
        // ---- input pilot tone (per input)
        case 'pilotsource': case 'pilotsourceenable': case 'pilotsourcefrequency': case 'pilotsourcelow':
        case 'pilotsourcehigh': case 'pilotsourcegpo': {
            const single = { pilotsourceenable: 'enable', pilotsourcefrequency: 'frequency', pilotsourcelow: 'low', pilotsourcehigh: 'high', pilotsourcegpo: 'gpo' }[c];
            const q2 = single ? { [single]: v } : p;
            const w = [];
            if (has(q2, 'frequency')) w.push([4, fl(num(q2.frequency, LIMITS.freq, 'pilot frequency'))]);
            if (has(q2, 'high')) w.push([8, fl(num(q2.high, LIMITS.vrms, 'pilot high threshold'))]);
            if (has(q2, 'low')) w.push([12, fl(num(q2.low, LIMITS.vrms, 'pilot low threshold'))]);
            if (has(q2, 'low') && has(q2, 'high') && Number(q2.low) >= Number(q2.high)) throw new Error('pilot low threshold must be below high');
            if (has(q2, 'gpo')) w.push([16, u32(toBool(q2.gpo) ? 1 : 0)]);
            if (has(q2, 'enable') || (!single && !w.length && v !== undefined && typeof v !== 'object')) w.push([0, u32(toBool(has(q2, 'enable') ? q2.enable : v) ? 1 : 0)]);
            if (!w.length) throw new Error(`${cmd.command}: nothing to write`);
            return each(inputs(cmd, l), (q) => w.map(([o, data]) => ({ op: 'W', addr: IN(q) + OFF.PILOT + o, data })));
        }
        // ---- pilot tone generator / load monitor (per way, unaligned fields)
        case 'pilotgenerator': case 'pilotgeneratorenable': case 'pilotgeneratorfrequency': case 'pilotgeneratoramplitude': {
            const single = { pilotgeneratorenable: 'enable', pilotgeneratorfrequency: 'frequency', pilotgeneratoramplitude: 'amplitude' }[c];
            const q2 = single ? { [single]: v } : p;
            const w = [];
            if (has(q2, 'frequency')) w.push([1, fl(num(q2.frequency, LIMITS.freq, 'generator frequency'))]);
            if (has(q2, 'amplitude')) w.push([5, fl(num(q2.amplitude, LIMITS.amplitude, 'pilot tone amplitude'))]);
            const en = has(q2, 'enable') ? toBool(q2.enable) : (!single && typeof v !== 'object' && v !== undefined ? toBool(v) : null);
            // switching on: parameters first, enable last; switching off: enable first
            if (en === true) w.push([0, u8(1)]); else if (en === false) w.unshift([0, u8(0)]);
            if (!w.length) throw new Error(`${cmd.command}: nothing to write`);
            return each(outputs(cmd, l), (k) => w.map(([o, data]) => ({ op: 'W', addr: CH(k) + OFF.DIAG + o, data })));
        }
        case 'loadmonitor': case 'loadmonitorenable': case 'loadmonitorfrequency': case 'loadmonitorlow': case 'loadmonitorhigh': {
            const single = { loadmonitorenable: 'enable', loadmonitorfrequency: 'frequency', loadmonitorlow: 'low', loadmonitorhigh: 'high' }[c];
            const q2 = single ? { [single]: v } : p;
            const w = [];
            if (has(q2, 'frequency')) w.push([0xa, fl(num(q2.frequency, LIMITS.freq, 'load monitor frequency'))]);
            if (has(q2, 'low')) w.push([0xe, fl(num(q2.low, LIMITS.ohm, 'load monitor low'))]);
            if (has(q2, 'high')) w.push([0x12, fl(num(q2.high, LIMITS.ohm, 'load monitor high'))]);
            if (has(q2, 'low') && has(q2, 'high') && Number(q2.low) >= Number(q2.high)) throw new Error('load monitor low must be below high');
            const en = has(q2, 'enable') ? toBool(q2.enable) : (!single && typeof v !== 'object' && v !== undefined ? toBool(v) : null);
            if (en !== null) w.push([9, u8(en ? 1 : 0)]);
            if (!w.length) throw new Error(`${cmd.command}: nothing to write`);
            return each(outputs(cmd, l), (k) => w.map(([o, data]) => ({ op: 'W', addr: CH(k) + OFF.DIAG + o, data })));
        }
        // ---- zone (per output channel)
        case 'zoneenable': return each(outputs(cmd, l), (k) => [{ op: 'W', addr: CH(k) + OFF.ZONE, data: u32(toBool(v) ? 1 : 0) }]);
        case 'zonemute': return each(outputs(cmd, l), (k) => [{ op: 'W', addr: CH(k) + OFF.ZONE + 4, data: u32(toBool(v) ? 1 : 0) }]);
        case 'zonegain': case 'subzonegain': {
            const lin = v === 'off' || v === null ? 0 : db2lin(num(v, LIMITS.gainDb, `${cmd.command} dB`));
            return each(outputs(cmd, l), (k) => [{ op: 'W', addr: CH(k) + OFF.ZONE + (c === 'zonegain' ? 8 : 20), data: fl(lin) }]);
        }
        // ---- microphone
        case 'microphone': return [{ op: 'W', addr: MIC, data: u32(toBool(v) ? MIC_ON : MIC_OFF) }];
        default: return eq.encode(cmd, l);
    }
}

const COMMANDS = ['backupEnable', 'backupThresholdMode', 'backupThreshold', 'sourceDefaultPriority', 'sourceId', 'sourcePriority',
    'pilotSource', 'pilotSourceEnable', 'pilotSourceFrequency', 'pilotSourceLow', 'pilotSourceHigh', 'pilotSourceGpo',
    'pilotGenerator', 'pilotGeneratorEnable', 'pilotGeneratorFrequency', 'pilotGeneratorAmplitude',
    'loadMonitor', 'loadMonitorEnable', 'loadMonitorFrequency', 'loadMonitorLow', 'loadMonitorHigh',
    'zoneEnable', 'zoneMute', 'zoneGain', 'subzoneGain', 'microphone', ...eq.COMMANDS];

module.exports = { reads, decode, encode, COMMANDS, LIMITS, OFF, MIC_ON, MIC_OFF };
