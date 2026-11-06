'use strict';
/**
 * Powersoft Mezzo PBus-over-UDP client.
 * Implements "Mezzo Communication Protocol Specifications" issue 1.2.3 (see docs/).
 *
 * Request : STX | TAG(4) | PBus cmd... | CRC16(2) | ETX
 * Reply   : STX | 'MZO' | ProtoID(2)=0x0001 | TAG(4) | PBus reply... | CRC16(2) | ETX
 * PBus    : OPCODE(1) | ADDR32 | SIZE32 | DATA      (all little endian)
 * CRC16-CCITT (poly 0x1021, init 0) over everything between STX/ETX, before escaping.
 * Escaping: STX/ETX/ESC -> ESC, byte+0x40
 */
const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');

const STX = 0x02, ETX = 0x03, ESC = 0x1b;
const DEFAULT_PORT = 8002;
const MAX_PLAIN_FRAME = 2000;

const CRC_TABLE = (() => {
    const t = new Uint16Array(256);
    for (let b = 0; b < 256; b++) {
        let v = b << 8;
        for (let i = 0; i < 8; i++) v = (v & 0x8000) ? ((v << 1) ^ 0x1021) : (v << 1);
        t[b] = v & 0xffff;
    }
    return t;
})();

function crc16(buf, crc = 0) {
    for (const b of buf) crc = (CRC_TABLE[((crc >> 8) ^ b) & 0xff] ^ (crc << 8)) & 0xffff;
    return crc;
}

function escape(buf) {
    const out = [];
    for (const b of buf) {
        if (b === STX || b === ETX || b === ESC) out.push(ESC, b + 0x40);
        else out.push(b);
    }
    return Buffer.from(out);
}

function unescape(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === ESC && i + 1 < buf.length) out.push(buf[++i] - 0x40);
        else out.push(buf[i]);
    }
    return Buffer.from(out);
}

/** Encode a PBus command. op: 'R' | 'W' | 'E' | 'C' */
function pbusCmd(op, addr, size, data) {
    const h = Buffer.alloc(9);
    h.write(op, 0, 'latin1');
    h.writeUInt32LE(addr >>> 0, 1);
    h.writeUInt32LE(size >>> 0, 5);
    return data ? Buffer.concat([h, data]) : h;
}

function buildFrame(tag, cmds) {
    const tagBuf = Buffer.alloc(4);
    tagBuf.writeUInt32LE(tag >>> 0, 0);
    const body = Buffer.concat([tagBuf, ...cmds]);
    const crc = Buffer.alloc(2);
    crc.writeUInt16LE(crc16(body), 0);
    return Buffer.concat([Buffer.from([STX]), escape(Buffer.concat([body, crc])), Buffer.from([ETX])]);
}

/** Parse a reply frame. Returns {tag, replies:[{op,addr,size,data,nak}]} or throws. */
function parseFrame(frame, requests) {
    if (frame.length < 13 || frame[0] !== STX || frame[frame.length - 1] !== ETX) throw new Error('malformed frame');
    const b = unescape(frame.subarray(1, frame.length - 1));
    const payload = b.subarray(0, b.length - 2);
    const crcRx = b.readUInt16LE(b.length - 2);
    if (crc16(payload) !== crcRx) throw new Error('CRC mismatch');
    if (payload.toString('latin1', 0, 3) !== 'MZO') throw new Error('bad magic');
    const proto = payload.readUInt16LE(3);
    const tag = payload.readUInt32LE(5);
    const replies = [];
    let p = 9, i = 0;
    while (p + 9 <= payload.length) {
        const op = String.fromCharCode(payload[p]);
        const addr = payload.readUInt32LE(p + 1);
        const size = payload.readUInt32LE(p + 5);
        p += 9;
        let data = null;
        if (size > 0) {
            if (op === 'R') { data = payload.subarray(p, p + size); p += size; }
            else if (op === 'C') { data = payload.subarray(p, p + 2); p += 2; }
        }
        const req = requests && requests[i];
        replies.push({ op, addr, size, data, nak: size === 0 || (req && req.size !== size) });
        i++;
    }
    return { proto, tag, replies };
}

/**
 * One client per amplifier. The Mezzo accepts only one UDP "connection" at a time,
 * so all requests are serialized through a single socket and queue.
 */
class MezzoClient extends EventEmitter {
    constructor(opts) {
        super();
        this.host = opts.host;
        this.port = opts.port || DEFAULT_PORT;
        this.timeout = opts.timeout || 1000;
        this.retries = opts.retries != null ? opts.retries : 2;
        // Frame codec: Mezzo PBus by default; PBusX (Nota / DC Rider) passes its own (see pbusx-client.js).
        this.codec = opts.codec || { build: buildFrame, parse: parseFrame };
        this.queue = [];
        this.busy = false;
        this.current = null;
        this.socket = null;
        this.closed = false;
    }

    _ensureSocket() {
        if (this.socket) return;
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
        this.socket.on('error', (err) => {
            this.emit('error', err);
            try { this.socket.close(); } catch (e) { /* ignore */ }
            this.socket = null;
        });
    }

    close() {
        this.closed = true;
        const err = new Error('client closed');
        if (this.current) { clearTimeout(this.current.timer); this.current.reject(err); this.current = null; }
        for (const q of this.queue) q.reject(err);
        this.queue = [];
        if (this.socket) { try { this.socket.close(); } catch (e) { /* ignore */ } this.socket = null; }
    }

    /**
     * Execute a list of PBus operations in one frame (multicommand).
     * ops: [{op:'R', addr, size} | {op:'W', addr, data:Buffer}]
     * Resolves with array of replies (same order).
     */
    transact(ops) {
        if (this.closed) return Promise.reject(new Error('client closed'));
        let plain = 4 + 2;
        for (const o of ops) plain += 9 + (o.data ? o.data.length : 0);
        if (plain > MAX_PLAIN_FRAME) return Promise.reject(new Error('frame too large, split request'));
        return new Promise((resolve, reject) => {
            this.queue.push({ ops, resolve, reject, attempts: 0 });
            this._next();
        });
    }

    _next() {
        if (this.busy || this.queue.length === 0 || this.closed) return;
        this._ensureSocket();
        this.busy = true;
        const job = this.queue.shift();
        this.current = job;
        this._send(job);
    }

    _send(job) {
        job.attempts++;
        job.tag = crypto.randomBytes(4).readUInt32LE(0);
        job.requests = job.ops.map(o => ({ size: o.op === 'W' ? o.data.length : o.size }));
        const cmds = job.ops.map(o => o.op === 'W'
            ? pbusCmd('W', o.addr, o.data.length, o.data)
            : pbusCmd(o.op, o.addr, o.size));
        const frame = this.codec.build(job.tag, cmds);
        job.timer = setTimeout(() => this._onTimeout(job), this.timeout);
        this.socket.send(frame, this.port, this.host, (err) => {
            if (err) { clearTimeout(job.timer); this._finish(job, err); }
        });
    }

    _onTimeout(job) {
        if (this.current !== job) return;
        if (job.attempts <= this.retries) return this._send(job);
        this._finish(job, new Error(`timeout (${this.host}:${this.port})`));
    }

    _onMessage(msg, rinfo) {
        const job = this.current;
        if (!job) return;
        let parsed;
        try { parsed = this.codec.parse(msg, job.requests); } catch (e) { this.emit('warn', `bad reply from ${rinfo.address}: ${e.message}`); return; }
        if (parsed.tag !== job.tag) return; // stale reply of a retried request
        clearTimeout(job.timer);
        this._finish(job, null, parsed.replies);
    }

    _finish(job, err, result) {
        if (this.current !== job) return;
        this.current = null;
        this.busy = false;
        if (err) job.reject(err); else job.resolve(result);
        setImmediate(() => this._next());
    }

    // ---- convenience helpers -------------------------------------------------
    async read(addr, size) {
        const [r] = await this.transact([{ op: 'R', addr, size }]);
        if (r.nak) throw new Error(`NAK on read 0x${addr.toString(16)}/${size}`);
        return r.data;
    }

    async write(addr, data) {
        const [r] = await this.transact([{ op: 'W', addr, data }]);
        if (r.nak) throw new Error(`NAK on write 0x${addr.toString(16)}/${data.length}`);
        return true;
    }
}

module.exports = { MezzoClient, crc16, escape, unescape, buildFrame, parseFrame, pbusCmd, DEFAULT_PORT };
