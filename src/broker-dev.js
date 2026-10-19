// Broker MQTT simples para rodar sem Docker (so para desenvolvimento).
// Em producao a ideia continua sendo o Mosquitto, ver docker-compose.yml
const { createServer } = require('node:net');
const { Aedes } = require('aedes');

const porta = Number(process.env.PORTA_MQTT || 1883);

async function main() {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);

  broker.on('client', (c) => console.log(hora(), '[broker] conectou:', c.id));
  broker.on('clientDisconnect', (c) => console.log(hora(), '[broker] desconectou:', c.id));

  server.listen(porta, () => console.log(hora(), '[broker] broker de desenvolvimento ouvindo na porta', porta));
}

function hora() {
  return new Date().toLocaleTimeString('pt-BR');
}

main();
