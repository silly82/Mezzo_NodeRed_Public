'use strict';
/**
 * Discover Mezzo amplifiers by broadcasting a PBus read of the Info + NickName areas
 * to UDP 8002 on every IPv4 interface (plus 255.255.255.255). Mezzo answers broadcasts.
 */
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { buildFrame, pbusCmd, parseFrame, DEFAULT_PORT } = require('./mezzo-client');
const map = require('./mezzo-map');

function broadcastAddresses() {
    const out = new Set(['255.255.255.255']);
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family !== 'IPv4' && a.family !== 4) continue;
            if (a.internal) continue;
            const ip = a.address.split('.').map(Number);
            const mask = a.netmask.split('.').map(Number);
            out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
        }
    }
    return [...out];
}

/**
 * Human readable model name. Model ID suffix "_ND" = no Dante (A version), "_D" = Dante (AD version).
 * e.g. "DMZO324_ND" -> "Mezzo 324 A". Only _ND verified on a real device.
 */
function prettyModel(model) {
    const m = /MZO(\d{3})(?:_(\w+))?/.exec(model || '');
    if (!m) return model || 'Mezzo';
    const suffix = (m[2] || '').toUpperCase();
    return `Mezzo ${m[1]} ${suffix === 'D' ? 'AD' : 'A'}`;
}

function infoFromReplies(replies) {
    const info = replies[0] && !replies[0].nak ? map.decodeInfo(replies[0].data) : {};
    if (replies[1] && !replies[1].nak) {
        const b = replies[1].data; const z = b.indexOf(0);
        info.nickname = b.toString('latin1', 0, z < 0 ? b.length : z);
    }
    info.modelName = prettyModel(info.model);
    return info;
}

const QUERY = [{ op: 'R', addr: map.A.INFO, size: 0x7a }, { op: 'R', addr: map.A.NICKNAME, size: 80 }];

/**
 * @param {object} [opts] {timeout=1500, port=8002, targets=[...] (unicast/broadcast addresses)}
 * @returns {Promise<Array<{ip, model, modelName, serial, firmware, mac, nickname}>>}
 */
function discover(opts = {}) {
    const timeout = opts.timeout || 1500;
    const port = opts.port || DEFAULT_PORT;
    const targets = opts.targets || broadcastAddresses();
    return new Promise((resolve) => {
        const found = new Map();
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const tag = crypto.randomBytes(4).readUInt32LE(0);
        const frame = buildFrame(tag, QUERY.map(q => pbusCmd(q.op, q.addr, q.size)));
        const finish = () => { try { sock.close(); } catch (e) { /* ignore */ } resolve([...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))); };
        sock.on('error', finish);
        sock.on('message', (msg, rinfo) => {
            try {
                const p = parseFrame(msg, QUERY);
                if (p.tag !== tag) return;
                found.set(rinfo.address, { ip: rinfo.address, ...infoFromReplies(p.replies) });
            } catch (e) { /* not a Mezzo reply */ }
        });
        sock.bind(0, () => {
            sock.setBroadcast(true);
            for (const t of targets) sock.send(frame, port, t, () => {});
            // second shot for lossy networks
            setTimeout(() => { for (const t of targets) sock.send(frame, port, t, () => {}); }, 300);
            setTimeout(finish, timeout);
        });
    });
}

/** Query a single host (connection test). Resolves info or rejects. */
async function probe(host, opts = {}) {
    const res = await discover({ timeout: opts.timeout || 1200, port: opts.port, targets: [host] });
    if (!res.length) throw new Error(`no Mezzo answering at ${host}:${opts.port || DEFAULT_PORT}`);
    return res[0];
}

module.exports = { discover, probe, prettyModel, broadcastAddresses };
