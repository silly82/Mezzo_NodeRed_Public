'use strict';
/**
 * Mezzo source selection / backup strategy (PBus area 0x2000–0x2554).
 *
 * Implemented from "Mezzo Communication Protocol Specifications" issue 1.4.0.
 * NOT yet verified on a device (tested hardware so far: Mezzo 324 A, FW 1.6.1.24).
 *
 * Per channel the Mezzo has 4 source slots ("Source 1..4"). Each slot holds an absolute
 * source id (int8, -1 = none, 0..31). The priority list maps priority 1..4 to a slot,
 * the default priority index selects the priority used when no backup switching happens.
 * User facing numbers (channel, slot, priority) are 1-based; on the wire they are 0-based.
 *
 * Out of scope here: "Old Sources" 0x2100–0x21A8 (deprecated since 1.1.0/1.1.1),
 * pilot tone 0x2270–0x22B4, Minijack anti-pop 0x2500–0x2554, SlowMeter SourceSelection
 * 0xB310–0xB360 (pilot tone detection only; 0xB300–0xB30F is not documented).
 */
const { toBool, channels, lin2db, db2lin } = require('./mezzo-map');

const A = {
    INPUT_REF: 0x2000,       // 4 x f32: analog ref (lin), analog delay (s), digital ref (lin), digital delay (s)
    SOURCE_ID: 0x2200,       // int8 [ch][slot], -1..31
    PRIORITY: 0x2210,        // uint8 [ch][priority] -> slot index 0..3
    DEFAULT_PRIORITY: 0x2220, // uint8 [ch], 0..3
    // 0x2224..0x2227: not documented in spec 1.4.0
    BACKUP_ENABLE: 0x2228,   // uint8 [ch], 0/1
    BACKUP_MODE: 0x222c,     // uint8 [ch], 0 = regular, 1 = with backup threshold
    THRESHOLD: 0x2230,       // f32 [ch][slot], "Threshold for signal" (unit not documented, assumed linear)
    END: 0x2270,             // pilot tone fields start here (other module)
};

// Status poll additions. Each entry stays within one PBus area (0x2000 and 0x2200 are separate areas).
const READS = [
    ['srcRef', A.INPUT_REF, 0x10],
    ['srcSel', A.SOURCE_ID, A.END - A.SOURCE_ID], // 0x70 = 112 bytes
];

const BACKUP_MODES = ['regulär (regular)', 'mit Schwelle (threshold)'];
const MAX_SOURCE_ID = 31;

const r = (v, n) => (v == null || !isFinite(v)) ? null : Math.round(v * 10 ** n) / 10 ** n;
const CH = [0, 1, 2, 3];

function sourceIdText(id) {
    if (id === -1) return 'keine (none)';
    if (id >= 0 && id <= MAX_SOURCE_ID) return `Quelle ${id} (source ${id})`;
    return `ungültig (${id})`;
}

/** blocks: { srcRef: Buffer|null, srcSel: Buffer|null } -> status.sources */
function decode(blocks) {
    const out = {};
    const ref = blocks && blocks.srcRef;
    if (ref && ref.length >= 16) {
        const analogRef = ref.readFloatLE(0), digitalRef = ref.readFloatLE(8);
        out.inputRef = {
            analogRef: r(analogRef, 6), analogRefDb: lin2db(analogRef), analogDelay: r(ref.readFloatLE(4), 6),
            digitalRef: r(digitalRef, 6), digitalRefDb: lin2db(digitalRef), digitalDelay: r(ref.readFloatLE(12), 6),
        };
    }
    const b = blocks && blocks.srcSel;
    if (b && b.length >= A.END - A.SOURCE_ID) {
        const o = (addr) => addr - A.SOURCE_ID;
        out.sourceId = CH.map(c => CH.map(s => b.readInt8(o(A.SOURCE_ID) + 4 * c + s)));
        out.sourceIdText = out.sourceId.map(row => row.map(sourceIdText));
        out.priorityRaw = CH.map(c => CH.map(p => b[o(A.PRIORITY) + 4 * c + p]));
        // priority[ch][p] = slot number 1..4 (null if out of range)
        out.priority = out.priorityRaw.map(row => row.map(v => (v <= 3 ? v + 1 : null)));
        out.defaultPriorityRaw = CH.map(c => b[o(A.DEFAULT_PRIORITY) + c]);
        out.defaultPriority = out.defaultPriorityRaw.map(v => (v <= 3 ? v + 1 : null));
        out.backupEnable = CH.map(c => b[o(A.BACKUP_ENABLE) + c] !== 0);
        out.backupThresholdMode = CH.map(c => b[o(A.BACKUP_MODE) + c]);
        out.backupThresholdModeText = out.backupThresholdMode.map(v => BACKUP_MODES[v] || `unbekannt (${v})`);
        out.threshold = CH.map(c => CH.map(s => r(b.readFloatLE(o(A.THRESHOLD) + 16 * c + 4 * s), 6)));
        out.thresholdDb = out.threshold.map(row => row.map(lin2db));
        // Derived (not a device reading): slot/source configured by the default priority.
        out.defaultSlot = CH.map(c => {
            const p = out.defaultPriority[c];
            return p === null ? null : out.priority[c][p - 1];
        });
        out.defaultSourceId = CH.map(c => (out.defaultSlot[c] === null ? null : out.sourceId[c][out.defaultSlot[c] - 1]));
        out.defaultSourceText = out.defaultSourceId.map(v => (v === null ? '–' : sourceIdText(v)));
    }
    return out;
}

// ---------------------------------------------------------------- commands
const i8 = (v) => { const x = Buffer.alloc(1); x.writeInt8(v, 0); return x; };
const u8 = (v) => Buffer.from([v & 0xff]);
const fl = (v) => { const x = Buffer.alloc(4); x.writeFloatLE(v, 0); return x; };

function int(v, lo, hi, name) {
    const n = Number(typeof v === 'string' ? v.trim() : v);
    if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !Number.isInteger(n) || n < lo || n > hi) {
        throw new Error(`${name} must be an integer ${lo}..${hi} (got ${v})`);
    }
    return n;
}
const slotIndex = (v, name = 'slot') => int(v, 1, 4, name) - 1;

function backupMode(v) {
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['regular', 'regulär', 'regulaer', 'normal'].includes(s)) return 0;
        if (['threshold', 'schwelle'].includes(s)) return 1;
    }
    return int(v, 0, 1, 'backup threshold mode');
}

const THRESHOLD_MIN_DB = -120, THRESHOLD_MAX_DB = 0;
function thresholdLin(v) {
    if (v === null || v === 'off' || v === '-inf' || v === -Infinity) return 0;
    const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    if (v === '' || typeof v === 'boolean' || !isFinite(n)) throw new Error(`invalid threshold "${v}"`);
    if (n < THRESHOLD_MIN_DB || n > THRESHOLD_MAX_DB) {
        throw new Error(`threshold must be ${THRESHOLD_MIN_DB}..${THRESHOLD_MAX_DB} dB (got ${n})`);
    }
    return db2lin(n);
}

const COMMANDS = ['sourceId', 'sourcePriority', 'sourceDefaultPriority', 'backupEnable', 'backupThresholdMode', 'backupThreshold'];

/**
 * cmd: { command, value, channel (1..4 | 'all' | array), slot (1..4), priority (1..4) }
 * Returns write ops, or null if the command does not belong to this module.
 */
function encode(cmd) {
    const c = String((cmd && cmd.command) || '').trim().toLowerCase();
    const v = cmd && cmd.value;
    switch (c) {
        case 'sourceid': { // value: absolute source id -1..31 for one slot
            const s = slotIndex(cmd.slot !== undefined ? cmd.slot : cmd.source);
            const id = int(v, -1, MAX_SOURCE_ID, 'source id');
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.SOURCE_ID + 4 * i + s, data: i8(id) }));
        }
        case 'sourcepriority': {
            // value: [slot for prio 1, prio 2, prio 3, prio 4] (1-based) -> 4 bytes,
            // or cmd.priority (1..4) + value = slot (1..4) -> 1 byte
            if (Array.isArray(v)) {
                if (v.length !== 4) throw new Error('sourcePriority needs 4 slot numbers (priority 1..4)');
                const data = Buffer.from(v.map((x, p) => slotIndex(x, `slot for priority ${p + 1}`)));
                return channels(cmd.channel).map(i => ({ op: 'W', addr: A.PRIORITY + 4 * i, data }));
            }
            const p = int(cmd.priority, 1, 4, 'priority') - 1;
            const s = slotIndex(v);
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.PRIORITY + 4 * i + p, data: u8(s) }));
        }
        case 'sourcedefaultpriority': {
            const p = int(v, 1, 4, 'default priority') - 1;
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.DEFAULT_PRIORITY + i, data: u8(p) }));
        }
        case 'backupenable':
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.BACKUP_ENABLE + i, data: u8(toBool(v) ? 1 : 0) }));
        case 'backupthresholdmode': {
            const m = backupMode(v);
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.BACKUP_MODE + i, data: u8(m) }));
        }
        case 'backupthreshold': { // value in dB (-120..0), null/'off' = 0 linear
            const s = slotIndex(cmd.slot !== undefined ? cmd.slot : cmd.source);
            const data = fl(thresholdLin(v));
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.THRESHOLD + 16 * i + 4 * s, data }));
        }
        default:
            return null;
    }
}

// ---------------------------------------------------------------- value catalog (mezzo-values format)
const ss = (s) => s.sources;
const VALUES = [
    { key: 'backupEnable', group: 'Quellenwahl', label: 'Backup-Strategie aktiv', scope: 'ch', src: 'status', type: 'bool',
        write: 'backupEnable', get: (s, i) => ss(s).backupEnable[i], text: ['Backup ein', 'Backup aus'] },
    { key: 'backupThresholdMode', group: 'Quellenwahl', label: 'Backup-Modus (0 regulär, 1 Schwelle)', scope: 'ch', src: 'status',
        type: 'num', dec: 0, write: 'backupThresholdMode', get: (s, i) => ss(s).backupThresholdMode[i] },
    { key: 'backupThresholdModeText', group: 'Quellenwahl', label: 'Backup-Modus (Text)', scope: 'ch', src: 'status', type: 'text',
        get: (s, i) => ss(s).backupThresholdModeText[i] },
    { key: 'sourceDefaultPriority', group: 'Quellenwahl', label: 'Standard-Priorität (1–4)', scope: 'ch', src: 'status', type: 'num',
        dec: 0, write: 'sourceDefaultPriority', get: (s, i) => ss(s).defaultPriority[i] },
    { key: 'sourceDefaultSlot', group: 'Quellenwahl', label: 'Quelle der Standard-Priorität (Slot 1–4)', scope: 'ch', src: 'status',
        type: 'num', dec: 0, get: (s, i) => ss(s).defaultSlot[i] },
    { key: 'sourceDefaultId', group: 'Quellenwahl', label: 'Quellen-ID der Standard-Priorität', scope: 'ch', src: 'status', type: 'num',
        dec: 0, get: (s, i) => ss(s).defaultSourceId[i] },
    { key: 'sourceIds', group: 'Quellenwahl', label: 'Quellen-IDs Slot 1–4 (Text)', scope: 'ch', src: 'status', type: 'text',
        get: (s, i) => ss(s).sourceId[i].map((id, k) => `${k + 1}: ${id}`).join(', ') },
    { key: 'sourcePriorityOrder', group: 'Quellenwahl', label: 'Prioritätsreihenfolge (Slots)', scope: 'ch', src: 'status', type: 'text',
        get: (s, i) => ss(s).priority[i].map(x => (x === null ? '?' : x)).join(' → ') },
    { key: 'backupThresholds', group: 'Quellenwahl', label: 'Backup-Schwellen Slot 1–4 (Text)', scope: 'ch', src: 'status', type: 'text',
        get: (s, i) => ss(s).thresholdDb[i].map((d, k) => `${k + 1}: ${d === null ? '-∞' : d.toFixed(1)} dB`).join(', ') },
    { key: 'analogRefDb', group: 'Quellenwahl', label: 'Analog-Referenz', scope: 'dev', src: 'status', type: 'db',
        get: (s) => ss(s).inputRef.analogRefDb },
    { key: 'digitalRefDb', group: 'Quellenwahl', label: 'Digital-Referenz', scope: 'dev', src: 'status', type: 'db',
        get: (s) => ss(s).inputRef.digitalRefDb },
    { key: 'analogDelay', group: 'Quellenwahl', label: 'Analog-Delay', scope: 'dev', src: 'status', type: 'num', unit: 'ms', dec: 3,
        get: (s) => ss(s).inputRef.analogDelay * 1000 },
    { key: 'digitalDelay', group: 'Quellenwahl', label: 'Digital-Delay', scope: 'dev', src: 'status', type: 'num', unit: 'ms', dec: 3,
        get: (s) => ss(s).inputRef.digitalDelay * 1000 },
];

module.exports = { A, READS, BACKUP_MODES, COMMANDS, VALUES, decode, encode, sourceIdText };
