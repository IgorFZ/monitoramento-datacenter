// Configuracoes gerais. Tudo pode ser trocado por variavel de ambiente.
const fs = require('node:fs');
const mqttOptions = {
  ...(process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME } : {}),
  ...(process.env.MQTT_PASSWORD ? { password: process.env.MQTT_PASSWORD } : {}),
  ...(process.env.MQTT_CA_FILE ? { ca: fs.readFileSync(process.env.MQTT_CA_FILE) } : {}),
  rejectUnauthorized: true,
};
module.exports = {
  mqttOptions,
  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  sala: process.env.SALA || 'sala01',
  porta: Number(process.env.PORTA || 3000),
  arquivoBanco: process.env.DB || 'dados/monitoramento.db',

  // limiares definidos na etapa anterior do projeto
  limites: {
    tempAtencao: 27,
    tempCritico: 32,
    umidMin: 20,
    umidMax: 60,
    capacidadeCircuitoA: 16, // disjuntor do ramal do rack
    percCorrente: 0.8,
    taxaTempMax: 0.5, // °C por minuto
    // quanto o valor precisa voltar abaixo do limiar para sair do alerta
    histerese: { temp: 0.5, umid: 2, corrente: 0.5 },
  },

  // quantos ciclos sem leitura ate considerar o rack sem comunicacao
  ciclosSemDado: 3,
};
