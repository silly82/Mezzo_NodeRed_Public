'use strict';
/**
 * Discovery and blink for PBusX devices (Nota 142, DC Rider) – text protocol on UDP 12345 (broadcast).
 * See docs/PBUSX.md, section 2.
 *
 *   DISCOVERYREQ:  <own MAC>\n00:00:00:00:00:00\nDISCOVERYREQ\n0\nTAG=<tag>\0
 *   DISCOVERYRESP: <dev MAC>\n<req MAC>\nDISCOVERYRESP\n\n1\n<serial>\n<model>\n\n\n<firmware>\n\n\nTAG=…\n\nPROTOCOL_ID=97\nPROTOCOL_PORT=8082\n…
 *   BLINKREQ:      <own MAC>\n<dev MAC>\nBLINKREQ\n<1|0>\nTAG=<tag>\0      -> BLINKRESP\n<1|0>
 *
 * Replies are broadcast to port 12345, so the socket binds 12345 (shared, reuseAddr).
 */
const dgram = require('dgram');
const os = require('os');
const { PbusxClient, DEFAULT_PORT } = require('./pbusx-client');
const map = require('./pbusx-map');

const DISCOVERY_PORT = 12345;
const TAG = 'NodeRed';

/** Broadcast targets with the MAC of the interface they belong to. */
function interfaces() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
            const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
            out.push({ broadcast: ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'), mac: (a.mac || '00:00:00:00:00:00').toLowerCase() });
        }
    }
    const first = out[0] ? out[0].mac : '00:00:00:00:00:00';
    out.push({ broadcast: '255.255.255.255', mac: first });
    return out;
}

const textFrame = (lines) => Buffer.from(lines.join('\n') + '\0', 'latin1');

function parseText(msg) {
    const lines = msg.toString('latin1').replace(/\0+$/, '').split('\n');
    const kv = {};
    for (const l of lines) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) kv[m[1]] = m[2]; }
    return { lines, kv, type: lines[2] || '' };
}

/** Normalise a MAC to aa:bb:cc:dd:ee:ff (accepts '-' or ':' separators, any case). */
function normMac(mac) {
    const h = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    return h.length === 12 ? h.match(/../g).join(':') : '';
}

/** Open a shared socket on 12345, send frames, collect parsed replies for `timeout` ms. */
function exchange(frames, timeout, onReply) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const finish = () => { try { sock.close(); } catch (e) { /* ignore */ } resolve(); };
        sock.on('error', finish);
        sock.on('message', (msg, rinfo) => { try { onReply(parseText(msg), rinfo); } catch (e) { /* ignore */ } });
        sock.bind(DISCOVERY_PORT, () => {
            sock.setBroadcast(true);
            const send = () => frames.forEach(([buf, target]) => sock.send(buf, DISCOVERY_PORT, target, () => {}));
            send();
            setTimeout(send, 300); // second shot for lossy networks
            setTimeout(finish, timeout);
        });
    });
}

/**
 * @returns {Promise<Array<{ip, mac, serial, model, modelName, firmware, protocolPort, draft}>>}
 */
async function discover(opts = {}) {
    const found = new Map();
    const frames = interfaces().map((i) => [textFrame([i.mac, '00:00:00:00:00:00', 'DISCOVERYREQ', '0', `TAG=${TAG}`]), i.broadcast]);
    await exchange(frames, Math.min(opts.timeout || 1500, 5000), (r, rinfo) => {
        if (r.type !== 'DISCOVERYRESP') return;
        const model = r.lines[6] || '';
        const m = map.modelById(model);
        found.set(rinfo.address, {
            ip: rinfo.address,
            mac: normMac(r.lines[0]),
            serial: r.lines[5] || '',
            model,
            modelName: m ? m.name : model,
            draft: m ? !m.verified : true,
            firmware: r.lines[9] || '',
            protocolId: r.kv.PROTOCOL_ID,
            protocolPort: Number(r.kv.PROTOCOL_PORT) || DEFAULT_PORT,
        });
    });
    return [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

/**
 * Connection test for one IP: reads model/serial/name over PBusX (unicast, works across subnets),
 * MAC/firmware come from a discovery broadcast if the device is reachable that way.
 */
async function probe(host, opts = {}) {
    const c = new PbusxClient({ host, port: opts.port || DEFAULT_PORT, timeout: opts.timeout || 800, retries: 1 });
    try {
        const r = await c.transact([{ op: 'R', addr: map.A.INFO, size: map.INFO_SIZE }, { op: 'R', addr: map.A.NAME, size: 64 }]);
        if (r[0].nak) throw new Error('device answered with NAK on info read');
        const info = map.decodeInfo(r[0].data);
        const m = map.modelById(info.model);
        const res = { ip: host, ...info, name: r[1].nak ? '' : map.cstr(r[1].data), modelName: m ? m.name : info.model, draft: m ? !m.verified : true, mac: '', firmware: '' };
        const d = (await discover({ timeout: 1000 }).catch(() => [])).find((x) => x.ip === host);
        if (d) { res.mac = d.mac; res.firmware = d.firmware; }
        return res;
    } catch (e) {
        throw new Error(`no PBusX device answering at ${host}:${opts.port || DEFAULT_PORT} (${e.message})`);
    } finally {
        c.close();
    }
}

/** Start (on=true) or stop LED identification. Resolves with the confirmed state or rejects on timeout. */
async function blink(mac, on = true, opts = {}) {
    const dst = normMac(mac);
    if (!dst) throw new Error('blink needs the device MAC address (select the device from the search list)');
    let confirmed;
    const frames = interfaces().map((i) => [textFrame([i.mac, dst, 'BLINKREQ', on ? '1' : '0', `TAG=${TAG}`]), i.broadcast]);
    await exchange(frames, opts.timeout || 1000, (r) => {
        if (r.type === 'BLINKRESP' && normMac(r.lines[0]) === dst) confirmed = r.lines[3] === '1';
    });
    if (confirmed === undefined) throw new Error(`no BLINKRESP from ${dst}`);
    return confirmed;
}

module.exports = { discover, probe, blink, normMac, parseText, interfaces, DISCOVERY_PORT };
