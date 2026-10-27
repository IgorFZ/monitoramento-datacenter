# Roteiro da demonstração (tolerância a falhas)

Roteiro para apresentar em aula. Leva uns 5 minutos.

```bash
npm install
npm test
npm run dev -- --intervalo 5
```

Abrir http://localhost:3000 e deixar o painel aberto o tempo todo (não recarregar a página, senão ele perde o último valor guardado). Com leitura a cada 5 s o limite de dado desatualizado fica em 15 s. As teclas são apertadas no terminal do `npm run dev`.

## 1. Funcionamento normal

Mostrar os dois racks atualizando, a idade da última leitura e a tabela com horário da medição e horário de chegada.

## 2. Queda do Wi-Fi do rack01

Apertar `1`. O terminal mostra as leituras do rack01 indo para o buffer. Esperar uns 20 s.

O que tem que aparecer: o card do rack01 fica cinza com **DADO DESATUALIZADO**, os valores continuam lá com a idade subindo, e nos alertas aparece o Last Will e depois "Sem leituras há X s". O rack02 continua normal.

## 3. Wi-Fi volta

Apertar `1` de novo, sem reiniciar nada. O rack01 reenvia o buffer (na tabela aparecem marcadas como "reenviada", com o horário original da medição) e o alerta "Comunicação restabelecida" aparece.

## 4. Backend fora

Apertar `b`. Em até 5 s o painel mostra "Sem conexão com o servidor", os cards ficam cinza e a idade continua contando. Apertar `b` de novo: o backend volta com a sessão anterior ("sessao anterior: sim" no log) e recebe o que ficou na fila do broker.

## 5. Broker fora

Apertar `m`. O painel avisa que o servidor perdeu o broker e os dois racks guardam as leituras no buffer. Apertar `m` de novo: todo mundo reconecta sozinho e o buffer é reenviado. O log do backend registra "comunicacao com o broker interrompida" e "restabelecida".

Obs.: o broker de desenvolvimento guarda a fila em memória, então o que estava só nele se perde quando ele cai. Quem segura os dados nesse caso é o buffer dos nós.

## 6. Segurança

Mostrar o `mosquitto/mosquitto.conf` com `allow_anonymous true` e explicar que qualquer um na rede conseguiria publicar num tópico de rack. Mostrar o `src/config.js` lendo usuário/senha/CA de variável de ambiente e o `.gitignore`. Não mostrar senha real na tela.

`q` encerra tudo.
