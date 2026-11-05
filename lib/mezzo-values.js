'use strict';
// Catalog of single values for the mezzo-value node: how to read one value from the
// status/meter objects, how to format it as text, and (if writable) which command sets it.
//
// scope: 'dev' (device), 'ch' (channel 1-4), 'mx' (matrix crosspoint source/output)
// src:   'status' | 'meters'
// type:  'db' | 'bool' | 'num' | 'text'
// write: command name for mezzo-control / amp.command, or undefined (read only)

const fix = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d)));

const V = [
    // ----------------------------------------------------------- device
    { key: 'power', group: 'Gerät', label: 'Power (ein = true)', scope: 'dev', src: 'status', type: 'bool', write: 'power',
        get: (s) => !s.standby, text: ['EIN', 'STANDBY'] },
    { key: 'standby', group: 'Gerät', label: 'Standby', scope: 'dev', src: 'status', type: 'bool', write: 'standby',
        get: (s) => s.standby, text: ['STANDBY', 'EIN'] },
    { key: 'alarm', group: 'Gerät', label: 'Alarm aktiv', scope: 'dev', src: 'status', type: 'bool',
        get: (s) => s.alarms.any, text: ['⚠ ALARM', '✓ OK'] },
    { key: 'fault', group: 'Gerät', label: 'Fault (Text)', scope: 'dev', src: 'status', type: 'text',
        get: (s) => s.alarms.fault + (s.alarms.faults.length > 1 ? ' (' + s.alarms.faults.join(', ') + ')' : '') },
    { key: 'nickname', group: 'Gerät', label: 'Nickname', scope: 'dev', src: 'status', type: 'text', write: 'nickname',
        get: (s) => s.nickname },
    { key: 'autoPowerDown', group: 'Gerät', label: 'Auto Power Down', scope: 'dev', src: 'status', type: 'bool', write: 'autoPowerDown',
        get: (s) => s.autoPowerDown, text: ['ein', 'aus'] },
    { key: 'ip', group: 'Gerät', label: 'IP-Adresse', scope: 'dev', src: 'status', type: 'text', get: (s) => s.network.ip },
    { key: 'model', group: 'Gerät', label: 'Modell', scope: 'dev', src: 'status', type: 'text', get: (s) => s.info && s.info.model },
    { key: 'serial', group: 'Gerät', label: 'Seriennummer', scope: 'dev', src: 'status', type: 'text', get: (s) => s.info && s.info.serial },
    { key: 'firmware', group: 'Gerät', label: 'Firmware', scope: 'dev', src: 'status', type: 'text', get: (s) => s.info && s.info.firmware },
    // ----------------------------------------------------------- supply
    { key: 'mainsVrms', group: 'Versorgung', label: 'Netzspannung', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 1,
        get: (s) => s.supply.mainsVrms },
    { key: 'tempHeatsink', group: 'Versorgung', label: 'Temperatur Kühlkörper', scope: 'dev', src: 'status', type: 'num', unit: '°C', dec: 1,
        get: (s) => s.supply.tempHeatsink },
    { key: 'tempTransformer', group: 'Versorgung', label: 'Temperatur Trafo', scope: 'dev', src: 'status', type: 'num', unit: '°C', dec: 1,
        get: (s) => s.supply.tempTransformer },
    { key: 'vccP', group: 'Versorgung', label: 'Rail Vcc +', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 1, get: (s) => s.supply.vccP },
    { key: 'vccN', group: 'Versorgung', label: 'Rail Vcc −', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 1, get: (s) => s.supply.vccN },
    { key: 'vauxP', group: 'Versorgung', label: 'Aux +', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 2, get: (s) => s.supply.vauxP },
    { key: 'vauxN', group: 'Versorgung', label: 'Aux −', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 2, get: (s) => s.supply.vauxN },
    { key: 'fanCurrent', group: 'Versorgung', label: 'Lüfterstrom', scope: 'dev', src: 'status', type: 'num', unit: 'A', dec: 3,
        get: (s) => s.supply.fanCurrent },
    // ----------------------------------------------------------- channel settings
    { key: 'userGain', group: 'Kanal', label: 'User Gain (Lautstärke)', scope: 'ch', src: 'status', type: 'db', write: 'gain',
        get: (s, i) => s.user.gainDb[i] },
    { key: 'userMute', group: 'Kanal', label: 'User Mute', scope: 'ch', src: 'status', type: 'bool', write: 'mute',
        get: (s, i) => s.user.mute[i], text: ['🔇 ein', 'aus'] },
    { key: 'polarity', group: 'Kanal', label: 'Polarität invertiert', scope: 'ch', src: 'status', type: 'bool', write: 'polarity',
        get: (s, i) => s.user.polarityInverted[i], text: ['invertiert', 'normal'] },
    { key: 'userDelay', group: 'Kanal', label: 'User Delay', scope: 'ch', src: 'status', type: 'num', unit: 'ms', dec: 2,
        get: (s, i) => s.user.delay[i] * 1000 },
    { key: 'outputGain', group: 'Kanal', label: 'Output Gain', scope: 'ch', src: 'status', type: 'db', write: 'outputGain',
        get: (s, i) => s.output.gainDb[i] },
    { key: 'outputMute', group: 'Kanal', label: 'Output Mute', scope: 'ch', src: 'status', type: 'bool', write: 'outputMute',
        get: (s, i) => s.output.mute[i], text: ['🔇 ein', 'aus'] },
    { key: 'outputDelay', group: 'Kanal', label: 'Output Delay', scope: 'ch', src: 'status', type: 'num', unit: 'ms', dec: 2,
        get: (s, i) => s.output.delay[i] * 1000 },
    { key: 'wayName', group: 'Kanal', label: 'Way-Name', scope: 'ch', src: 'status', type: 'text', get: (s, i) => s.output.name[i] },
    { key: 'inputGain', group: 'Kanal', label: 'Input Gain (Matrix Pre)', scope: 'ch', src: 'status', type: 'db', write: 'inputGain',
        get: (s, i) => s.input.gainDb[i] },
    { key: 'inputMute', group: 'Kanal', label: 'Input Mute (Matrix Pre)', scope: 'ch', src: 'status', type: 'bool', write: 'inputMute',
        get: (s, i) => s.input.mute[i], text: ['🔇 ein', 'aus'] },
    { key: 'channelTemp', group: 'Kanal', label: 'Kanaltemperatur', scope: 'ch', src: 'status', type: 'num', unit: '°C', dec: 1,
        get: (s, i) => s.channelTemp[i] },
    { key: 'channelAlarm', group: 'Kanal', label: 'Kanal-Alarm / Schutz-Mute (Text)', scope: 'ch', src: 'status', type: 'text',
        get: (s, i) => {
            const a = s.alarms, t = [];
            if (a.soaThermal[i]) t.push('SOA thermisch');
            if (a.temperature[i]) t.push('Temperatur');
            if (a.vrail[i]) t.push('V-Rail');
            return t.concat(a.protectionMutes[i]).join(', ') || 'OK';
        } },
    // ----------------------------------------------------------- matrix
    { key: 'matrixRoute', group: 'Matrix', label: 'Route ein (Gain ≠ −∞)', scope: 'mx', src: 'status', type: 'bool', write: 'matrixRoute',
        get: (s, i, si, oi) => s.matrix.gainDb[si][oi] !== null, text: ['ein', 'aus'] },
    { key: 'matrixGain', group: 'Matrix', label: 'Matrix Gain', scope: 'mx', src: 'status', type: 'db', write: 'matrixGain',
        get: (s, i, si, oi) => s.matrix.gainDb[si][oi] },
    { key: 'matrixMute', group: 'Matrix', label: 'Matrix Mute', scope: 'mx', src: 'status', type: 'bool', write: 'matrixMute',
        get: (s, i, si, oi) => s.matrix.mute[si][oi], text: ['🔇 ein', 'aus'] },
    // ----------------------------------------------------------- meters (need Meter-Poll > 0 in the amp config)
    { key: 'inputRmsDb', group: 'Messwerte', label: 'Eingang RMS', scope: 'ch', src: 'meters', type: 'db', unit: 'dBFS',
        get: (m, i) => m.input.rmsDb[i] },
    { key: 'inputPeakDb', group: 'Messwerte', label: 'Eingang Peak', scope: 'ch', src: 'meters', type: 'db', unit: 'dBFS',
        get: (m, i) => m.input.peakDb[i] },
    { key: 'outputVrms', group: 'Messwerte', label: 'Ausgangsspannung RMS', scope: 'ch', src: 'meters', type: 'num', unit: 'V', dec: 1,
        get: (m, i) => m.output.vRms[i] },
    { key: 'outputVpeak', group: 'Messwerte', label: 'Ausgangsspannung Peak', scope: 'ch', src: 'meters', type: 'num', unit: 'V', dec: 1,
        get: (m, i) => m.output.vPeak[i] },
    { key: 'outputIrms', group: 'Messwerte', label: 'Ausgangsstrom RMS', scope: 'ch', src: 'meters', type: 'num', unit: 'A', dec: 2,
        get: (m, i) => m.output.iRms[i] },
    { key: 'outputIpeak', group: 'Messwerte', label: 'Ausgangsstrom Peak', scope: 'ch', src: 'meters', type: 'num', unit: 'A', dec: 2,
        get: (m, i) => m.output.iPeak[i] },
    { key: 'outputPower', group: 'Messwerte', label: 'Leistung (≈ Vrms·Irms)', scope: 'ch', src: 'meters', type: 'num', unit: 'W', dec: 1,
        get: (m, i) => m.output.vRms[i] * m.output.iRms[i] },
    { key: 'headroomDb', group: 'Messwerte', label: 'Headroom', scope: 'ch', src: 'meters', type: 'db', unit: 'dB',
        get: (m, i) => m.output.headroomDb[i] },
    { key: 'limiterDb', group: 'Messwerte', label: 'Limiter-Reduktion', scope: 'ch', src: 'meters', type: 'db', unit: 'dB',
        get: (m, i) => (m.output.gainReductionDb[i] === null ? null : -m.output.gainReductionDb[i]) },
    { key: 'signal', group: 'Messwerte', label: 'Signal am Ausgang', scope: 'ch', src: 'meters', type: 'bool',
        get: (m, i) => m.output.signalPresence[i], text: ['● Signal', '○ kein Signal'] },
];

const BY_KEY = Object.fromEntries(V.map(v => [v.key, v]));

/** Raw value (number/bool/string/null). opts: {channel, source, output, floor} */
function extract(def, obj, opts) {
    const i = (Number(opts.channel) || 1) - 1, si = (Number(opts.source) || 1) - 1, oi = (Number(opts.output) || 1) - 1;
    let v = def.get(obj, i, si, oi);
    if (v === undefined) return undefined;
    if (typeof v === 'number') v = fix(v, def.dec !== undefined ? def.dec : 1);
    const floor = opts.floor === '' || opts.floor === undefined || opts.floor === null ? null : Number(opts.floor);
    if (floor !== null && !Number.isNaN(floor) && (def.type === 'db' || def.type === 'num') && (v === null || v < floor)) v = floor;
    return v;
}

/** Human readable text incl. unit. */
function format(def, v) {
    if (v === undefined) return undefined;
    if (def.type === 'bool') return def.text ? def.text[v ? 0 : 1] : (v ? 'ja' : 'nein');
    if (def.type === 'db') {
        const u = def.unit || 'dB';
        if (v === null) return '-∞ ' + u;
        return (v > 0 && u === 'dB' ? '+' : '') + v.toFixed(1) + ' ' + u;
    }
    if (def.type === 'num') return v === null ? '–' : v.toFixed(def.dec !== undefined ? def.dec : 1) + (def.unit ? ' ' + def.unit : '');
    return v === null ? '' : String(v);
}

/** Command object for writing msg.payload to this value. */
function writeCommand(def, payload, opts) {
    if (!def.write) throw new Error(`value "${def.key}" is read only`);
    const cmd = { command: def.write, value: payload, min: opts.min, max: opts.max };
    if (def.scope === 'ch') cmd.channel = Number(opts.channel) || 1;
    if (def.scope === 'mx') { cmd.source = Number(opts.source) || 1; cmd.output = Number(opts.output) || 1; }
    if (def.write === 'matrixRoute') {
        const on = payload === true || payload === 1 || /^(true|1|on|ein)$/i.test(String(payload));
        cmd.command = 'matrixGain'; cmd.value = on ? 0 : 'off';
    }
    if (def.type === 'db' && (payload === '' || payload === undefined || payload === null)) {
        // cleared input field: matrix crosspoint -> not routed, other gains -> ignore (no accidental -inf)
        if (def.write !== 'matrixGain') return null;
        cmd.value = 'off';
    }
    return cmd;
}

/** Catalog for the editor (no functions). */
const catalog = () => V.map(({ key, group, label, scope, src, type, write, unit }) =>
    ({ key, group, label, scope, src, type, writable: !!write, unit: unit || (type === 'db' ? 'dB' : '') }));

module.exports = { VALUES: V, BY_KEY, extract, format, writeCommand, catalog };
