# Monitoramento da sala de servidores - Grupo 04

Projeto Integrador da disciplina de Comunicação de Dados e Aplicações Distribuídas (UNOESC, Eng. de Computação, 8ª fase).

Gabriel Likes, Gustavo Peretto, Igor Felipe Zampieri e Victor Luckmann.

## O que tem aqui

Esta etapa implementa um fluxo completo da arquitetura:

```
ESP32 (simulado)  --MQTT/QoS1-->  Broker  --MQTT-->  Backend  -->  SQLite
                                                        |
                                                        +--> API REST --> Painel web
```

- `src/simulador/esp32-sim.js` faz o papel do nó ESP32 do rack. O projeto não inclui montagem física, então cada rack é um processo do simulador: gera temperatura, umidade e corrente, publica a cada N segundos e guarda as leituras num buffer quando perde a conexão.
- `src/backend/` assina os tópicos, grava no banco, avalia os limiares, vigia o heartbeat dos racks e expõe a API.
- `public/index.html` é o painel que mostra os racks, as últimas leituras e os alertas.
- `src/broker-dev.js` é um broker MQTT em Node (aedes) para rodar sem Docker. O broker previsto na arquitetura é o Mosquitto (`docker-compose.yml`).

Os diagramas estão em `docs/`: [arquitetura do fluxo](docs/arquitetura-fluxo.png) e [sequência na queda de comunicação](docs/sequencia-falha.png).

## Como rodar

Precisa do Node 22 ou mais novo (usamos o `node:sqlite`, que já vem no Node).

```bash
npm install
```

Para subir tudo num terminal só (broker de desenvolvimento, backend, rack01 e rack02):

```bash
npm run dev
npm run dev -- --intervalo 5     # leituras a cada 5 s, bom para demonstrar
npm run dev -- --mosquitto       # usa o Mosquitto do docker compose em vez do broker de desenvolvimento
```

O painel fica em http://localhost:3000. Os dois racks começam normais, e as falhas são provocadas pelo teclado, no mesmo terminal:

| tecla | o que acontece |
|---|---|
| `1` / `2` | derruba ou religa o Wi-Fi do rack01 / rack02 |
| `3` / `4` | para ou religa o ar-condicionado do rack01 / rack02 (temperatura sobe ~0,8 °C/min; quando volta, esfria ~1,5 °C/min) |
| `5` / `6` | liga ou desliga a sobrecarga no rack01 / rack02 (corrente sobe ~1,2 A/min) |
| `b` | derruba ou sobe o backend |
| `m` | derruba ou sobe o broker |
| `h` | mostra o menu |
| `q` | encerra tudo |

Se preferir rodar cada parte separada, em terminais diferentes:

```bash
docker compose up -d      # Mosquitto, ou: npm run broker
npm run backend
npm run rack01
npm run rack02            # rack02 já começa com o ar-condicionado parado
```

### Opções do simulador

```
node src/simulador/esp32-sim.js --rack rack03 --intervalo 30 --cenario normal --temp 23
```

| opção | o que faz |
|---|---|
| `--rack` | nome do nó (vai no tópico e no clientId) |
| `--intervalo` | segundos entre leituras (padrão 30) |
| `--cenario` | `normal`, `falha-ar` (temperatura sobe ~0,8 °C/min) ou `sobrecarga` (corrente sobe) |
| `--temp` | temperatura inicial |
| `--queda 60,90` | derruba o "wifi" aos 60 s por 90 s, para testar o buffer e o reenvio |

Variáveis de ambiente: `MQTT_URL` (padrão `mqtt://localhost:1883`), `SALA`, `PORTA` (porta HTTP, padrão 3000) e `DB` (arquivo do banco).

## Tópicos e mensagens

```
datacenter/{sala}/{rack}/telemetria   leituras, QoS 1
datacenter/{sala}/{rack}/status       online/offline, QoS 1, retida (Last Will)
```

Exemplo de leitura:

```json
{
  "no": "rack01", "sala": "sala01", "seq": 42,
  "ts": "2026-10-18T20:31:05.120Z", "intervalo_s": 30,
  "temp_c": 23.4, "umid_pct": 45.1, "corrente_a": 7.6, "tensao_v": 219.8, "potencia_w": 1671,
  "reenvio": false
}
```

## API

| rota | retorno |
|---|---|
| `GET /api/status` | conexão do backend com o broker e hora do servidor |
| `GET /api/racks` | último valor de cada rack, idade da leitura e se está desatualizado |
| `GET /api/racks/:no/leituras?limite=50` | histórico do rack |
| `GET /api/alertas?limite=30` | últimos alertas |

## Evidências

Na pasta `evidencias/` estão os prints do painel e os logs de cada componente de um teste de ~8 minutos, com queda do wifi de um rack, queda do backend e queda do broker. O roteiro com os horários está em `evidencias/logs/roteiro.log`.

## Ainda falta

- envio dos alertas por Telegram/e-mail (hoje só grava no banco e mostra no log/painel)
- trocar o SQLite pelo banco de séries temporais
- autenticação no broker
