// Simulador do no ESP32 de um rack.
// O projeto nao tem montagem fisica, entao este processo faz o papel do no:
// gera as leituras dos "sensores", monta o JSON e publica no broker. Se a
// conexao cair, guarda as leituras num buffer e reenvia quando voltar.
//
// uso: node src/simulador/esp32-sim.js --rack rack01 [--intervalo 30] [--temp 23] [--cenario normal|falha-ar|sobrecarga]
//      [--queda 60,90]  -> derruba o "wifi" aos 60 s por 90 s (para testar falha)
//
// Quando roda pelo `npm run dev`, as falhas tambem podem ser ligadas e
// desligadas pelo teclado (o dev.js manda mensagens pelo canal IPC).

const mqtt = require('mqtt');
const config = require('../config');

const args = lerArgs(process.argv.slice(2));
const rack = args.rack || 'rack01';
const intervalo = Number(args.intervalo || 30);
const tempBase = Number(args.temp || 23);
const sala = config.sala;

const base = `datacenter/${sala}/${rack}`;
const TAM_BUFFER = 120; // 1 hora de leituras com intervalo de 30 s

let seq = 0;
let buffer = [];
let wifiOk = true;

// falhas simuladas, podem mudar com o programa rodando
const falha = {
  ar: args.cenario === 'falha-ar', // ar-condicionado parado
  sobrecarga: args.cenario === 'sobrecarga',
};
let tempExtra = 0;
let correnteExtra = 0;
let ultimaLeitura = Date.now();

const client = mqtt.connect(config.mqttUrl, {
  ...config.mqttOptions,
  clientId: `esp32-${sala}-${rack}`,
  keepalive: 15,
  reconnectPeriod: 3000,
  // se o no cair sem avisar o broker publica isso sozinho (Last Will)
  will: {
    topic: `${base}/status`,
    payload: JSON.stringify({ no: rack, estado: 'offline' }),
    qos: 1,
    retain: true,
  },
});

let iniciado = false;

client.on('connect', () => {
  log('conectado ao broker');
  client.publish(`${base}/status`, JSON.stringify({ no: rack, estado: 'online', ts: new Date().toISOString() }), { qos: 1, retain: true });
  esvaziarBuffer();

  // so comeca a medir depois de conectar a primeira vez. Num ESP32 esse
  // seria o momento de acertar o relogio pelo NTP
  if (!iniciado) {
    iniciado = true;
    setInterval(ciclo, intervalo * 1000);
    ciclo();
  }
});

client.on('offline', () => log('sem conexao com o broker'));
client.on('error', (e) => log('erro mqtt:', e.message || e.code));

if (args.queda) {
  const [em, dur] = args.queda.split(',').map(Number);
  setTimeout(() => {
    derrubarWifi();
    setTimeout(religarWifi, dur * 1000);
  }, em * 1000);
}

// comandos vindos do dev.js
if (process.send) {
  process.on('message', (cmd) => {
    if (cmd === 'wifi') wifiOk ? derrubarWifi() : religarWifi();
    if (cmd === 'ar') {
      falha.ar = !falha.ar;
      log(falha.ar ? '>>> ar-condicionado PAROU' : '>>> ar-condicionado voltou a funcionar');
    }
    if (cmd === 'sobrecarga') {
      falha.sobrecarga = !falha.sobrecarga;
      log(falha.sobrecarga ? '>>> carga do rack aumentando (sobrecarga)' : '>>> carga do rack voltou ao normal');
    }
  });
}

function derrubarWifi() {
  if (!wifiOk) return;
  log('>>> wifi CAIU');
  wifiOk = false;
  client.end(true); // fecha sem DISCONNECT, entao o broker dispara o LWT
}

function religarWifi() {
  if (wifiOk) return;
  log('>>> wifi voltou');
  wifiOk = true;
  client.reconnect();
}

function ciclo() {
  const leitura = lerSensores();

  if (wifiOk && client.connected) {
    publicar(leitura);
  } else {
    buffer.push(leitura);
    if (buffer.length > TAM_BUFFER) buffer.shift(); // descarta a mais antiga
    log(`#${leitura.seq} guardada no buffer (${buffer.length} pendentes)`);
  }
}

function esvaziarBuffer() {
  if (!buffer.length) return;
  log(`reenviando ${buffer.length} leituras do buffer`);
  const pendentes = buffer;
  buffer = [];
  // manda na ordem em que foram lidas, marcando como reenvio
  for (const l of pendentes) publicar({ ...l, reenvio: true });
}

function publicar(leitura) {
  client.publish(`${base}/telemetria`, JSON.stringify(leitura), { qos: 1 }, (err) => {
    if (err) {
      buffer.push(leitura);
      return log(`falha ao publicar #${leitura.seq}, voltou pro buffer`);
    }
    log(`#${leitura.seq} enviada ${leitura.reenvio ? '(reenvio) ' : ''}T=${leitura.temp_c}°C UR=${leitura.umid_pct}% I=${leitura.corrente_a}A`);
  });
}

function lerSensores() {
  const agora = Date.now();
  const dtMin = (agora - ultimaLeitura) / 60000;
  ultimaLeitura = agora;

  // ar parado: sobe ~0,8 °C/min. Quando volta, esfria ~1,5 °C/min ate a base
  if (falha.ar) tempExtra = Math.min(tempExtra + 0.8 * dtMin, 20);
  else tempExtra = Math.max(tempExtra - 1.5 * dtMin, 0);

  // sobrecarga: corrente sobe ~1,2 A/min; desligou a carga, volta na hora
  if (falha.sobrecarga) correnteExtra = Math.min(correnteExtra + 1.2 * dtMin, 10);
  else correnteExtra = 0;

  const temp = tempBase + tempExtra + ruido(0.15);
  const corrente = 7.5 + correnteExtra + ruido(0.4);

  const tensao = 220 + ruido(2);
  seq++;
  return {
    no: rack,
    sala,
    seq,
    ts: new Date().toISOString(), // hora do no (relogio do computador, sincronizado por NTP)
    intervalo_s: intervalo,
    temp_c: arred(temp),
    umid_pct: arred(45 + ruido(2)),
    corrente_a: arred(corrente),
    tensao_v: arred(tensao),
    potencia_w: Math.round(tensao * corrente),
  };
}

function ruido(amp) {
  return (Math.random() * 2 - 1) * amp;
}

function arred(v) {
  return Math.round(v * 10) / 10;
}

function log(...msg) {
  console.log(new Date().toLocaleTimeString('pt-BR'), `[${rack}]`, ...msg);
}

function lerArgs(lista) {
  const r = {};
  for (let i = 0; i < lista.length; i++) {
    if (lista[i].startsWith('--')) r[lista[i].slice(2)] = lista[i + 1];
  }
  return r;
}
