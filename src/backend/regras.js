// Regras de alerta. Recebe a leitura atual, uma leitura de ~2 min antes (para
// a taxa de variacao) e o nivel atual de cada alerta (para a histerese).
const { limites } = require('../config');

function avaliar(leitura, anterior, niveis = {}) {
  const r = [];
  const h = limites.histerese;

  // histerese: para sair de um nivel o valor tem que voltar um pouco abaixo
  // do limiar. Sem isso, com a temperatura em 31,9/32,0 o alerta ficava
  // trocando entre critico e atencao a cada leitura.
  const tempAtual = niveis.temperatura || 'ok';
  const limCrit = tempAtual === 'critico' ? limites.tempCritico - h.temp : limites.tempCritico;
  const limAten = tempAtual !== 'ok' ? limites.tempAtencao - h.temp : limites.tempAtencao;

  if (leitura.temp_c >= limCrit) {
    r.push({ tipo: 'temperatura', nivel: 'critico', mensagem: `Temperatura ${leitura.temp_c} °C (crítico a partir de ${limites.tempCritico} °C)` });
  } else if (leitura.temp_c >= limAten) {
    r.push({ tipo: 'temperatura', nivel: 'atencao', mensagem: `Temperatura ${leitura.temp_c} °C (atenção a partir de ${limites.tempAtencao} °C)` });
  } else {
    r.push({ tipo: 'temperatura', nivel: 'ok' });
  }

  const umidFora = niveis.umidade === 'atencao'
    ? leitura.umid_pct < limites.umidMin + h.umid || leitura.umid_pct > limites.umidMax - h.umid
    : leitura.umid_pct < limites.umidMin || leitura.umid_pct > limites.umidMax;
  if (umidFora) {
    r.push({ tipo: 'umidade', nivel: 'atencao', mensagem: `Umidade ${leitura.umid_pct}% fora da faixa ${limites.umidMin}-${limites.umidMax}%` });
  } else {
    r.push({ tipo: 'umidade', nivel: 'ok' });
  }

  const maxCorrente = limites.capacidadeCircuitoA * limites.percCorrente;
  const limCorrente = niveis.corrente === 'atencao' ? maxCorrente - h.corrente : maxCorrente;
  if (leitura.corrente_a >= limCorrente) {
    r.push({ tipo: 'corrente', nivel: 'atencao', mensagem: `Corrente ${leitura.corrente_a} A, acima de 80% do circuito (${maxCorrente} A)` });
  } else {
    r.push({ tipo: 'corrente', nivel: 'ok' });
  }

  // taxa de variacao: compara com uma leitura de ~2 min atras. Entre duas
  // leituras seguidas o ruido do sensor dava falso alarme.
  if (anterior) {
    const dtMin = (leitura.ts - anterior.ts) / 60000;
    if (dtMin >= 2 && dtMin <= 10) {
      const taxa = (leitura.temp_c - anterior.temp_c) / dtMin;
      if (taxa >= limites.taxaTempMax) {
        r.push({ tipo: 'taxa_temp', nivel: 'atencao', mensagem: `Temperatura subindo ${taxa.toFixed(2)} °C/min` });
      } else {
        r.push({ tipo: 'taxa_temp', nivel: 'ok' });
      }
    }
  }

  return r;
}

module.exports = { avaliar };
