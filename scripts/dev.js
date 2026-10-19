// Sobe broker, backend e os dois racks num terminal so, e deixa provocar
// falhas pelo teclado para ver o sistema reagindo.
//
// uso: npm run dev [-- --intervalo 5] [-- --mosquitto]
//   --intervalo N  segundos entre leituras dos racks (padrao 30)
//   --mosquitto    nao sobe o broker de desenvolvimento (usar com docker compose)

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const argv = process.argv.slice(2);
const intervalo = argv.includes('--intervalo') ? argv[argv.indexOf('--intervalo') + 1] : '30';
const usarMosquitto = argv.includes('--mosquitto');
const raiz = path.join(__dirname, '..');

const servicos = {
  broker: { args: ['src/broker-dev.js'], cor: 35 },
  backend: { args: ['--disable-warning=ExperimentalWarning', 'src/backend/index.js'], cor: 36 },
  rack01: { args: ['src/simulador/esp32-sim.js', '--rack', 'rack01', '--intervalo', intervalo], cor: 32 },
  rack02: { args: ['src/simulador/esp32-sim.js', '--rack', 'rack02', '--intervalo', intervalo], cor: 33 },
};
if (usarMosquitto) delete servicos.broker;

const rodando = {};
let saindo = false;

function iniciar(nome) {
  const s = servicos[nome];
  const p = spawn(process.execPath, s.args, { cwd: raiz, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const saida of [p.stdout, p.stderr]) {
    readline.createInterface({ input: saida }).on('line', (l) => console.log(`\x1b[${s.cor}m${l}\x1b[0m`));
  }
  p.on('exit', () => {
    if (rodando[nome] === p) delete rodando[nome];
  });
  rodando[nome] = p;
}

function alternar(nome) {
  if (!servicos[nome]) return aviso(`${nome} nao esta sendo gerenciado aqui (rodando com --mosquitto?)`);
  if (rodando[nome]) {
    aviso(`derrubando o ${nome}`);
    rodando[nome].kill(); // mata sem aviso, como uma queda de verdade
    delete rodando[nome];
  } else {
    aviso(`subindo o ${nome} de novo`);
    iniciar(nome);
  }
}

function comandoRack(rack, cmd) {
  if (!rodando[rack]) return aviso(`${rack} nao esta rodando`);
  rodando[rack].send(cmd);
}

function aviso(msg) {
  console.log(`\x1b[1;37m>>> ${msg}\x1b[0m`);
}

function menu() {
  console.log(`
\x1b[1mTeclas:\x1b[0m
  1 / 2   derruba ou religa o Wi-Fi do rack01 / rack02
  3 / 4   para ou religa o ar-condicionado do rack01 / rack02
  5 / 6   liga ou desliga a sobrecarga eletrica no rack01 / rack02
  b       derruba ou sobe o backend
  m       derruba ou sobe o broker
  h       mostra este menu
  q       encerra tudo
Painel: http://localhost:${process.env.PORTA || 3000}   (leituras a cada ${intervalo} s)
`);
}

const teclas = {
  1: () => comandoRack('rack01', 'wifi'),
  2: () => comandoRack('rack02', 'wifi'),
  3: () => comandoRack('rack01', 'ar'),
  4: () => comandoRack('rack02', 'ar'),
  5: () => comandoRack('rack01', 'sobrecarga'),
  6: () => comandoRack('rack02', 'sobrecarga'),
  b: () => alternar('backend'),
  m: () => alternar('broker'),
  h: menu,
  q: sair,
  '\u0003': sair, // Ctrl+C no modo raw
};

function sair() {
  if (saindo) return;
  saindo = true;
  aviso('encerrando...');
  for (const p of Object.values(rodando)) p.kill();
  setTimeout(() => process.exit(0), 300);
}

// no terminal le tecla por tecla; se a entrada vier de um pipe, le os caracteres do mesmo jeito
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (dados) => {
  for (const c of dados) if (teclas[c.toLowerCase()]) teclas[c.toLowerCase()]();
});
process.on('SIGINT', sair);

// broker primeiro, depois backend, depois os racks
if (servicos.broker) iniciar('broker');
setTimeout(() => iniciar('backend'), 800);
setTimeout(() => {
  iniciar('rack01');
  iniciar('rack02');
  menu();
}, 1600);
