'use strict';
/**
 * Node-RED nodes for Powersoft PBusX devices: Nota 142 (verified) and DC Rider (from the official spec 1.0.3, untested).
 * Protocol and address map: docs/PBUSX.md.
 */
const { PbusxClient, DEFAULT_PORT } = require('../lib/pbusx-client');
const map = require('../lib/pbusx-map');
const { discover, probe, blink } = require('../lib/pbusx-discover');
const values = require('../lib/pbusx-values');

const readOps = (defs) => defs.map(([, addr, size]) => ({ op: 'R', addr, size }));

// Fields that change continuously; ignored for "on change" detection.
function stableView(st) {
    const { supply, timestamp, ...rest } = st; // eslint-disable-line no-unused-vars
    return JSON.stringify(rest);
}

module.exports = function (RED) {

    // ===================================================================== editor admin API
    RED.httpAdmin.get('/pbusx/discover', RED.auth.needsPermission('pbusx-amp.read'), async (req, res) => {
        try {
            res.json(await discover({ timeout: Math.min(Number(req.query.timeout) || 1500, 5000) }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    RED.httpAdmin.get('/pbusx/probe', RED.auth.needsPermission('pbusx-amp.read'), async (req, res) => {
        const host = String(req.query.host || '').trim();
        if (!/^[a-zA-Z0-9.\-]+$/.test(host)) return res.status(400).json({ error: 'invalid host' });
        try {
            res.json(await probe(host, { port: Number(req.query.port) || DEFAULT_PORT }));
        } catch (e) { res.status(404).json({ error: e.message }); }
    });
    RED.httpAdmin.get('/pbusx/values', RED.auth.needsPermission('pbusx-amp.read'), (req, res) => res.json(values.catalog()));
    RED.httpAdmin.get('/pbusx/models', RED.auth.needsPermission('pbusx-amp.read'), (req, res) =>
        res.json(map.MODELS.map(({ id, name, family, inputs, outputs, verified }) => ({ id, name, family, inputs, outputs, verified }))));

    // ===================================================================== config node
    function PbusxAmpNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name;
        node.host = (config.host || '').trim();
        node.port = Number(config.port) || DEFAULT_PORT;
        node.modelSel = config.model || 'auto';       // 'auto' or a model id from map.MODELS
        node.mac = (config.mac || '').trim();
        node.pollInterval = Math.max(0.2, Number(config.pollInterval) || 2) * 1000;
        node.meterInterval = Number(config.meterInterval) > 0 ? Math.max(0.1, Number(config.meterInterval)) * 1000 : 0;
        node.timeout = Number(config.timeout) || 1000;
        node.serial = (config.serial || '').trim();

        node.client = new PbusxClient({ host: node.host, port: node.port, timeout: node.timeout, retries: 2 });
        node.client.on('error', (e) => node.warn(`socket: ${e.message}`));
        node.client.on('warn', (m) => node.debug(m));

        node.connected = false;
        node.info = null;       // {model, serial, modelName, family, draft}
        node.layout = null;     // {inputs, outputs, family}
        node.status = null;
        node.meters = null;
        node.lastError = null;
        let pollTimer = null, meterTimer = null, stopped = false, polling = false;
        let statusDefs = null, meterDefs = null;

        function setConnected(ok, err) {
            if (ok !== node.connected) {
                node.connected = ok;
                if (!ok) { node.info = null; node.layout = null; }
                node.emit('connection', { connected: ok, error: err ? err.message : undefined });
                if (ok) node.log(`connected to ${node.info ? node.info.modelName : 'PBusX device'} ${node.host}`);
                else node.warn(`lost connection to ${node.host}: ${err ? err.message : ''}`);
            }
            node.lastError = err ? err.message : null;
        }

        /** Read model/serial and determine the channel layout (once per connection). */
        async function init() {
            const info = map.decodeInfo(await node.client.read(map.A.INFO, map.INFO_SIZE));
            const byDevice = map.modelById(info.model);
            const chosen = node.modelSel !== 'auto' ? map.modelById(node.modelSel) : byDevice;
            const detected = map.layoutFromProbe(await node.client.transactMany(map.LAYOUT_PROBE.map(({ op, addr, size }) => ({ op, addr, size }))));
            let layout = detected;
            if (!detected.inputs || !detected.outputs) {
                if (!chosen) throw new Error(`unknown model "${info.model}" and channel detection failed`);
                layout = { inputs: chosen.inputs, outputs: chosen.outputs };
                node.warn(`channel detection failed, using ${chosen.name} defaults ${layout.inputs}×${layout.outputs}`);
            } else if (chosen && (chosen.inputs !== detected.inputs || chosen.outputs !== detected.outputs)) {
                node.warn(`${chosen.name}: expected ${chosen.inputs} inputs / ${chosen.outputs} channels, device reports ` +
                    `${detected.inputs} / ${detected.outputs} – using the detected layout`);
            }
            const model = chosen || byDevice;
            layout = { ...layout, family: model ? model.family : 'nota' };
            node.info = { ...info, modelName: model ? model.name : info.model, family: layout.family, draft: model ? !model.verified : true };
            if (node.info.draft) {
                node.warn(`${node.info.modelName}: address map from the DC Rider spec 1.0.3 / extrapolated, not yet verified on a device`);
            }
            if (node.serial && info.serial !== node.serial) {
                node.warn(`device at ${node.host} has serial ${info.serial}, expected ${node.serial}. IP changed?`);
            }
            node.layout = layout;
            statusDefs = map.statusReads(layout);
            meterDefs = map.meterReads(layout);
        }

        node.pollStatus = async function () {
            if (polling) return node.status;
            polling = true;
            try {
                if (!node.layout) await init();
                const replies = await node.client.transactMany(readOps(statusDefs));
                const st = map.decodeStatus(map.toBlocks(statusDefs, replies), node.layout);
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
            if (!node.layout) throw new Error('not connected');
            const replies = await node.client.transactMany(readOps(meterDefs));
            const m = map.decodeMeters(map.toBlocks(meterDefs, replies), node.layout);
            m.timestamp = new Date().toISOString();
            node.meters = m;
            node.emit('meters', m);
            return m;
        };

        let stepChain = Promise.resolve();
        async function doStep(cmd, st) {
            const chans = map.channels(cmd.channel, node.layout.outputs);
            const addrs = chans.map((k) => map.stepAddr(st.block, k));
            const replies = await node.client.transact(addrs.map((addr) => ({ op: 'R', addr, size: 4 })));
            if (replies.some((r) => r.nak)) throw new Error('device rejected gain read (NAK)');
            const current = Buffer.concat(replies.map((r) => r.data));
            const changes = map.applyStep(current, chans.map((_, i) => i), st.step, cmd.min, cmd.max)
                .map((c, i) => ({ ...c, channel: chans[i] + 1, addr: addrs[i] }));
            const ops = changes.filter((c) => c.toDb !== c.fromDb).map((c) => {
                const data = Buffer.alloc(4); data.writeFloatLE(c.lin, 0);
                return { op: 'W', addr: c.addr, data };
            });
            if (ops.length) {
                const w = await node.client.transact(ops);
                if (w.some((r) => r.nak)) throw new Error('device rejected gain write (NAK)');
                setTimeout(() => node.pollStatus().catch(() => {}), 150);
            }
            return changes.map(({ channel, fromDb, toDb }) => ({ channel, fromDb, toDb, atLimit: fromDb === toDb }));
        }

        node.command = async function (cmd) {
            const c = String(cmd.command || '').toLowerCase();
            if (c === 'blink' || c === 'identify') {
                const on = cmd.value === undefined || cmd.value === null || cmd.value === '' ? true : map.toBool(cmd.value);
                if (!node.layout && !node.mac) await node.pollStatus();
                const op = node.layout ? map.blinkOp(node.layout, on) : null;
                if (op) { // DC Rider: blink register via PBusX (10 s), no MAC needed
                    const [r] = await node.client.transact([op]);
                    if (r.nak) throw new Error('device rejected blink (NAK)');
                    return { on, via: 'pbusx' };
                }
                return blink(node.mac, on);
            }
            if (!node.layout) await node.pollStatus();
            const st = map.stepCommand(cmd);
            if (st) {
                const run = stepChain.then(() => doStep(cmd, st));
                stepChain = run.catch(() => {});
                return run;
            }
            const ops = map.encodeCommand(cmd, node.layout);
            const replies = await node.client.transact(ops);
            const nak = replies.filter((r) => r.nak);
            if (nak.length) throw new Error(`device rejected write (NAK) at ${nak.map((r) => '0x' + r.addr.toString(16)).join(', ')}`);
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
    RED.nodes.registerType('pbusx-amp', PbusxAmpNode);

    // ===================================================================== helpers
    function bindStatusIndicator(node, amp) {
        const update = () => {
            if (!amp.connected) return node.status({ fill: 'red', shape: 'ring', text: amp.lastError || 'disconnected' });
            const st = amp.status || {};
            const draft = amp.info && amp.info.draft ? ' (Entwurf)' : '';
            if (st.alarms && st.alarms.any) {
                const a = st.alarms, flags = [...((a.machine && a.machine.flags) || []),
                    ...(a.output || []).flatMap((o, i) => (o && o.raw ? o.flags.map((x) => `CH${i + 1} ${x}`) : []))];
                return node.status({ fill: 'yellow', shape: 'dot', text: (flags.length ? flags.join(', ') : `Status ${st.state}/${st.statusCode}`).slice(0, 60) + draft });
            }
            if (st.standby) return node.status({ fill: 'grey', shape: 'dot', text: `Standby${draft}` });
            node.status({ fill: 'green', shape: 'dot', text: `ok${draft}` });
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
    function PbusxStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const amp = RED.nodes.getNode(config.amp);
        if (!amp) { node.status({ fill: 'red', shape: 'ring', text: 'no amp configured' }); return; }
        const mode = config.mode || 'change';
        const meters = !!config.meters;
        bindStatusIndicator(node, amp);

        const send = (topic, payload) => node.send({ topic, payload, amp: amp.name || amp.host });
        const onStatus = (st, changed) => { if (mode === 'always' || (mode === 'change' && changed)) send('status', st); };
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
    RED.nodes.registerType('pbusx-status', PbusxStatusNode);

    // ===================================================================== control node
    function PbusxControlNode(config) {
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
            if (msg.payload && typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload) && msg.payload.command) {
                Object.assign(cmd, msg.payload);
            }
            try {
                if (!cmd.command) throw new Error('no command (configure one or set msg.topic)');
                const r = await amp.command(cmd);
                msg.result = { ok: true, ...cmd };
                if (map.stepCommand(cmd)) {
                    msg.result.changes = r;
                    node.status({ fill: 'blue', shape: 'dot',
                        text: r.map((c) => `CH${c.channel} ${c.toDb === null ? '-∞' : c.toDb} dB${c.atLimit ? ' (Limit)' : ''}`).join(' | ') });
                } else if (/^(blink|identify)$/i.test(cmd.command)) {
                    msg.result.blink = r;
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
    RED.nodes.registerType('pbusx-control', PbusxControlNode);

    // ===================================================================== value node
    function PbusxValueNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const amp = RED.nodes.getNode(config.amp);
        const def = values.BY_KEY[config.value];
        if (!amp) { node.status({ fill: 'red', shape: 'ring', text: 'no amp configured' }); return; }
        if (!def) { node.status({ fill: 'red', shape: 'ring', text: 'no value selected' }); return; }
        amp.setMaxListeners(0);

        const opts = { channel: config.channel, source: config.source, output: config.output, floor: config.floor,
            min: config.min === '' || config.min === undefined ? -60 : Number(config.min),
            max: config.max === '' || config.max === undefined ? 15 : Number(config.max) };
        const asText = config.format === 'text';
        const where = def.scope === 'ch' ? ` CH${opts.channel || 1}`
            : def.scope === 'mx' ? ` IN${opts.source || 1}→${opts.output || 1}` : '';
        const topic = config.topic || def.key + (def.scope === 'ch' ? ':' + (opts.channel || 1)
            : def.scope === 'mx' ? `:${opts.source || 1}:${opts.output || 1}` : '');
        let last, force = false;

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
                force = true;
                await amp.command(cmd);
                done();
            } catch (e) {
                force = false;
                if (cur()) emit(cur(), true);
                node.status({ fill: 'red', shape: 'dot', text: e.message.slice(0, 40) });
                done(e);
            }
        });

        node.on('close', () => {
            amp.removeListener(def.src, onData);
            amp.removeListener('connection', onConn);
        });
    }
    RED.nodes.registerType('pbusx-value', PbusxValueNode);
};
