'use strict';
/**
 * Simulator mode: Mezzo and Nota without hardware.
 *
 * Enable per amp config node (checkbox "Simulator") or for all amps with the environment variable
 * POWERSOFT_SIM=1 (e.g. `POWERSOFT_SIM=1 node-red`). A simulated client answers the same PBus / PBusX
 * operations as the real device from an in-memory address space:
 * - realistic factory values (model, serial, firmware, gains, names, EQ, source selection …)
 * - writes are stored and read back (gain, mute, matrix, nickname, standby …)
 * - meters follow a "music" signal through input → matrix → user / way gain → output (standby / mute = silence)
 * - NAK where the real device answers NAK (missing channel blocks, Mezzo auto turn on, Nota standby)
 * One simulated device per kind + host, shared by all nodes using it.
 */
const { MezzoClient } = require('./mezzo-client');
const { PbusxClient } = require('./pbusx-client');

const PAGE = 0x10000;
const envOn = () => /^(1|true|yes|on|ja)$/i.test(String(process.env.POWERSOFT_SIM || ''));
/** Simulator active for an amp config (checkbox) or globally (POWERSOFT_SIM=1). */
const enabled = (config) => envOn() || config === true || !!(config && (config.simulate === true || config.simulate === 'true'));

class Memory {
    constructor() { this.pages = new Map(); }
    page(p) { let b = this.pages.get(p); if (!b) { b = Buffer.alloc(PAGE); this.pages.set(p, b); } return b; }
    read(addr, size) {
        const out = Buffer.alloc(size);
        for (let i = 0; i < size;) {
            const a = addr + i, p = Math.floor(a / PAGE), o = a % PAGE, n = Math.min(size - i, PAGE - o);
            this.page(p).copy(out, i, o, o + n); i += n;
        }
        return out;
    }
    write(addr, data) {
        for (let i = 0; i < data.length;) {
            const a = addr + i, p = Math.floor(a / PAGE), o = a % PAGE, n = Math.min(data.length - i, PAGE - o);
            data.copy(this.page(p), o, i, i + n); i += n;
        }
    }
    f32(a, v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); this.write(a, b); }
    u32(a, v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); this.write(a, b); }
    u8(a, v) { this.write(a, Buffer.from([v & 0xff])); }
    i8(a, v) { const b = Buffer.alloc(1); b.writeInt8(v, 0); this.write(a, b); }
    str(a, s, len) { const b = Buffer.alloc(len); b.write(String(s).slice(0, len - 1), 'latin1'); this.write(a, b); }
    rf(a) { return this.read(a, 4).readFloatLE(0); }
    ru32(a) { return this.read(a, 4).readUInt32LE(0); }
    ru8(a) { return this.read(a, 1)[0]; }
}

// "music": slowly varying level per input (linear full scale), deterministic per input
const t0 = Date.now();
function music(q, t = (Date.now() - t0) / 1000) {
    const env = 0.5 + 0.3 * Math.sin(t * 0.7 + q) + 0.2 * Math.sin(t * 3.1 + 2 * q);
    if (q >= 2) return { rms: 1e-23, peak: 1e-23 };   // inputs 1/2 carry signal, 3/4 silent (denormal like the device)
    const rms = Math.max(0.005, 0.12 * env);
    return { rms, peak: Math.min(1, rms * (2.2 + 0.6 * Math.sin(t * 5 + q))) };
}
const jitter = (v, p = 0.02) => v * (1 + (Math.random() - 0.5) * p);

// ===================================================================== Mezzo 324 A
class SimMezzo {
    constructor(host) {
        const m = this.m = new Memory();
        m.str(0x0000, 'DMZO324_ND', 20); m.str(0x0014, 'SIM-MEZZO', 16); m.str(0x0060, '1.6.1.24', 20);
        m.write(0x0074, Buffer.from([0x00, 0x1d, 0xc1, 0x51, 0x4d, 0x01]));
        m.str(0x00f4, 'Simulator Mezzo', 80);
        const ip = String(host || '127.0.0.1').split('.').map(Number);
        m.write(0x1300, Buffer.from(ip.length === 4 && ip.every((x) => x >= 0 && x < 256) ? ip : [127, 0, 0, 1]));
        m.write(0x1304, Buffer.from([255, 255, 255, 0])); m.write(0x1308, Buffer.from([192, 168, 1, 1]));
        m.u32(0x3000, 1);
        for (let q = 0; q < 4; q++) {
            m.f32(0x3008 + 4 * q, 1);
            for (let a = 0; a < 4; a++) m.f32(0x3018 + 16 * q + 4 * a, q === a ? 1 : 0);
        }
        for (let k = 0; k < 4; k++) {
            m.f32(0x4000 + 4 * k, 1); m.f32(0x4028 + 4 * k, 1);
            m.f32(0x7010 + 4 * k, 1); m.str(0x7050 + 16 * k, `Way ${'ABCD'[k]}`, 16);
            m.f32(0xb0f4 + 4 * k, 38);
            m.f32(0x79c0 + 4 * k, 0.5);                     // load monitor sensibility default
            m.f32(0x2274 + 4 * k, 20000); m.f32(0x2284 + 4 * k, 2); m.f32(0x2294 + 4 * k, 0.5); // pilot (sources)
        }
        m.f32(0x2000, 1); m.f32(0x2008, 1);
        this.standby = false;
    }
    nak(op, addr) { return op === 'R' && addr === 0xa004; } // auto turn on: NAK on FW 1.6.1.24
    onWrite(addr, data) {
        if (addr === 0xa000) this.standby = data.readUInt32LE(0) === 1;
    }
    refresh() {
        const m = this.m;
        m.u32(0xb638, this.standby ? 1 : 0);
        [jitter(42, 0.01), jitter(45, 0.01), jitter(230, 0.005), 60, -60, 0.08, 15, -15].forEach((v, i) => m.f32(0xb000 + 4 * i, v));
        const inp = [0, 1, 2, 3].map((q) => music(q));
        inp.forEach((s, q) => { m.f32(0xba40 + 4 * q, s.peak); m.f32(0xba50 + 4 * q, s.rms); });
        for (let k = 0; k < 4; k++) {
            let x = 0;
            for (let q = 0; q < 4; q++) {
                if (m.ru8(0x3004 + q) || m.ru8(0x3058 + 4 * q + k)) continue;
                x += inp[q].rms * m.rf(0x3008 + 4 * q) * m.rf(0x3018 + 16 * q + 4 * k);
            }
            const on = !this.standby && !m.ru8(0x4024 + k) && !m.ru32(0x7040 + 4 * k);
            const vrms = on ? x * m.rf(0x4000 + 4 * k) * m.rf(0x7010 + 4 * k) * 40 : 0;
            const W = 0xbac0;
            m.f32(W + 4 * k, vrms * 1.8); m.f32(W + 0x10 + 4 * k, vrms);
            m.f32(W + 0x20 + 4 * k, vrms * 1.8 / 8); m.f32(W + 0x30 + 4 * k, vrms / 8);
            m.f32(W + 0xd0 + 4 * k, 1); m.u8(W + 0xe0 + k, vrms > 0.05 ? 1 : 0);
            m.f32(W + 0xe8 + 4 * k, vrms > 0 ? 60 / (vrms * 1.8) : 1000);
            m.f32(0xb488 + 4 * k, m.ru8(0x78e8 + k) ? 8 : 0);   // load monitor impedance (8 Ω speaker)
            m.u32(0xb4b8 + 4 * k, m.ru8(0x78e8 + k) ? 1 : 0);
        }
    }
}

// ===================================================================== Nota 142
const IN = (q) => 0x010000 + q * 0x8000;
const CH = (k) => 0x180000 + k * 0x20000;
class SimNota {
    constructor() {
        const m = this.m = new Memory();
        this.inputs = 4; this.outputs = 2;
        m.str(0x0, 'NOTA142', 32); m.str(0x20, 'NOTA142', 32); m.str(0x40, 'SIM-NOTA', 16);
        m.write(0x140, Buffer.from([0x00, 0x21, 0x84, 0x51, 0x4d, 0x02])); m.str(0x150, '1.2.4.0', 20);
        m.str(0x1000, 'Simulator Nota', 80); m.str(0x510000, 'NOTA142-SIM', 64);
        m.u32(0x510054, 4); m.u32(0x510058, 4); m.u32(0x51005c, 48000); m.u32(0x2800, 1);
        for (let q = 0; q < 4; q++) {
            const b = IN(q);
            [-1, -1, 2, 10].forEach((v, i) => m.i8(b + i, v)); m.write(b + 4, Buffer.from([0, 1, 2, 3]));
            m.u8(b + 0xa, 1); for (let i = 0; i < 4; i++) m.f32(b + 0xc + 4 * i, 0.00245);
            m.f32(b + 0x104, 20000); m.f32(b + 0x108, 2); m.f32(b + 0x10c, 2);
            m.f32(b + 0x604, 1);
            for (let a = 0; a < 2; a++) m.f32(b + 0x800 + 4 * a, q % 2 === a ? 1 : 0);
        }
        for (let k = 0; k < 2; k++) {
            const c = CH(k);
            m.f32(c, 1); m.f32(c + 8, 1); m.f32(c + 0x5600, 1); m.str(c + 0x56a0, `Way ${k + 1}`, 16);
            m.str(c + 0x3000, 'Simulated speaker', 400);
            for (let b = 0; b < 4; b++) { const e = c + 0x100 + b * 0x80; m.f32(e + 8, 1.4); m.f32(e + 12, 0.5); m.u32(e + 16, 1000); }
            for (let b = 0; b < 3; b++) {
                const e = c + 0x6600 + b * 0x80;
                m.f32(e + 5, 1000); m.f32(e + 9, 1.4); m.f32(e + 0xd, -1); m.f32(e + 0x11, 12); m.f32(e + 0x15, 0.25);
                m.f32(e + 0x1d, 20); m.f32(e + 0x21, 0.01); m.f32(e + 0x25, 0.01); m.u32(e + 0x29, 2);
            }
            m.f32(c + 0x7401, 20000); m.f32(c + 0x7405, 2); m.f32(c + 0x740a, 20000); m.f32(c + 0x740e, 2); m.f32(c + 0x7412, 16);
            m.f32(c + 0xa008, 1); m.f32(c + 0xa014, 1);
            m.u32(c + 0x10808, 1); m.u32(c + 0x1080c, 1);
            for (let i = 0; i < 7; i++) m.f32(c + 0x10400 + 4 * i, 1);
        }
        for (let n = 0; n < 4; n++) m.f32(0x530000 + n * 0x100, 1);
    }
    nak(op, addr, size) {
        if (addr >= 0x010000 && addr < 0x090000 && Math.floor((addr - 0x010000) / 0x8000) >= this.inputs) return true;
        if (addr >= 0x180000 && addr < 0x380000 && Math.floor((addr - 0x180000) / 0x20000) >= this.outputs) return true;
        if (addr === 0x640000) return true;                                  // no standby on the Nota
        if (op === 'R' && addr >= 0x4000000 && addr < 0x4000020) return true; // commands are write only
        const o = (addr - 0x180000) % 0x20000;                              // generator / load monitor: separate areas
        if (op === 'R' && addr >= 0x180000 && addr < 0x1c0000 && o === 0x7400 && size > 9) return true;
        return false;
    }
    onWrite() { /* blink, reboot, microphone: accepted, no state */ }
    refresh() {
        const m = this.m, t = (Date.now() - t0) / 1000;
        const temp = 50 + 4 * Math.sin(t / 60);
        const r = Buffer.alloc(45);
        [0.009, 0.0025, 0.009, 0.0026, jitter(17.9, 0.01), 5, temp - 2, temp + 1, temp - 6, temp, temp * 1.1].forEach((v, i) => r.writeFloatLE(v, 1 + 4 * i));
        m.write(0x1010000, r);
        const inp = [0, 1, 2, 3].map((q) => music(q));
        inp.forEach((s, q) => {
            const b = IN(q) + 0x4000;
            for (let i = 0; i < 4; i++) { m.f32(b + 4 * i, i === 0 ? s.peak : 1e-23); m.f32(b + 0x10 + 4 * i, i === 0 ? s.rms : 1e-23); }
            m.write(b + 0x20, Buffer.from([s.rms > 0.01 ? 1 : 0, 0, 0, 0, 0, 0, 0, 0])); m.u32(b + 0x28, 0);
        });
        for (let k = 0; k < 2; k++) {
            let x = 0;
            for (let q = 0; q < 4; q++) {
                if (m.ru32(IN(q) + 0x600) || m.ru8(IN(q) + 0x700 + k)) continue;
                x += inp[q].rms * m.rf(IN(q) + 0x604) * m.rf(IN(q) + 0x800 + 4 * k);
            }
            const c = CH(k);
            const on = !m.ru32(c + 16) && !m.ru32(c + 0x560c);
            const vrms = on ? x * m.rf(c) * m.rf(c + 0x5600) * 12 : 0;
            m.f32(c + 0x10000, vrms * 1.8); m.f32(c + 0x10004, vrms); m.f32(c + 0x10008, vrms * 1.8 / 8); m.f32(c + 0x1000c, vrms / 8);
            m.u32(c + 0x10010, vrms > 0.05 ? 1 : 0); m.u32(c + 0x10014, 0);
            m.f32(c + 0x10018, vrms > 0 ? 17.9 / (vrms * 1.8) : 100000);
            const lm = m.ru8(c + 0x7409), gen = m.ru8(c + 0x7400);
            m.f32(c + 0x10800, gen ? m.rf(c + 0x7405) : 0); m.f32(c + 0x10804, lm && gen ? 8 : 0);
            m.u32(c + 0x10810, gen ? 1 : 0); m.u32(c + 0x10814, lm && gen ? 1 : 0);
        }
    }
}

// ===================================================================== clients
const devices = new Map();
function device(kind, host) {
    const key = `${kind}:${host || ''}`;
    if (!devices.has(key)) devices.set(key, kind === 'mezzo' ? new SimMezzo(host) : new SimNota(host));
    return devices.get(key);
}

/** Answer PBus/PBusX ops from the simulated device (same reply shape as the real client). */
function answer(dev, ops) {
    dev.refresh();
    return ops.map((o) => {
        const size = o.op === 'W' ? o.data.length : o.size;
        if (dev.nak(o.op, o.addr, size)) return { op: o.op, addr: o.addr, size: 0, nak: true, data: Buffer.alloc(0) };
        if (o.op === 'W') { dev.m.write(o.addr, o.data); dev.onWrite(o.addr, o.data); return { op: 'W', addr: o.addr, size, nak: false }; }
        if (o.op === 'C') return { op: 'C', addr: o.addr, size, nak: false, data: Buffer.from([0x12, 0x34]) };
        return { op: 'R', addr: o.addr, size, nak: false, data: dev.m.read(o.addr, size) };
    });
}

function simulated(Base, kind) {
    return class extends Base {
        constructor(opts) { super(opts); this.sim = device(kind, opts.host); this.simulated = true; }
        transact(ops) {
            if (this.closed) return Promise.reject(new Error('client closed'));
            return new Promise((resolve) => setTimeout(() => resolve(answer(this.sim, ops)), 3)); // async like the network
        }
        close() { this.closed = true; }
    };
}
const SimMezzoClient = simulated(MezzoClient, 'mezzo');
const SimPbusxClient = simulated(PbusxClient, 'pbusx');

/** Device list for the editor search / connection test in simulator mode. */
const discoverMezzo = (host = '127.0.0.1') => [{ ip: host, model: 'DMZO324_ND', modelName: 'Mezzo 324 A (Simulator)', serial: 'SIM-MEZZO',
    firmware: '1.6.1.24', mac: '00:1d:c1:51:4d:01', nickname: 'Simulator Mezzo' }];
const discoverPbusx = (host = '127.0.0.1') => [{ ip: host, mac: '00:21:84:51:4d:02', serial: 'SIM-NOTA', model: 'NOTA142', model2: 'NOTA142',
    modelName: 'Nota 142 (Simulator)', name: 'Simulator Nota', draft: false, firmware: '1.2.4.0', protocolPort: 8082 }];

module.exports = { enabled, envOn, SimMezzoClient, SimPbusxClient, SimMezzo, SimNota, discoverMezzo, discoverPbusx, device };
