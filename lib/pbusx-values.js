'use strict';
// Catalog of single values for the pbusx-value node (Nota 142 / DC Rider).
// Same structure as mezzo-values.js; extract/format/writeCommand are shared.
// "(?)" in a label = meaning derived from captures but not confirmed on the device (see docs/PBUSX.md).
// "(DC Rider)" = only on the DC Rider (official spec 1.0.3); on the Nota these values stay empty.
// Alarms, nickname, input gain/mute and limiter are available on both (tested on the Nota 142).
const { extract, format, writeCommand } = require('./mezzo-values');

const V = [
    // ----------------------------------------------------------- device
    { key: 'name', group: 'Gerät', label: 'Gerätename', scope: 'dev', src: 'status', type: 'text', get: (s) => s.name },
    { key: 'model', group: 'Gerät', label: 'Modell', scope: 'dev', src: 'status', type: 'text', get: (s) => s.info && s.info.modelName },
    { key: 'serial', group: 'Gerät', label: 'Seriennummer', scope: 'dev', src: 'status', type: 'text', get: (s) => s.info && s.info.serial },
    { key: 'alarm', group: 'Gerät', label: 'Alarm aktiv', scope: 'dev', src: 'status', type: 'bool',
        get: (s) => s.alarms.any, text: ['⚠ Alarm', '✓ OK'] },
    { key: 'alarmText', group: 'Gerät', label: 'Geräte-Alarme (Text)', scope: 'dev', src: 'status', type: 'text',
        get: (s) => (s.alarms.machine ? s.alarms.machine.flags.join(', ') || 'keine' : undefined) },
    { key: 'nickname', group: 'Gerät', label: 'Nickname', scope: 'dev', src: 'status', type: 'text', write: 'nickname',
        get: (s) => s.nickname },
    { key: 'standby', group: 'Gerät', label: 'Standby (DC Rider)', scope: 'dev', src: 'status', type: 'bool', write: 'standby',
        get: (s) => s.standby, text: ['Standby', 'ein'] },
    { key: 'callButton', group: 'Gerät', label: 'Ruftaste gedrückt (DC Rider)', scope: 'dev', src: 'status', type: 'bool',
        get: (s) => s.callButton, text: ['gedrückt', '–'] },
    { key: 'temperatureC', group: 'Gerät', label: 'Temperatur °C (DC Rider)', scope: 'dev', src: 'status', type: 'num', unit: '°C', dec: 1,
        get: (s) => s.supply && s.supply.temperatureC },
    { key: 'vbatt1', group: 'Gerät', label: 'Batterie 1 CH1–8 (DC Rider)', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 1,
        get: (s) => s.supply && s.supply.vbatt && s.supply.vbatt[0] },
    { key: 'vbatt2', group: 'Gerät', label: 'Batterie 2 CH9–16 (DC Rider)', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 1,
        get: (s) => s.supply && s.supply.vbatt && s.supply.vbatt[1] },
    { key: 'railCh', group: 'Gerät', label: 'Rail-Spannung des Kanals (DC Rider)', scope: 'ch', src: 'status', type: 'num', unit: 'V', dec: 1,
        get: (s, i) => s.supply && s.supply.rails && s.supply.rails[Math.floor(i / 4)] },
    { key: 'temperature', group: 'Gerät', label: 'Temperatur', scope: 'dev', src: 'status', type: 'num', unit: '%', dec: 0,
        get: (s) => s.supply && s.supply.temperaturePct },
    { key: 'rail', group: 'Gerät', label: 'Rail-Spannung (?)', scope: 'dev', src: 'status', type: 'num', unit: 'V', dec: 1,
        get: (s) => s.supply && s.supply.rail },
    // ----------------------------------------------------------- channel settings
    { key: 'userGain', group: 'Kanal', label: 'User Gain (Lautstärke)', scope: 'ch', src: 'status', type: 'db', write: 'gain',
        get: (s, i) => s.user.gainDb[i] },
    { key: 'userMute', group: 'Kanal', label: 'User Mute', scope: 'ch', src: 'status', type: 'bool', write: 'mute',
        get: (s, i) => s.user.mute[i], text: ['🔇 ein', 'aus'] },
    { key: 'polarity', group: 'Kanal', label: 'User Polarität invertiert', scope: 'ch', src: 'status', type: 'bool', write: 'polarity',
        get: (s, i) => s.user.polarityInverted[i], text: ['invertiert', 'normal'] },
    { key: 'userDelay', group: 'Kanal', label: 'User Delay', scope: 'ch', src: 'status', type: 'num', unit: 'ms', dec: 2, write: 'delay',
        get: (s, i) => (s.user.delay[i] === null || s.user.delay[i] === undefined ? s.user.delay[i] : s.user.delay[i] * 1000) },
    { key: 'outputGain', group: 'Kanal', label: 'Way Gain', scope: 'ch', src: 'status', type: 'db', write: 'outputGain',
        get: (s, i) => s.output.gainDb[i] },
    { key: 'outputMute', group: 'Kanal', label: 'Way Mute', scope: 'ch', src: 'status', type: 'bool', write: 'outputMute',
        get: (s, i) => s.output.mute[i], text: ['🔇 ein', 'aus'] },
    { key: 'outputPolarity', group: 'Kanal', label: 'Way Polarität invertiert', scope: 'ch', src: 'status', type: 'bool', write: 'outputPolarity',
        get: (s, i) => s.output.polarityInverted[i], text: ['invertiert', 'normal'] },
    { key: 'wayName', group: 'Kanal', label: 'Way-Name', scope: 'ch', src: 'status', type: 'text', get: (s, i) => s.output.name[i] },
    { key: 'channelAlarm', group: 'Kanal', label: 'Kanal-Alarme', scope: 'ch', src: 'status', type: 'text',
        get: (s, i) => (s.alarms.output && s.alarms.output[i] ? s.alarms.output[i].flags.join(', ') || 'keine' : undefined) },
    { key: 'shortCircuit', group: 'Kanal', label: 'Kurzschluss', scope: 'ch', src: 'status', type: 'bool',
        get: (s, i) => (s.alarms.output && s.alarms.output[i] ? s.alarms.output[i].flags.includes('shortCircuit') : undefined),
        text: ['⚠ Kurzschluss', 'ok'] },
    // input pre gain / mute (matrix source), channel field = input number
    { key: 'inputGain', group: 'Kanal', label: 'Eingang Gain (Kanal = Eingang)', scope: 'ch', src: 'status', type: 'db', write: 'inputGain',
        get: (s, i) => (s.input ? s.input.gainDb[i] : undefined) },
    { key: 'inputMute', group: 'Kanal', label: 'Eingang Mute (Kanal = Eingang)', scope: 'ch', src: 'status', type: 'bool', write: 'inputMute',
        get: (s, i) => (s.input ? s.input.mute[i] : undefined), text: ['🔇 ein', 'aus'] },
    // ----------------------------------------------------------- matrix
    { key: 'matrixRoute', group: 'Matrix', label: 'Route ein (Gain ≠ −∞)', scope: 'mx', src: 'status', type: 'bool', write: 'matrixRoute',
        get: (s, i, si, oi) => (s.matrix.gainDb[si] ? s.matrix.gainDb[si][oi] !== null : undefined), text: ['ein', 'aus'] },
    { key: 'matrixGain', group: 'Matrix', label: 'Matrix Gain', scope: 'mx', src: 'status', type: 'db', write: 'matrixGain',
        get: (s, i, si, oi) => (s.matrix.gainDb[si] ? s.matrix.gainDb[si][oi] : undefined) },
    { key: 'matrixMute', group: 'Matrix', label: 'Matrix Mute', scope: 'mx', src: 'status', type: 'bool', write: 'matrixMute',
        get: (s, i, si, oi) => (s.matrix.mute[si] ? s.matrix.mute[si][oi] : undefined), text: ['🔇 ein', 'aus'] },
    // ----------------------------------------------------------- meters (need Meter-Poll > 0 in the amp config)
    // input meters are per matrix input (channel field = input number)
    { key: 'inputRmsDb', group: 'Messwerte', label: 'Eingang RMS (Kanal = Eingang)', scope: 'ch', src: 'meters', type: 'db', unit: 'dBFS',
        get: (m, i) => m.input.rmsDb[i] },
    { key: 'inputPeakDb', group: 'Messwerte', label: 'Eingang Peak (Kanal = Eingang)', scope: 'ch', src: 'meters', type: 'db', unit: 'dBFS',
        get: (m, i) => m.input.peakDb[i] },
    { key: 'outputVrms', group: 'Messwerte', label: 'Ausgangsspannung RMS', scope: 'ch', src: 'meters', type: 'num', unit: 'V', dec: 2,
        get: (m, i) => m.output.vRms[i] },
    { key: 'outputVpeak', group: 'Messwerte', label: 'Ausgangsspannung Peak', scope: 'ch', src: 'meters', type: 'num', unit: 'V', dec: 2,
        get: (m, i) => m.output.vPeak[i] },
    { key: 'outputIrms', group: 'Messwerte', label: 'Ausgangsstrom RMS', scope: 'ch', src: 'meters', type: 'num', unit: 'A', dec: 2,
        get: (m, i) => m.output.iRms[i] },
    { key: 'outputIpeak', group: 'Messwerte', label: 'Ausgangsstrom Peak', scope: 'ch', src: 'meters', type: 'num', unit: 'A', dec: 2,
        get: (m, i) => m.output.iPeak[i] },
    { key: 'headroomDb', group: 'Messwerte', label: 'Headroom', scope: 'ch', src: 'meters', type: 'db', unit: 'dB',
        get: (m, i) => m.output.headroomDb[i] },
    { key: 'signal', group: 'Messwerte', label: 'Signal am Ausgang', scope: 'ch', src: 'meters', type: 'bool',
        get: (m, i) => m.output.signalPresence[i], text: ['● Signal', '○ kein Signal'] },
    { key: 'outputClip', group: 'Messwerte', label: 'Clip am Ausgang', scope: 'ch', src: 'meters', type: 'bool',
        get: (m, i) => m.output.clip[i], text: ['⚠ Clip', 'ok'] },
    { key: 'inputSignal', group: 'Messwerte', label: 'Signal am Eingang (Kanal = Eingang, DC Rider)', scope: 'ch', src: 'meters', type: 'bool',
        get: (m, i) => (m.input.signalPresence ? m.input.signalPresence[i] : undefined), text: ['● Signal', '○ kein Signal'] },
    { key: 'limiterTotal', group: 'Messwerte', label: 'Limiter Gain-Reduktion gesamt (0 dB = kein Limiting)', scope: 'ch', src: 'meters', type: 'db', unit: 'dB',
        get: (m, i) => (m.output.limiter && m.output.limiter[i] ? m.output.limiter[i].totalDb : undefined) },
];

const BY_KEY = Object.fromEntries(V.map((v) => [v.key, v]));

const catalog = () => V.map(({ key, group, label, scope, src, type, write, unit }) =>
    ({ key, group, label, scope, src, type, writable: !!write, unit: unit || (type === 'db' ? 'dB' : '') }));

module.exports = { VALUES: V, BY_KEY, extract, format, writeCommand, catalog };
