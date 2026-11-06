'use strict';
/**
 * Mezzo feature extensions (from the Mezzo spec 1.4.0, not yet tested on a device):
 * source selection / backup, pilot tone, load monitor, GPI / GPO.
 *
 * Each module exports READS ([name, addr, size]), decode(blocks), encode(cmd) → ops | null,
 * COMMANDS and VALUES (mezzo-values catalog entries). This file bundles them:
 * - every module gets its own read frame (a NAK / timeout only affects that module)
 * - decode result goes to status[key]
 */
const MODULES = [
    ['sources', './mezzo-sources'],
    ['pilotTone', './mezzo-pilot'],
    ['loadMonitor', './mezzo-load'],
    ['gpio', './mezzo-gpio'],
].map(([key, file]) => ({ key, mod: require(file) }));

const COMMANDS = MODULES.flatMap((m) => m.mod.COMMANDS || []);
const VALUES = MODULES.flatMap((m) => m.mod.VALUES || []);

/** Read groups: one per module. */
const READ_GROUPS = MODULES.map(({ key, mod }) => ({ key, reads: mod.READS || [] })).filter((g) => g.reads.length);

/** Turn the replies of one group into status[key] (null when the device rejected all reads). */
function decodeGroup(key, blocks) {
    const m = MODULES.find((x) => x.key === key);
    if (!m || Object.values(blocks).every((b) => !b)) return null;
    try { return m.mod.decode(blocks); } catch (e) { return { error: e.message }; }
}

/** First module that knows the command; null when none does. */
function encode(cmd) {
    for (const { mod } of MODULES) {
        const ops = mod.encode(cmd);
        if (ops) return ops;
    }
    return null;
}

module.exports = { MODULES, COMMANDS, VALUES, READ_GROUPS, decodeGroup, encode };
