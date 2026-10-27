const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('painel envelhece o ultimo valor offline e escapa texto recebido', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace('cicloPainel();\nsetInterval(redesenharIdade, 1000);', '');
  const elementos = {};
  const elemento = () => ({ innerHTML: '', textContent: '', style: {}, filhos: [], appendChild(e) { this.filhos.push(e); } });
  const contexto = vm.createContext({
    document: { getElementById(id) { return elementos[id] ||= elemento(); }, createElement: elemento },
    performance: { now: () => 20000 }, Date, setTimeout, setInterval,
  });
  vm.runInContext(script, contexto);
  vm.runInContext(`
    racksGuardados = [{ no: 'rack01', sala: '<img src=x onerror=alert(1)>', intervalo_s: 1,
      ultima_leitura: { temp_c: 23, ts: 1000 }, idade_s: 1, limite_s: 3,
      desatualizado: false, alertas: [], status_mqtt: 'online' }];
    recebidoMono = 10000;
    apiDisponivel = false;
    redesenharIdade();
  `, contexto);
  const card = elementos.racks.filhos.at(-1);
  assert.match(card.className, /desatualizado/);
  assert.match(card.innerHTML, /DADO DESATUALIZADO/);
  assert.match(card.innerHTML, /11 s/);
  assert.match(card.innerHTML, /23 °C/);
  assert.match(card.innerHTML, /&lt;img/);
  assert.doesNotMatch(card.innerHTML, /<img/);
  vm.runInContext('apiDisponivel = true; recebidoMono = 20000; redesenharIdade();', contexto);
  assert.doesNotMatch(elementos.racks.filhos.at(-1).className, /desatualizado/);
});
