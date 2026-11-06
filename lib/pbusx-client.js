'use strict';
/**
 * Powersoft PBusX over UDP (Nota 142, DC Rider) – see docs/PBUSX.md.
 * Not officially documented; derived from network captures of ArmoníaPlus <-> Nota 142.
 *
 * Request : 00 00 | TAG(4, LE) | { OPCODE(1) ADDR32 SIZE32 [DATA] }*
 * Reply   : 00 01 | TAG(4, LE) | { OPCODE(1) ADDR32 SIZE32 [DATA] }*
 * No STX/ETX, no CRC, no escaping. Opcodes as Mezzo PBus: 'R' read, 'W' write, 'C' crc (reply 2 bytes).
 * NAK = reply with SIZE32 = 0.
 */
const { MezzoClient, pbusCmd } = require('./mezzo-client');

const DEFAULT_PORT = 8082;
const HDR_REQUEST = 0x0000;
const HDR_REPLY = 0x0001;

function buildFrame(tag, cmds) {
    const head = Buffer.alloc(6);
    head.writeUInt16BE(HDR_REQUEST, 0);
    head.writeUInt32LE(tag >>> 0, 2);
    return Buffer.concat([head, ...cmds]);
}

/** Parse a reply frame. Returns {proto, tag, replies:[{op,addr,size,data,nak}]} or throws. */
function parseFrame(frame, requests) {
    if (frame.length < 6) throw new Error('short frame');
    const hdr = frame.readUInt16BE(0);
    if (hdr !== HDR_REPLY) throw new Error(`not a PBusX reply (header 0x${hdr.toString(16)})`);
    const tag = frame.readUInt32LE(2);
    const replies = [];
    let p = 6, i = 0;
    while (p + 9 <= frame.length) {
        const op = String.fromCharCode(frame[p]);
        const addr = frame.readUInt32LE(p + 1);
        const size = frame.readUInt32LE(p + 5);
        p += 9;
        let data = null;
        if (size > 0) {
            if (op === 'R') { data = frame.subarray(p, p + size); p += size; }
            else if (op === 'C') { data = frame.subarray(p, p + 2); p += 2; }
        }
        if (p > frame.length) throw new Error('truncated frame');
        const req = requests && requests[i];
        replies.push({ op, addr, size, data, nak: size === 0 || !!(req && req.size !== size) });
        i++;
    }
    return { proto: 'pbusx', tag, replies };
}

const CODEC = { build: buildFrame, parse: parseFrame };

/** Expected reply bytes of one operation (header + data). */
const replyBytes = (o) => 9 + (o.op === 'R' ? o.size : o.op === 'C' ? 2 : 0);

class PbusxClient extends MezzoClient {
    constructor(opts) {
        super({ ...opts, port: opts.port || DEFAULT_PORT, codec: CODEC });
        // keep single UDP replies below the Ethernet MTU (device limits unknown)
        this.maxReplyBytes = opts.maxReplyBytes || 1200;
    }

    /**
     * Like transact(), but splits a long list of operations into several frames so that no reply
     * exceeds maxReplyBytes. Resolves with all replies in the original order.
     */
    async transactMany(ops) {
        const out = [];
        let batch = [], bytes = 6;
        for (const o of ops) {
            const n = replyBytes(o);
            if (batch.length && bytes + n > this.maxReplyBytes) {
                out.push(...await this.transact(batch));
                batch = []; bytes = 6;
            }
            batch.push(o); bytes += n;
        }
        if (batch.length) out.push(...await this.transact(batch));
        return out;
    }
}

module.exports = { PbusxClient, buildFrame, parseFrame, pbusCmd, CODEC, DEFAULT_PORT };
