'use strict';
/**
 * GPI / GPO (relay) support for Powersoft Mezzo.
 * Source: "Mezzo Communication Protocol Specifications" issue 1.4.0.
 * Implemented from the spec only – NOT yet verified on a device (Mezzo 324 A, FW 1.6.1.24).
 *
 * Areas used:
 *   0x9000 + n   u8   R/W  GPI n Mode            0 = Gain (GPI controls channel gain), 1 = Other
 *   0x9E00       u32  R/W  Relay mode            0 = Automatic (opens on fault masks), 1 = Manual
 *   0x9E08       u32  R/W  Relay set state       (Manual only) 0 = open, 1 = closed
 *   (Pilot tone GPO enable 0x22A4 belongs to mezzo-pilot.js: command pilotSourceGpo)
 *   0xB5F8 + 4n  f32  R    SlowMeter GPI scaled value CH n
 * The actual relay state (0xB657, u8, 1 = closed) is already part of the SM_ALARMS block read by
 * mezzo-map.js and decoded there as status.gpoRelayClosed – it is not read again here.
 */
const { channels, toBool } = require('./mezzo-map');

const A = {
    GPI_MODE: 0x9000,        // 4 x u8
    RELAY_MODE: 0x9e00,      // u32
    RELAY_STATE: 0x9e08,     // u32 (0x9E04..0x9E07 is not documented -> not read)
    SM_GPI_SCALED: 0xb5f8,   // 4 x f32
};

const GPI_MODES = { 0: 'gain', 1: 'other' };
const RELAY_MODES = { 0: 'automatic', 1: 'manual' };

// Status poll entries [name, addr, size] – 4 + 4 + 4 + 16 + 16 = 44 bytes payload.
const READS = [
    ['gpimode', A.GPI_MODE, 4],
    ['relaymode', A.RELAY_MODE, 4],
    ['relaystate', A.RELAY_STATE, 4],
    ['gpiscaled', A.SM_GPI_SCALED, 16],
];

const r3 = (v) => (v == null || !isFinite(v)) ? null : Math.round(v * 1000) / 1000;
const name = (table, code) => (table[code] !== undefined ? table[code] : `code ${code}`);

/** blocks: {gpimode, relaymode, relaystate, gpiscaled} (Buffer or null) -> status.gpio */
function decode(d) {
    const g = {};
    if (d.gpimode) {
        g.gpiMode = [0, 1, 2, 3].map(i => d.gpimode[i]);
        g.gpiModeName = g.gpiMode.map(c => name(GPI_MODES, c));
    }
    if (d.gpiscaled) g.gpiValue = [0, 1, 2, 3].map(i => r3(d.gpiscaled.readFloatLE(4 * i)));
    if (d.relaymode) {
        g.relayMode = d.relaymode.readUInt32LE(0);
        g.relayModeName = name(RELAY_MODES, g.relayMode);
    }
    if (d.relaystate) g.relayManualClosed = d.relaystate.readUInt32LE(0) === 1;
    return g;
}

const u8 = (v) => Buffer.from([v & 0xff]);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

/** Accepts code (0/1, "0"/"1") or name (case-insensitive) of an enum table. */
function enumCode(table, v, what) {
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        const hit = Object.keys(table).find(k => table[k] === s);
        if (hit !== undefined) return Number(hit);
        if (s !== '' && isFinite(Number(s))) v = Number(s);
    }
    if (typeof v === 'number' && table[v] !== undefined) return v;
    throw new Error(`${what} must be one of ${Object.keys(table).map(k => `${k}/${table[k]}`).join(', ')} (got ${v})`);
}

/**
 * Translate a GPIO command into PBus write operations; returns null if the command is not a GPIO one.
 *   gpiMode      {channel 1-4|'all', value: 'gain'|'other'|0|1}
 *   relayMode    {value: 'automatic'|'manual'|0|1}            (alias gpoMode)
 *   relay        {value: true = close, false = open}            (alias gpo; only effective in Manual mode)
 */
function encode(cmd) {
    const v = cmd.value;
    switch (String(cmd.command || '').trim().toLowerCase()) {
        case 'gpimode': {
            const code = enumCode(GPI_MODES, v, 'gpiMode');
            return channels(cmd.channel).map(i => ({ op: 'W', addr: A.GPI_MODE + i, data: u8(code) }));
        }
        case 'relaymode': case 'gpomode':
            return [{ op: 'W', addr: A.RELAY_MODE, data: u32(enumCode(RELAY_MODES, v, 'relayMode')) }];
        case 'relay': case 'gpo': {
            let on;
            if (typeof v === 'string' && /^(closed?|zu)$/i.test(v.trim())) on = true;
            else if (typeof v === 'string' && /^(open|offen|auf)$/i.test(v.trim())) on = false;
            else if (v === undefined || v === null) throw new Error('relay needs value true (close) / false (open)');
            else on = toBool(v);
            return [{ op: 'W', addr: A.RELAY_STATE, data: u32(on ? 1 : 0) }];
        }
        default:
            return null;
    }
}

const COMMANDS = ['gpiMode', 'relayMode', 'relay'];

// Catalog entries for mezzo-values.js (same shape as there).
const VALUES = [
    { key: 'gpiMode', group: 'GPI/GPO', label: 'GPI-Modus (gain/other)', scope: 'ch', src: 'status', type: 'text', write: 'gpiMode',
        get: (s, i) => s.gpio.gpiModeName[i] },
    { key: 'gpiValue', group: 'GPI/GPO', label: 'GPI-Wert (skaliert)', scope: 'ch', src: 'status', type: 'num', dec: 3,
        get: (s, i) => s.gpio.gpiValue[i] },
    { key: 'relayMode', group: 'GPI/GPO', label: 'Relais-Modus (automatic/manual)', scope: 'dev', src: 'status', type: 'text', write: 'relayMode',
        get: (s) => s.gpio.relayModeName },
    { key: 'relayManual', group: 'GPI/GPO', label: 'Relais manuell schließen', scope: 'dev', src: 'status', type: 'bool', write: 'relay',
        get: (s) => s.gpio.relayManualClosed, text: ['geschlossen', 'offen'] },
    { key: 'relayClosed', group: 'GPI/GPO', label: 'Relais-Zustand (Ist)', scope: 'dev', src: 'status', type: 'bool',
        get: (s) => s.gpoRelayClosed, text: ['geschlossen', 'offen'] },
];

module.exports = { A, GPI_MODES, RELAY_MODES, READS, decode, encode, COMMANDS, VALUES };
