'use strict';
const { MezzoClient, DEFAULT_PORT } = require('../lib/mezzo-client');
const map = require('../lib/mezzo-map');
const { discover, probe } = require('../lib/mezzo-discover');
const values = require('../lib/mezzo-values');

const readOps = (defs) => defs.map(([, addr, size]) => ({ op: 'R', addr, size }));

// Fields that change continuously; ignored for "on change" detection.
function stableView(st) {
    const { supply, channelTemp, timestamp, ...rest } = st; // eslint-disable-line no-unused-vars
    return JSON.stringify(rest);
}

module.exports = function (RED) {

    // ===================================================================== editor admin API
    // Used by the mezzo-amp config dialog: device dropdown (discovery) and connection test.
    RED.httpAdmin.get('/mezzo/discover', RED.auth.needsPermission('mezzo-amp.read'), async (req, res) => {
        try {
            res.json(await discover({ timeout: Math.min(Number(req.query.timeout) || 1500, 5000) }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    RED.httpAdmin.get('/mezzo/probe', RED.auth.needsPermission('mezzo-amp.read'), async (req, res) => {
        const host = String(req.query.host || '').trim();
        if (!/^[a-zA-Z0-9.\-]+$/.test(host)) return res.status(400).json({ error: 'invalid host' });
        try {
            res.json(await probe(host, { port: Number(req.query.port) || DEFAULT_PORT }));
        } catch (e) { res.status(404).json({ error: e.message }); }
    });

    // ===================================================================== config node
    function MezzoAmpNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name;
        node.host = (config.host || '').trim();
        node.port = Number(config.port) || DEFAULT_PORT;
        node.pollInterval = Math.max(0.2, Number(config.pollInterval) || 2) * 1000;
        node.meterInterval = Number(config.meterInterval) > 0 ? Math.max(0.1, Number(config.meterInterval)) * 1000 : 0;
        node.timeout = Number(config.timeout) || 1000;
        node.serial = (config.serial || '').trim();   // expected device (from dropdown), optional
        node.model = config.model || '';

        node.client = new MezzoClient({ host: node.host, port: node.port, timeout: node.timeout, retries: 2 });
        node.client.on('error', (e) => node.warn(`socket: ${e.message}`));
        node.client.on('warn', (m) => node.debug(m));

        node.connected = false;
        node.info = null;
        node.status = null;
        node.meters = null;
        node.lastError = null;
        node.users = 0;
        let pollTimer = null, meterTimer = null, stopped = false, polling = false;

        function setConnected(ok, err) {
            if (ok !== node.connected) {
                node.connected = ok;
                if (!ok) node.info = null;
                node.emit('connection', { connected: ok, error: err ? err.message : undefined });
                if (ok) node.log(`connected to Mezzo ${node.host}`);
                else node.warn(`lost connection to Mezzo ${node.host}: ${err ? err.message : ''}`);
            }
            node.lastError = err ? err.message : null;
        }

        node.pollStatus = async function () {
            if (polling) return node.status;
            polling = true;
            try {
                if (!node.info) {
                    node.info = map.decodeInfo(await node.client.read(map.A.INFO, 0x7a));
                    if (node.serial && node.info.serial !== node.serial) {
                        node.warn(`device at ${node.host} has serial ${node.info.serial}, expected ${node.serial} (${node.model}). IP changed?`);
                    }
                }
                const replies = await node.client.transact(readOps(map.STATUS_READS));
                const st = map.decodeStatus(map.toBlocks(map.STATUS_READS, replies));
                st.info = node.info;
                st.timestamp = new Date().toISOString();
                const changed = !node.status || stableView(node.status) !== stableView(st);
                node.status = st;
                setConnected(true);
                node.emit('status', st, changed);
                return st;
            } catch (e) {
                setConnected(false, e);
                throw e;
            } finally {
                polling = false;
            }
        };

        node.pollMeters = async function () {
            const replies = await node.client.transact(readOps(map.METER_READS));
            const m = map.decodeMeters(map.toBlocks(map.METER_READS, replies));
            m.timestamp = new Date().toISOString();
            node.meters = m;
            node.emit('meters', m);
            return m;
        };

        /** Execute a control command, then refresh status. */
        // Relative gain steps (volume +/-) are chained so fast repeated presses each
        // read the value written by the previous one.
        let stepChain = Promise.resolve();
        async function doStep(cmd, st) {
            const base = map.STEP_BLOCKS[st.block];
            const current = await node.client.read(base, 16);
            const changes = map.applyStep(current, map.channels(cmd.channel), st.step, cmd.min, cmd.max);
            const ops = changes.filter(c => c.toDb !== c.fromDb).map(c => {
                const data = Buffer.alloc(4); data.writeFloatLE(c.lin, 0);
                return { op: 'W', addr: base + 4 * (c.channel - 1), data };
            });
            if (ops.length) {
                const replies = await node.client.transact(ops);
                if (replies.some(r => r.nak)) throw new Error('device rejected gain write (NAK)');
                setTimeout(() => node.pollStatus().catch(() => {}), 150);
            }
            return changes.map(({ channel, fromDb, toDb }) => ({ channel, fromDb, toDb, atLimit: fromDb === toDb }));
        }

        node.command = async function (cmd) {
            const st = map.stepCommand(cmd);
            if (st) {
                const run = stepChain.then(() => doStep(cmd, st));
                stepChain = run.catch(() => {});
                return run;
            }
            const ops = map.encodeCommand(cmd);
            const replies = await node.client.transact(ops);
            const nak = replies.filter(r => r.nak);
            if (nak.length) throw new Error(`device rejected write (NAK) at ${nak.map(r => '0x' + r.addr.toString(16)).join(', ')}`);
            setTimeout(() => node.pollStatus().catch(() => {}), 150);
            return replies;
        };

        node.rawRead = async function (addr, size) { return node.client.read(addr, size); };

        function loopStatus() {
            if (stopped) return;
            node.pollStatus().catch(() => {}).finally(() => {
                if (!stopped) pollTimer = setTimeout(loopStatus, node.pollInterval);
            });
        }
        function loopMeters() {
            if (stopped || !node.meterInterval) return;
            const run = node.connected ? node.pollMeters().catch(() => {}) : Promise.resolve();
            run.finally(() => { if (!stopped) meterTimer = setTimeout(loopMeters, node.meterInterval); });
        }

        if (node.host) {
            loopStatus();
            if (node.meterInterval) meterTimer = setTimeout(loopMeters, node.meterInterval);
        } else {
            node.error('no host configured');
        }

        node.on('close', function (done) {
            stopped = true;
            clearTimeout(pollTimer);
            clearTimeout(meterTimer);
            node.client.close();
            done();
        });
    }
    RED.nodes.registerType('mezzo-amp', MezzoAmpNode);

    // ===================================================================== helpers
    function bindStatusIndicator(node, amp) {
        const update = () => {
            if (!amp.connected) return node.status({ fill: 'red', shape: 'ring', text: amp.lastError || 'disconnected' });
            const st = amp.status || {};
            if (st.alarms && st.alarms.any) return node.status({ fill: 'yellow', shape: 'dot', text: `alarm: ${st.alarms.fault}` });
            node.status({ fill: st.standby ? 'grey' : 'green', shape: 'dot', text: st.standby ? 'standby' : 'on' });
        };
        const onConn = () => update();
        const onStatus = () => update();
        amp.on('connection', onConn);
        amp.on('status', onStatus);
        node.status({ fill: 'grey', shape: 'ring', text: 'connecting' });
        node.on('close', () => { amp.removeListener('connection', onConn); amp.removeListener('status', onStatus); });
        return update;
    }

    // ===================================================================== status node
    function MezzoStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const amp = RED.nodes.getNode(config.amp);
        if (!amp) { node.status({ fill: 'red', shape: 'ring', text: 'no amp configured' }); return; }
        const mode = config.mode || 'change'; // change | always | manual
        const meters = !!config.meters;
        bindStatusIndicator(node, amp);

        const send = (topic, payload) => node.send({ topic, payload, amp: amp.name || amp.host });

        const onStatus = (st, changed) => {
            if (mode === 'always' || (mode === 'change' && changed)) send('status', st);
        };
        const onMeters = (m) => { if (meters) send('meters', m); };
        const onConn = (c) => { if (mode !== 'manual') send('connection', c); };
        amp.on('status', onStatus);
        amp.on('meters', onMeters);
        amp.on('connection', onConn);

        node.on('input', async (msg, sendFn, done) => {
            try {
                const what = String(msg.topic || '').toLowerCase();
                if (what === 'meters') msg.payload = await amp.pollMeters();
                else if (what === 'read' && msg.payload && msg.payload.address !== undefined) {
                    const d = await amp.rawRead(Number(msg.payload.address), Number(msg.payload.size || 4));
                    msg.payload = { address: Number(msg.payload.address), data: d, hex: d.toString('hex') };
                } else { msg.payload = await amp.pollStatus(); msg.topic = 'status'; }
                sendFn(msg);
                done();
            } catch (e) { done(e); }
        });

        node.on('close', () => {
            amp.removeListener('status', onStatus);
            amp.removeListener('meters', onMeters);
            amp.removeListener('connection', onConn);
        });
    }
    RED.nodes.registerType('mezzo-status', MezzoStatusNode);

    // ===================================================================== control node
    function MezzoControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const amp = RED.nodes.getNode(config.amp);
        if (!amp) { node.status({ fill: 'red', shape: 'ring', text: 'no amp configured' }); return; }
        bindStatusIndicator(node, amp);

        const pick = (msgVal, cfgVal) => (msgVal !== undefined && msgVal !== '' ? msgVal : (cfgVal !== '' ? cfgVal : undefined));

        node.on('input', async (msg, send, done) => {
            const fixed = config.command && config.command !== 'msg';
            const cmd = {
                command: fixed ? config.command : (msg.command || msg.topic),
                value: msg.payload,
                channel: pick(msg.channel, config.channel),
                source: pick(msg.source, config.source),
                output: pick(msg.output, config.output),
                step: pick(msg.step, config.step),
                min: pick(msg.min, config.min),
                max: pick(msg.max, config.max),
                block: pick(msg.block, config.block),
            };
            // payload may also be an object {command,value,channel,...}
            if (msg.payload && typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload) && msg.payload.command) {
                Object.assign(cmd, msg.payload);
            }
            try {
                if (!cmd.command) throw new Error('no command (configure one or set msg.topic)');
                const r = await amp.command(cmd);
                msg.result = { ok: true, ...cmd };
                if (map.stepCommand(cmd)) {
                    msg.result.changes = r;   // [{channel, fromDb, toDb, atLimit}]
                    node.status({ fill: 'blue', shape: 'dot',
                        text: r.map(c => `CH${c.channel} ${c.toDb === null ? '-∞' : c.toDb} dB${c.atLimit ? ' (Limit)' : ''}`).join(' | ') });
                }
                send(msg);
                done();
            } catch (e) {
                msg.result = { ok: false, error: e.message, ...cmd };
                node.status({ fill: 'red', shape: 'dot', text: e.message.slice(0, 40) });
                done(e);
            }
        });
    }
    RED.nodes.registerType('mezzo-control', MezzoControlNode);

    // ===================================================================== value node
    // One value (e.g. User Gain CH2, input level CH1) – outputs it when it changes and writes
    // msg.payload back to the device. Meant to sit right next to one dashboard widget:
    //   widget output -> mezzo-value -> widget input
    RED.httpAdmin.get('/mezzo/values', RED.auth.needsPermission('mezzo-amp.read'), (req, res) => res.json(values.catalog()));

    function MezzoValueNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const amp = RED.nodes.getNode(config.amp);
        const def = values.BY_KEY[config.value];
        if (!amp) { node.status({ fill: 'red', shape: 'ring', text: 'no amp configured' }); return; }
        if (!def) { node.status({ fill: 'red', shape: 'ring', text: 'no value selected' }); return; }
        amp.setMaxListeners(0);   // one listener per value node – dashboards use many

        const opts = { channel: config.channel, source: config.source, output: config.output, floor: config.floor,
            min: config.min === '' || config.min === undefined ? -60 : Number(config.min),
            max: config.max === '' || config.max === undefined ? 15 : Number(config.max) };
        const asText = config.format === 'text';
        const where = def.scope === 'ch' ? ` CH${opts.channel || 1}`
            : def.scope === 'mx' ? ` ${opts.source || 1}→${'ABCD'[(Number(opts.output) || 1) - 1]}` : '';
        const topic = config.topic || def.key + (def.scope === 'ch' ? ':' + (opts.channel || 1)
            : def.scope === 'mx' ? `:${opts.source || 1}:${opts.output || 1}` : '');
        let last;           // JSON of the last sent value
        let force = false;  // send next value even if unchanged (after a write, e.g. clamped input)

        const emit = (obj, always) => {
            let v;
            try { v = values.extract(def, obj, opts); } catch (e) { return; }
            if (v === undefined) return;
            const k = JSON.stringify(v);
            if (k === last && !always && !force) return;
            last = k; force = false;
            const txt = values.format(def, v);
            node.status({ fill: amp.connected ? 'green' : 'red', shape: amp.connected ? 'dot' : 'ring', text: txt + where });
            node.send({ topic, payload: asText ? txt : v, value: v, text: txt, unit: def.unit || (def.type === 'db' ? 'dB' : '') });
        };
        const onData = (obj) => emit(obj);
        const onConn = (c) => { if (!c.connected) node.status({ fill: 'red', shape: 'ring', text: 'disconnected' }); };
        amp.on(def.src, onData);
        amp.on('connection', onConn);
        node.status({ fill: 'grey', shape: 'ring', text: 'warte auf Daten' });
        // already have data (redeploy of this node only)
        const current = def.src === 'meters' ? amp.meters : amp.status;
        if (current) setImmediate(() => emit(current));

        node.on('input', async (msg, send, done) => {
            const cur = () => (def.src === 'meters' ? amp.meters : amp.status);
            if (msg.topic === 'refresh' || msg.payload === undefined) {
                if (cur()) emit(cur(), true);
                return done();
            }
            try {
                const cmd = values.writeCommand(def, msg.payload, opts);
                if (!cmd) return done();
                force = true;   // always report the real device value back (clamped / rejected input)
                await amp.command(cmd);
                done();
            } catch (e) {
                force = false;
                if (cur()) emit(cur(), true);   // reset the widget to the device value
                node.status({ fill: 'red', shape: 'dot', text: e.message.slice(0, 40) });
                done(e);
            }
        });

        node.on('close', () => {
            amp.removeListener(def.src, onData);
            amp.removeListener('connection', onConn);
        });
    }
    RED.nodes.registerType('mezzo-value', MezzoValueNode);
};
