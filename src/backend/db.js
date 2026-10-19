// Banco local em SQLite (modulo nativo do Node 22).
// Nessa etapa serve no lugar do banco de series temporais (InfluxDB/Timescale)
// que esta na arquitetura, o modelo das tabelas ja pensa nisso.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.arquivoBanco), { recursive: true });
const db = new DatabaseSync(config.arquivoBanco);

db.exec(`
  CREATE TABLE IF NOT EXISTS leituras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    no TEXT NOT NULL,
    sala TEXT NOT NULL,
    seq INTEGER,
    ts INTEGER NOT NULL,          -- hora da medicao (ms, UTC), vem do no
    recebido_em INTEGER NOT NULL, -- hora que o backend recebeu
    temp_c REAL, umid_pct REAL, corrente_a REAL, tensao_v REAL, potencia_w REAL,
    reenvio INTEGER DEFAULT 0,
    UNIQUE (no, ts)               -- evita gravar duas vezes a mesma leitura
  );

  CREATE TABLE IF NOT EXISTS nos (
    no TEXT PRIMARY KEY,
    sala TEXT,
    intervalo_s INTEGER,
    ultimo_ts INTEGER,
    ultimo_seq INTEGER,
    status_mqtt TEXT,
    status_em INTEGER
  );

  CREATE TABLE IF NOT EXISTS alertas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    no TEXT,
    tipo TEXT,
    nivel TEXT,       -- info, atencao, critico
    mensagem TEXT,
    ts INTEGER,       -- hora do fato
    criado_em INTEGER,
    retroativo INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_leituras_no_ts ON leituras (no, ts);
`);

const sql = {
  inserirLeitura: db.prepare(`
    INSERT OR IGNORE INTO leituras (no, sala, seq, ts, recebido_em, temp_c, umid_pct, corrente_a, tensao_v, potencia_w, reenvio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  leituraAnterior: db.prepare(`SELECT * FROM leituras WHERE no = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`),
  ultimaLeitura: db.prepare(`SELECT * FROM leituras WHERE no = ? ORDER BY ts DESC LIMIT 1`),
  leituras: db.prepare(`SELECT * FROM leituras WHERE no = ? ORDER BY ts DESC LIMIT ?`),
  no: db.prepare(`SELECT * FROM nos WHERE no = ?`),
  nos: db.prepare(`SELECT * FROM nos ORDER BY no`),
  salvarNo: db.prepare(`
    INSERT INTO nos (no, sala, intervalo_s, ultimo_ts, ultimo_seq) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (no) DO UPDATE SET sala = excluded.sala, intervalo_s = excluded.intervalo_s,
      ultimo_ts = excluded.ultimo_ts, ultimo_seq = excluded.ultimo_seq`),
  statusNo: db.prepare(`
    INSERT INTO nos (no, status_mqtt, status_em) VALUES (?, ?, ?)
    ON CONFLICT (no) DO UPDATE SET status_mqtt = excluded.status_mqtt, status_em = excluded.status_em`),
  inserirAlerta: db.prepare(`
    INSERT INTO alertas (no, tipo, nivel, mensagem, ts, criado_em, retroativo) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  alertas: db.prepare(`SELECT * FROM alertas ORDER BY id DESC LIMIT ?`),
};

module.exports = { db, sql };
