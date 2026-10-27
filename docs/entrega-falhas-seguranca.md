# Etapa 4: tolerância a falhas e segurança no fluxo de dados

Grupo 04: Gabriel Likes, Gustavo Peretto, Igor Felipe Zampieri e Victor Luckmann.
Comunicação de Dados e Aplicações Distribuídas, prof. Carlos Elian Lopes Vieira.

O fluxo é o mesmo da etapa 3: nó do rack (simulado) → MQTT → broker → backend → SQLite → API → painel. Boa parte do tratamento de falha já existia (buffer, Last Will, watchdog, sessão persistente). Nesta etapa revisamos esse tratamento e corrigimos os pontos em que o sistema ainda podia mostrar um dado velho como se fosse atual. Esse mesmo texto está no documento Word da entrega, seções 11 a 16.

## 1. Quando o dado fica desatualizado

O limite é de **3 intervalos de envio**. Com leitura a cada 30 s, o dado fica desatualizado depois de 90 s sem leitura nova (no teste usamos 5 s, então 15 s). Escolhemos 3 ciclos porque perder uma mensagem isolada é normal no Wi-Fi e não deveria gerar alarme, mas também não dá para esperar muito: com a temperatura subindo 0,5 °C/min, em 90 s ela sobe menos de 1 °C, o que ainda cabe na folga entre o nível de atenção (27 °C) e o crítico (32 °C).

- A idade é calculada a partir do horário da **medição** (`ts`, marcado pelo nó), e não do horário de chegada. Assim um buffer reenviado agora não parece leitura nova.
- O painel mantém o último valor na tela, deixa o card cinza com **DADO DESATUALIZADO** e mostra "Última leitura há X s (hh:mm:ss)".
- O que mudou nesta etapa para não mostrar dado antigo como atual:
  - a idade continua contando no navegador a cada segundo, mesmo se o backend cair (antes ela congelava no último valor que a API devolveu);
  - se a API não responde em 4 s, o painel marca todos os racks como desatualizados e mostra o aviso de servidor fora;
  - a API compara a idade sem arredondar (antes 15,4 s virava 15 e passava como atual);
  - leitura com horário mais de 60 s no futuro é descartada. Antes o backend trocava pelo horário de chegada, e um dado de horário desconhecido aparecia como atual;
  - leitura mais antiga que a atual vai para o histórico, mas nunca substitui o estado atual do rack.

## 2. Teste: dados param e voltam

O teste está em `evidencias/etapa4/` (prints, respostas da API e `logs/execucao.log`). Rodamos `npm run dev -- --intervalo 5` e provocamos as falhas pelo teclado:

| Falha | O que o sistema fez | Quando voltou |
|---|---|---|
| Wi-Fi do rack01 (tecla `1`) | Last Will na hora; 20 s depois o watchdog gerou "Sem leituras há 19 s (3 ciclos)" e o card ficou cinza | Reenviou o buffer com o horário original e registrou "Comunicação restabelecida" |
| Backend (tecla `b`) | Painel mostrou "Sem conexão com o servidor", com os últimos valores marcados como desatualizados e a idade contando | Voltou com "sessao anterior: sim" e recebeu da fila do broker as leituras publicadas enquanto estava fora |
| Broker (tecla `m`) | Backend registrou "comunicacao com o broker interrompida", painel avisou a queda e os nós passaram a guardar no buffer | Todos reconectaram sozinhos 2 s depois do broker voltar e reenviaram o buffer (6 leituras cada) |

Nenhum componente precisou ser reiniciado na mão. O log registra o momento em que os dados pararam (Last Will e "Sem leituras") e quando voltaram ("Comunicação restabelecida", "comunicacao com o broker restabelecida").

Um problema que encontramos revisando: antes, "Comunicação restabelecida" era registrada assim que o nó reenviava o buffer, mesmo que só tivesse leitura antiga. Agora ela só aparece quando chega uma leitura dentro do limite de atualidade.

Além do teste manual, `npm test` roda três testes automáticos (broker, backend e banco reais em processo separado): falha e recuperação, backlog antigo sem falso restabelecimento, mensagem duplicada, payload inválido, reenvio do buffer do simulador e a lógica do painel. A saída está em `evidencias/etapa4/testes-automatizados.txt`.

## 3. Proteção contra falhas

A medida principal é o **buffer local no nó com reconexão automática**, junto com a **deduplicação no banco**:

| Medida | Por quê |
|---|---|
| Buffer de 120 leituras no nó | O ponto mais frágil é o Wi-Fi do rack. Com o buffer, uma queda de até 1 h (a 30 s) não abre buraco no histórico |
| Reconexão a cada 3 s (nós e backend) | O sistema volta sozinho, sem ninguém reiniciar nada |
| Sessão persistente do backend (QoS 1, `clean: false`) | Se o backend cair, o broker guarda as mensagens e entrega quando ele voltar |
| Chave única (nó, horário) no banco | Com QoS 1 e reenvio do buffer a mesma leitura pode chegar duas vezes; a repetida é ignorada |
| Validação da mensagem e `try/catch` na gravação | Uma mensagem com defeito é descartada e registrada no log, sem derrubar o backend |

Faz sentido para a nossa arquitetura porque o broker já separa os nós do backend: cada lado pode cair sem levar o outro junto, e o que falta é segurar o dado enquanto o outro lado está fora. Os limites: o buffer fica em memória (se o nó reiniciar, perde), descarta a leitura mais antiga quando enche, e o broker de desenvolvimento (aedes) também guarda a fila em memória. O Mosquitto do `docker-compose` tem persistência em disco ligada.

## 4. Segurança da comunicação

**Trecho vulnerável:** nó → broker. O Mosquitto está com `allow_anonymous true` e MQTT sem TLS na porta 1883. Qualquer um na mesma rede pode:

- publicar uma leitura falsa em `datacenter/sala01/rack01/telemetria` com 22 °C e esconder um superaquecimento real;
- assinar `datacenter/#` e ler tudo o que passa;
- publicar `offline` no tópico de status e gerar alarme falso.

A API HTTP do painel também não tem login nem HTTPS.

**O que já existe:** validação de todos os campos da mensagem, conferência de que o rack e a sala do JSON batem com o tópico, consultas SQL com parâmetro, escape do texto no painel e o broker de desenvolvimento escutando só em `127.0.0.1`. Isso evita mensagem malformada e injeção, mas **não é autenticação**: quem forja uma leitura coloca o mesmo rack no tópico e no JSON.

**O que deveria ser usado na versão física:**

1. MQTT sobre TLS (porta 8883), com o nó conferindo o certificado do broker.
2. Usuário e senha por dispositivo no Mosquitto (`password_file`) e `allow_anonymous false`.
3. ACL por tópico: o rack01 só publica em `datacenter/sala01/rack01/#` e o backend só assina o que precisa.
4. HTTPS no painel e login dos operadores (JWT com expiração, por exemplo).
5. VLAN separada para os sensores, como já estava na arquitetura, mas sem dispensar o TLS.

O cliente MQTT já aceita `MQTT_URL=mqtts://...`, `MQTT_USERNAME`, `MQTT_PASSWORD` e `MQTT_CA_FILE`, mantendo a validação de certificado ligada. Falta configurar o broker com TLS e senha.

**Onde ficam as senhas:** em variável de ambiente, lida pelo `src/config.js`. Nada fica no código. O `.gitignore` ignora `.env`, `secrets/`, `*.key` e `*.pem`, e o repositório não tem nenhuma credencial. No ESP32 físico a senha do Wi-Fi e do broker iria num arquivo de configuração fora do Git (ou gravada na memória flash na instalação). Se uma senha fosse parar no repositório por engano, não basta apagar o arquivo: ela fica no histórico do Git, então teria que ser trocada.

## 5. Comportamento durante a falha

O sistema não tem atuador: ele não liga ar-condicionado nem corta energia, só gera alerta (log, banco e painel). Durante a falha:

- **Falta de dado é tratada como alarme**, não como "tudo normal". Depois de 3 ciclos sem leitura sai um alerta crítico e o card fica cinza. O sistema não sabe a temperatura da sala nesse momento e mostra isso.
- Um alerta de temperatura que estava ativo continua lá, mas o card marcado como desatualizado deixa claro que se refere à última leitura conhecida. O sistema não "limpa" nem confirma alerta com dado velho.
- Leituras atrasadas que chegam pelo buffer vão para o histórico e, se passaram do limite, viram um alerta marcado como retroativo, mas não mudam o estado atual do rack.

A lógica de alerta depende da rede, porque fica no backend. Sem rede o nó só consegue guardar as leituras. Se no futuro o projeto tiver uma ação automática (ex.: ligar um ar-condicionado reserva), ela teria que ficar no próprio ESP32, funcionando sem rede, e a regra para perda de comunicação teria que ser a mais segura: manter o reserva ligado, e nunca desligar nada por falta de dado.

## 6. Limitações

O buffer do nó e o estado dos alertas no backend ficam em memória. O backend aceita uma sala só, porque o banco identifica o nó só pelo nome do rack. Broker, backend e banco rodam numa máquina só, sem redundância. Não testamos com ESP32 físico nem com TLS ligado.
