const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Aedes } = require('aedes');
const net = require('node:net');
const mqtt = require('mqtt');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ate(fn, limite = 10000) {
  const inicio = Date.now();
  while (Date.now() - inicio < limite) {
    try { const resultado = await fn(); if (resultado) return resultado; } catch {}
    await esperar(100);
  }
  throw new Error('Condicao nao atingida em ' + limite + ' ms');
}
async function portaLivre() {
  const servidor = net.createServer();
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  const porta = servidor.address().port;
  await new Promise(resolve => servidor.close(resolve));
  return porta;
}

test('MQTT -> SQLite -> API: falha, backlog antigo, recuperacao, duplicatas e payload invalido', { timeout: 30000 }, async t => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'monitoramento-'));
  const broker = await Aedes.createBroker();
  const tcp = net.createServer(broker.handle);
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const url = 'mqtt://127.0.0.1:' + tcp.address().port;
  const porta = await portaLivre();
  let logs = '';
  const backend = spawn(process.execPath, ['src/backend/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MQTT_URL: url, PORTA: String(porta), DB: path.join(pasta, 'teste.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', b => { logs += b; });
  backend.stderr.on('data', b => { logs += b; });
  const cliente = mqtt.connect(url, { clientId: 'teste-produtor', reconnectPeriod: 0 });
  const base = `http://127.0.0.1:${porta}`;
  const api = rota => fetch(base + rota).then(r => r.json());
  const publicar = msg => new Promise((resolve, reject) => cliente.publish('datacenter/sala01/rack01/telemetria', JSON.stringify(msg), { qos: 1 }, e => e ? reject(e) : resolve()));
  const amostra = (ts, seq) => ({ no: 'rack01', sala: 'sala01', ts: new Date(ts).toISOString(), seq, intervalo_s: 1, temp_c: 23, umid_pct: 45, corrente_a: 7, tensao_v: 220, potencia_w: 1540 });
  t.after(async () => {
    const encerrado = new Promise(resolve => backend.once('exit', resolve));
    backend.kill();
    await encerrado;
    await new Promise(resolve => cliente.end(true, resolve));
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => tcp.close(resolve));
    fs.rmSync(pasta, { recursive: true, force: true });
  });
  await ate(() => logs.includes('conectado ao broker'));
  await ate(async () => (await api('/api/status')).broker === 'conectado');
  await publicar(null);
  await publicar({ ts: 'invalido', seq: 1 });
  await publicar({ ...amostra(Date.now(), 1), sala: 'outra' });
  const primeira = amostra(Date.now() - 10000, 1);
  await publicar(primeira);
  await publicar(primeira);
  await ate(async () => (await api('/api/racks/rack01/leituras')).length === 1);
  const header = await fetch(base + '/api/racks');
  assert.equal(header.headers.get('cache-control'), 'no-store');
  assert.equal((await api('/api/racks'))[0].desatualizado, true);
  await ate(async () => (await api('/api/alertas')).some(a => a.tipo === 'comunicacao' && a.nivel === 'critico'));
  await publicar({ ...amostra(Date.now() - 6000, 2), reenvio: true });
  await ate(async () => (await api('/api/racks/rack01/leituras')).length === 2);
  assert.equal((await api('/api/racks'))[0].desatualizado, true);
  assert.equal((await api('/api/alertas')).filter(a => a.mensagem === 'Comunicação restabelecida').length, 0);
  await publicar(amostra(Date.now(), 3));
  await ate(async () => (await api('/api/racks'))[0].desatualizado === false);
  assert.equal((await api('/api/alertas')).filter(a => a.mensagem === 'Comunicação restabelecida').length, 1);
  await publicar(amostra(Date.now() - 20000, 4));
  await publicar(amostra(Date.now() + 120000, 5));
  await ate(async () => (await api('/api/racks/rack01/leituras')).length === 4);
  assert.equal((await api('/api/racks'))[0].ultima_leitura.seq, 3);
  assert.equal(backend.exitCode, null);
  assert.match(logs, /duplicada, ignorada/);
  assert.match(logs, /no futuro, descartada/);
});

test('simulador guarda leituras durante queda e reenvia com timestamp original', { timeout: 22000 }, async t => {
  const broker = await Aedes.createBroker();
  const tcp = net.createServer(broker.handle);
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const url = 'mqtt://127.0.0.1:' + tcp.address().port;
  const recebidas = [];
  broker.on('publish', (packet, cliente) => {
    if (cliente && packet.topic.endsWith('/telemetria')) recebidas.push({ recebido: Date.now(), ...JSON.parse(packet.payload) });
  });
  const simulador = spawn(process.execPath, ['src/simulador/esp32-sim.js', '--intervalo', '1', '--queda', '2,6'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, MQTT_URL: url }, stdio: 'ignore',
  });
  t.after(async () => {
    const encerrado = new Promise(resolve => simulador.once('exit', resolve));
    simulador.kill(); await encerrado;
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => tcp.close(resolve));
  });
  await ate(() => recebidas.some(r => r.reenvio), 16000);
  const antiga = recebidas.find(r => r.reenvio);
  assert.ok(antiga.recebido - Date.parse(antiga.ts) > 1000);
  await ate(() => recebidas.some(r => !r.reenvio && r.seq > antiga.seq));
  assert.equal(simulador.exitCode, null);
});
