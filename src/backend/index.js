// Servidor de aplicacao: assina os topicos no broker, grava as leituras,
// avalia os limiares, vigia o heartbeat dos nos e expoe uma API REST
// para o painel.
const path = require('node:path');
const mqtt = require('mqtt');
const express = require('express');
const config = require('../config');
const { sql } = require('./db');
const { avaliar } = require('./regras');

const estadoAlertas = new Map(); // "rack01:temperatura" -> nivel atual
const semComunicacao = new Set(); // nos que o watchdog ja marcou
const retroativos = new Map(); // no -> tipos ja registrados como retroativos no reenvio atual
const broker = { conectado: false, desde: Date.now() };

// ---------------- MQTT ----------------

const client = mqtt.connect(config.mqttUrl, {
  ...config.mqttOptions,
  clientId: 'backend-ingestao',
  // sessao persistente: se o backend cair, o broker guarda as mensagens QoS 1
  // e entrega quando ele voltar
  clean: false,
  reconnectPeriod: 3000,
});

client.on('connect', (connack) => {
  if (broker.jaConectou && !broker.conectado) log('comunicacao com o broker restabelecida');
  broker.conectado = true;
  broker.jaConectou = true;
  broker.desde = Date.now();
  log(`conectado ao broker (sessao anterior: ${connack.sessionPresent ? 'sim' : 'nao'})`);
  client.subscribe(['datacenter/+/+/telemetria', 'datacenter/+/+/status'], { qos: 1 });
});

client.on('offline', () => {
  if (broker.conectado) {
    broker.conectado = false;
    broker.desde = Date.now();
    log('comunicacao com o broker interrompida');
  }
  log('sem conexao com o broker, tentando de novo...');
});

client.on('error', (e) => log('erro mqtt:', e.message || e.code));

client.on('message', (topico, payload, packet) => {
  // datacenter/{sala}/{no}/{tipo}
  const partes = topico.split('/');
  if (partes.length !== 4) return log('topico fora do padrao, ignorado:', topico);
  const [, sala, no, tipo] = partes;
  if (sala !== config.sala || !/^[a-zA-Z0-9_-]{1,64}$/.test(no)) {
    return log('sala ou identificador fora do contrato, ignorado:', topico);
  }

  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    return log(`payload invalido em ${topico}`);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return log('payload deve ser um objeto:', topico);
  if (msg.sala && msg.sala !== sala) return log('sala do payload diferente do topico:', topico);

  if (msg.no && msg.no !== no) {
    return log(`no do payload (${msg.no}) diferente do topico (${no}), ignorado`);
  }

  if (tipo === 'telemetria') {
    const campos = ['temp_c', 'umid_pct', 'corrente_a', 'tensao_v', 'potencia_w'];
    if (!campos.every(c => typeof msg[c] === 'number' && Number.isFinite(msg[c])) ||
        !Number.isInteger(msg.seq) || msg.seq < 1 ||
        !Number.isFinite(msg.intervalo_s) || msg.intervalo_s <= 0 || msg.intervalo_s > 3600 ||
        msg.umid_pct < 0 || msg.umid_pct > 100 || msg.corrente_a < 0 || msg.tensao_v < 0 || msg.potencia_w < 0 ||
        typeof msg.ts !== 'string' || !Number.isFinite(Date.parse(msg.ts))) {
      return log(`[${no}] telemetria invalida, descartada`);
    }
    try { tratarLeitura(sala, no, msg); }
    catch (e) { log(`[${no}] falha ao persistir/processar leitura:`, e.message); }
  } else if (tipo === 'status' && ['online', 'offline'].includes(msg.estado)) {
    try { tratarStatus(no, msg, packet.retain); }
    catch (e) { log(`[${no}] falha ao persistir status:`, e.message); }
  }
});

function tratarLeitura(sala, no, msg) {
  const agora = Date.now();
  let ts = Date.parse(msg.ts);
  if (Number.isNaN(ts)) return log(`[${no}] leitura sem horario valido, descartada`);

  // Nao transformar uma medicao de horario desconhecido em dado atual.
  // Preservar o ts tambem mantem estavel a chave de deduplicacao (no, ts).
  if (ts > agora + 60000) {
    return log(`[${no}] horario da leitura mais de 60 s no futuro, descartada: ${msg.ts}`);
  }

  const leitura = { ...msg, ts };
  const res = sql.inserirLeitura.run(no, sala, msg.seq, ts, agora, msg.temp_c, msg.umid_pct, msg.corrente_a, msg.tensao_v, msg.potencia_w, msg.reenvio ? 1 : 0);
  if (res.changes === 0) {
    return log(`[${no}] #${msg.seq} duplicada, ignorada`);
  }

  const intervalo = msg.intervalo_s || 30;
  const atraso = (agora - ts) / 1000;
  const atrasada = atraso > intervalo * config.ciclosSemDado;

  const noAtual = sql.no.get(no);
  const maisNova = !noAtual || !noAtual.ultimo_ts || ts > noAtual.ultimo_ts;

  // so a leitura mais nova atualiza o "estado atual" do rack.
  // leitura velha (reenvio do buffer) vai pro historico e pronto.
  if (maisNova) {
    if (noAtual && noAtual.ultimo_seq && msg.seq > noAtual.ultimo_seq + 1) {
      log(`[${no}] faltaram ${msg.seq - noAtual.ultimo_seq - 1} leituras entre #${noAtual.ultimo_seq} e #${msg.seq}`);
    }
    sql.salvarNo.run(no, sala, intervalo, ts, msg.seq);
  }

  log(`[${no}] #${msg.seq} gravada T=${msg.temp_c} UR=${msg.umid_pct} I=${msg.corrente_a}` +
    (msg.reenvio ? ` (reenvio, atraso ${atraso.toFixed(0)} s)` : ''));

  const anterior = sql.leituraAnterior.get(no, ts - 120000);
  const ehAtual = maisNova && !atrasada;
  const resultado = avaliar(leitura, anterior, ehAtual ? niveisDoNo(no) : {});

  if (ehAtual) {
    atualizarAlertas(no, ts, resultado);
    retroativos.delete(no);
  } else {
    // leitura antiga que estourou limite: registra no historico mas nao
    // mexe no estado atual nem dispara notificacao. So guarda a primeira de
    // cada tipo, senao uma fila grande vira centenas de alertas iguais
    const jaRegistrados = retroativos.get(no) || new Set();
    for (const r of resultado) {
      if (r.nivel !== 'ok' && !jaRegistrados.has(r.tipo)) {
        jaRegistrados.add(r.tipo);
        sql.inserirAlerta.run(no, r.tipo, r.nivel, r.mensagem, ts, agora, 1);
        log(`[${no}] alerta retroativo (${new Date(ts).toLocaleTimeString('pt-BR')}): ${r.mensagem}`);
      }
    }
    retroativos.set(no, jaRegistrados);
  }

  // Reconectar e receber backlog nao comprova que a medicao voltou a ser atual.
  if (semComunicacao.has(no) && ehAtual) {
    semComunicacao.delete(no);
    registrarAlerta(no, 'comunicacao', 'info', 'Comunicação restabelecida', agora);
  }
}

function niveisDoNo(no) {
  const r = {};
  for (const [chave, nivel] of estadoAlertas) {
    const [n, tipo] = chave.split(':');
    if (n === no) r[tipo] = nivel;
  }
  return r;
}

function atualizarAlertas(no, ts, resultado) {
  for (const r of resultado) {
    const chave = `${no}:${r.tipo}`;
    const antes = estadoAlertas.get(chave) || 'ok';
    if (antes === r.nivel) continue; // so registra quando muda, senao vira spam

    estadoAlertas.set(chave, r.nivel);
    if (r.nivel === 'ok') {
      registrarAlerta(no, r.tipo, 'info', `${r.tipo} voltou ao normal`, ts);
    } else {
      registrarAlerta(no, r.tipo, r.nivel, r.mensagem, ts);
    }
  }
}

function tratarStatus(no, msg, retido) {
  const agora = Date.now();
  sql.statusNo.run(no, msg.estado, agora);
  // mensagem retida chega de novo toda vez que o backend reconecta,
  // nao e um evento novo
  if (retido) return log(`[${no}] status (retido): ${msg.estado}`);

  log(`[${no}] status: ${msg.estado}`);
  if (msg.estado === 'offline') {
    registrarAlerta(no, 'conexao', 'atencao', 'Nó perdeu a conexão com o broker (Last Will)', agora);
  } else if (msg.estado === 'online') {
    registrarAlerta(no, 'conexao', 'info', 'Nó conectado ao broker', agora);
  }
}

function registrarAlerta(no, tipo, nivel, mensagem, ts) {
  sql.inserirAlerta.run(no, tipo, nivel, mensagem, ts, Date.now(), 0);
  const marca = nivel === 'critico' ? '!!!' : nivel === 'atencao' ? '!' : '-';
  log(`ALERTA ${marca} [${no}] ${mensagem}`);
  // TODO: enviar para Telegram/e-mail na proxima etapa
}

// ---------------- Watchdog (heartbeat) ----------------

setInterval(() => {
  const agora = Date.now();
  for (const n of sql.nos.all()) {
    if (!n.ultimo_ts) continue;
    const limite = (n.intervalo_s || 30) * config.ciclosSemDado * 1000;
    if (agora - n.ultimo_ts > limite && !semComunicacao.has(n.no)) {
      semComunicacao.add(n.no);
      const seg = Math.round((agora - n.ultimo_ts) / 1000);
      registrarAlerta(n.no, 'comunicacao', 'critico', `Sem leituras há ${seg} s (${config.ciclosSemDado} ciclos)`, agora);
    }
  }
}, 5000);

// ---------------- API ----------------

const app = express();
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, '../../public')));

app.get('/api/status', (req, res) => {
  res.json({ broker: broker.conectado ? 'conectado' : 'desconectado', broker_desde: broker.desde, hora_servidor: Date.now() });
});

app.get('/api/racks', (req, res) => {
  const agora = Date.now();
  const lista = sql.nos.all().map((n) => {
    const ultima = sql.ultimaLeitura.get(n.no);
    const limite = (n.intervalo_s || 30) * config.ciclosSemDado;
    const idadeExata = n.ultimo_ts ? Math.max(0, (agora - n.ultimo_ts) / 1000) : null;
    const idade = idadeExata === null ? null : Math.floor(idadeExata);
    const alertas = [];
    for (const [chave, nivel] of estadoAlertas) {
      if (chave.startsWith(n.no + ':') && nivel !== 'ok') alertas.push({ tipo: chave.split(':')[1], nivel });
    }
    return {
      no: n.no,
      sala: n.sala,
      intervalo_s: n.intervalo_s,
      status_mqtt: n.status_mqtt,
      ultima_leitura: ultima,
      idade_s: idade,
      // a idade e calculada aqui no servidor, nao no navegador, para nao
      // depender do relogio da maquina de quem esta olhando
      desatualizado: idadeExata === null || idadeExata > limite,
      limite_s: limite,
      alertas,
    };
  });
  res.json(lista);
});

app.get('/api/racks/:no/leituras', (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 50, 1000);
  res.json(sql.leituras.all(req.params.no, limite));
});

app.get('/api/alertas', (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 30, 500);
  res.json(sql.alertas.all(limite));
});

app.listen(config.porta, () => log(`API e painel em http://localhost:${config.porta}`));

function log(...msg) {
  console.log(new Date().toLocaleTimeString('pt-BR'), '[backend]', ...msg);
}
