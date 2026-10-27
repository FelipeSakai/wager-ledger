# Manual de operação local

O início rápido está no [README](../README.md). Os comandos abaixo partem da raiz do projeto.
Os exemplos HTTP usam a API iniciada com `PORT=3001`, como no README. O valor 3000
em `.env.example` e o fallback da aplicação continuam válidos; para seguir os
exemplos, o prefixo `PORT=3001` deve estar no comando de inicialização.

## PostgreSQL e migrations

```sh
bun run db:up
bun run migration:up
bun run migration:list
```

O Compose usa PostgreSQL 17 com imagem fixada por digest (17.11 no ambiente
verificado), escuta apenas em `127.0.0.1:55439` e mantém um volume persistente.
A inicialização de um volume vazio cria `wager_migrator` como proprietário e
`wager_app` sem privilégios de DDL, superusuário ou alteração de roles. O SQL
financeiro concede apenas as operações necessárias à aplicação. As senhas de
`.env.example` são defaults locais; se as alterar, ajuste também as URLs.
Variáveis de inicialização não alteram senhas de um volume existente.

`MIGRATION_DATABASE_URL` executa migrations; `DATABASE_URL` é exclusiva da aplicação.
`TEST_DATABASE_ADMIN_URL` permite criar o banco descartável dos testes. Os testes
usam as três conexões separadas, criam `wager_test_<uuid>` e apagam somente esse
banco ao terminar. O banco principal não é limpo. Os defaults correspondem ao
Compose; para outro servidor, configure as três URLs e as mesmas roles.

`bun run migration:down` reverte a última migration. A quinta remove os diagnósticos
de FAILED e restaura o routing anterior; a quarta remove proteções/auditoria
do publisher; a terceira remove a recuperação SQS; a segunda remove agendamento e
versão do hash; a primeira remove todo o schema financeiro. Usar somente em banco
descartável ou com plano de recuperação aprovado. O ciclo up/down/up foi testado
em banco isolado. As migrations SQL são manuais e versionadas; sincronização
automática e geração de snapshots estão desabilitadas.

`bun run db:stop` para o PostgreSQL preservando o volume. LocalStack é um serviço separado descrito abaixo. A API exige banco e migrations; o endpoint raiz não verifica saúde das dependências.

## API HTTP disponível

| Método e rota | Comportamento |
|---|---|
| POST /wallets | Abre carteira; 201 ou 409 com error.details.walletId existente |
| GET /wallets/:walletId | Saldo atual, versão e datas UTC |
| GET /wallets/:walletId/ledger?limit=50&cursor=... | Histórico por versão decrescente; limit 1–100 e cursor assinado |
| POST /wagering/transactions | Submete BET/WIN/LOSS/REFUND/ROLLBACK; exige Idempotency-Key |
| GET /wagering/transactions/:transactionId | Recurso atual, inclusive OPENING interna |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | Consulta da mesma transação externa |
| POST /wallets/:walletId/reconciliation | Relatório de saldo/ledger na mesma fotografia SQL, sem reparo |

Exemplo de abertura:

```sh
curl -i http://127.0.0.1:3001/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"00000000-0000-4000-8000-000000000001","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Submissão aceita providerId, externalTransactionId, playerId, walletId, roundId,
gameId, kind, money e referência opcional conforme o tipo; veja a SPEC-003. Todos
os amounts financeiros são strings com duas casas. Campos desconhecidos, body
inválido e ausência da key recebem 400 antes de aceitar identidade financeira.
O corpo JSON tem limite de 32 KiB.

Submissão/replay usa 200 para PROCESSED, 422 para REJECTED, 202 para
PENDING_REFERENCE e 500 para FAILED durável. Consultas de qualquer estado existente
usam 200. Resultado histórico de transação é separado do saldo atual da carteira.
As consultas omitem key, hash, claims e dados operacionais internos. Correlation ID
UUID é aceito ou gerado e devolvido em X-Correlation-Id; erros usam envelope seguro.

A primeira página fixa a versão superior do ledger; movimentações posteriores só
aparecem numa paginação nova. Reconciliação usa READ ONLY/REPEATABLE READ e SUM
NUMERIC exata, inclusive em totais diagnósticos fora da faixa de Money. Divergência
finita retorna consistent=false e issues; dados não finitos geram 500 seguro.
Logs sanitizados e métricas em /metrics registram divergências/integridade.

## SQS, inbox e DLQ

```sh
bun run sqs:up
bun run sqs:setup
bun run migration:up
bun run worker:sqs
```

O Compose fixa LocalStack 4.0.3 por digest, com somente SQS, volume próprio e bind
local em 127.0.0.1:4566. Essa versão foi validada como emulador deste projeto;
não se declara compatibilidade de toda a AWS. O SDK @aws-sdk/client-sqs 3.1157.0 está
fixado. Scripts/worker locais usam credenciais de teste, sem conta AWS real.
`sqs:setup` cria wager-transactions.fifo e wager-transactions-dlq.fifo, retenção de
4/14 dias e redrive após cinco recebimentos sem conclusão. Não purga filas.

O envelope JSON segue a SPEC-005: messageId, type WagerTransactionRequested,
occurredAt ISO e data com o comando e idempotencyKey. messageId aceita 1–128
caracteres ASCII de letras, dígitos, hífen e underscore. O produtor valida o arquivo
antes do envio; usa walletId como grupo e messageId como deduplicação FIFO:

```sh
bun run sqs:send examples/sqs-bet.json
bun run dlq:inspect
bun run dlq:resume <transferId> <operator>
```

O arquivo de envelope é fornecido pelo operador, com IDs de uma wallet existente;
nenhum seed financeiro é aplicado automaticamente. Os comandos não imprimem o corpo.
`dlq:inspect` lista metadados de até 100 tarefas; `dlq:resume` retoma somente uma tarefa
suspensa, registra operador/horário e preserva corpo e transferId. O dispatcher
retoma tarefas pelo banco, independentemente de novos recebimentos.

A inbox usa consumidor estável wager-transactions-v1 e hash canônico do envelope,
incluindo a key e o instante de transporte. É diferente do hash de negócio. Corpo
original/origem são imutáveis e ficam apenas no armazenamento operacional e nas
filas. ACK só acontece depois do commit de finanças/inbox/outbox ou, para uma entrega
permanente, depois da confirmação durável do envio à DLQ. Envio com resultado incerto
mantém a origem sem ACK e reutiliza o mesmo transferId; duplicata na DLQ é possível.

Uma pendência SQS preserva a primeira origem antes do ACK. A migration 003 garante
que a transição PENDING_REFERENCE→FAILED com origem canônica também crie a tarefa
DLQ na mesma unidade SQL. Essa garantia foi testada tanto com transições preparadas pelo harness quanto
com a recuperação automática restrita a INVALID_REFERENCE_STATE pelo agendador.
Rejeições de negócio não viram FAILED. O dispatcher tardio não precisa de receipt
handle nem redelivery. Se persistir a tarefa falhar, FAILED também reverte.

Defaults: long polling 20 s, lote 10, visibilidade 60 s/heartbeat 20 s, backoff
transitório 1–30 s e drenagem de 30 s. Lote, visibilidade, heartbeat e janela de
shutdown são configuráveis nas variáveis SQS_* do exemplo. Grupos distintos avançam
em paralelo; um grupo é sequencial e mensagens posteriores aguardam após falha.
Ao encerrar, o consumidor para novas leituras, drena as admitidas e devolve mensagens
não iniciadas; não libera visibilidade enquanto uma operação local puder confirmar.

As tabelas de inbox/origem/transferências/auditoria e a auditoria de retomada de outbox
complementam as quatro tabelas financeiras. Rollback de migrations pode remover
dados operacionais; usar somente em banco descartável ou com plano aprovado. Testes criam bancos e pares de filas com UUIDs e
apagam apenas seus próprios recursos. A suíte completa exige PostgreSQL e LocalStack.

## Publicação da outbox

`sqs:setup` também prepara wager-events.fifo e wager-events-dlq.fifo, separadas das
filas de comandos. O publisher tem processo próprio:

```sh
bun run migration:up
bun run sqs:setup
bun run worker:outbox
```

O claim usa transação SQL curta com SKIP LOCKED. O envio ocorre depois de liberar
essa transação, preservando eventId/payload/aggregateId. EventId é a deduplicação SQS;
aggregateId é o grupo. A confirmação exige token e lease vigentes. Eventos publicados
não podem ser reabertos ou reescritos pela aplicação. Um rollback financeiro deixa
nenhum evento visível para claim.

Defaults: lote e concorrência de até 10, lease 30 s/heartbeat 10 s, envio SQS com
timeout de 5 s, polling em torno de 1 s com jitter e backoff 1–300 s. Dez falhas
suspendem a automação sem apagar o fato. As variáveis OUTBOX_* configuram lote,
lease/heartbeat, máximo de tentativas e shutdown; a política pode ser injetada em
outros entrypoints/testes. Payload inválido suspende para diagnóstico sem envio.

```sh
bun run outbox:inspect
bun run outbox:inspect <eventId>
bun run outbox:resume <eventId> <operator>
```

A inspeção lista metadados de até 100 eventos, priorizando suspensos/pendentes;
lookup por eventId é exato. A retomada registra operador/horário e preserva o mesmo
payload/eventId. Retomar um envelope incompatível não o corrige silenciosamente:
a correção de compatibilidade precisa de decisão própria. Logs JSON e counters
locais registram publicação, falha, suspensão e perda de claim sem expor payload.

No encerramento, não há novos claims; os envios admitidos drenam e claims não
enviados são liberados ou expiram. Se o SQS aceitar o envio e o processo morrer
antes da confirmação SQL, o retry pode entregar uma duplicata com o mesmo eventId.
Não há promessa de exactly-once nem ordem estrita de publicação por wallet.
O consumidor precisa deduplicar por ID e usar walletVersion para eventos atrasados.
A demonstração usa uma inbox/projeção persistentes **somente de teste**, sem criar
um serviço consumidor de eventos de produção.

## Validação e build

```sh
bun run test:unit
bun run test:integration
bun run check:architecture
bun run typecheck
bun run build
PORT=3001 bun run start:prod
```

`bun run start` executa o código fonte sem observar alterações.
O build usa o compilador TypeScript com suporte aos decorators do NestJS.
`bun run test:unit` executa domínio, contratos e regras de arquitetura.
`bun run test:integration` exige PostgreSQL e LocalStack reais; inclui 50 reenvios
em três processos, com barreiras e espera por lock observada no servidor.
`bun test --timeout 30000` executa a suíte completa com o timeout usado na validação.

A [matriz de evidências](evidence.md) concentra os totais atuais e os cenários
comprovados. O [relatório de entrega](delivery.md) registra ambientes, tempos e
limitações de cada execução. Resultados anteriores ficam no [histórico](history/README.md).

## Health, métricas e logs

Todos os papéis oferecem GET /health/live, GET /health/ready e GET /metrics.
Health dispensa autenticação. Os binds padrão são loopback; métricas destinam-se
à operação local, sem autorização de exposição pública em produção.

| Processo | Porta padrão | Dependências de readiness |
|---|---|---|
| API | PORT, default 3000 | PostgreSQL + quatro filas de comandos/eventos e respectivas DLQs |
| Consumidor/dispatcher | SQS_OPERATIONS_PORT=3101 | PostgreSQL + fila de comandos e DLQ |
| Publisher | OUTBOX_OPERATIONS_PORT=3102 | PostgreSQL + fila de eventos e DLQ |
| Referências | REFERENCE_OPERATIONS_PORT=3103 | PostgreSQL |

```sh
# API iniciada com PORT=3001, como nos demais exemplos deste manual.
curl http://127.0.0.1:3001/health/live
curl http://127.0.0.1:3001/health/ready
curl http://127.0.0.1:3001/metrics
curl http://127.0.0.1:3101/metrics
curl http://127.0.0.1:3102/metrics
curl http://127.0.0.1:3103/metrics
```

Live retorna 200 sem consultar dependências. Ready retorna 200 ou 503 com nomes e
estados seguros, sem URL/SQL/credenciais. Probes independentes executam em paralelo,
com deadline padrão de 2 s; SQS usa GetQueueUrl/GetQueueAttributes, sem mensagens
artificiais. O probe SQL confirma acesso ao schema financeiro sem ler valores.
PROBE_TIMEOUT_MILLISECONDS e PROBE_INTERVAL_MILLISECONDS configuram probes/coleta;
o intervalo padrão de backlog é 15 s. O pool limita aquisição de conexão a 2 s e
consultas operacionais usam statement timeout de 1 s/lock timeout de 250 ms.

/metrics usa texto Prometheus, com counters/histograms por processo e gauges de
backlog SQL/SQS. Replays contam em wager_duplicates_total; não incrementam
wager_transactions_total. Este último conta transições confirmadas por status/kind,
incluindo pendência inicial e seu terminal posterior, não cada varredura. Abertura
zero não cria transação/evento nem contagem financeira artificial. Locks/retries e
latência técnica são medições operacionais, inclusive de tentativas revertidas.

Outbox e tarefas DLQ suspensas continuam no backlog/lag. Se uma coleta falha,
operational_probe_success vira zero e a última medição fica preservada; consultar
operational_probe_last_success_timestamp_seconds para detectar desatualização.
Antes da primeira coleta bem-sucedida, os valores não são inventados. Contagem SQS
é aproximada e inclui disponíveis, em voo e atrasadas das DLQs observadas pelo papel.
Gauges SQL representam o mesmo banco em cada processo: escolher uma instância ou
agregar por máximo, sem somá-los entre papéis. Counters reiniciam com o processo.
Prometheus/Grafana não foram instalados; cada processo deve ser coletado separadamente.

Logs JSON incluem UTC, role, instanceId, evento e IDs aplicáveis. Campos/enums são
permitidos por catálogo; IDs nunca são labels. Corpo, idempotency key, receipt handle,
segredos, valores monetários e SQL não são registrados. A correlação aceita chega à
outbox e é recuperada na conclusão de referências. Falha de telemetria não altera
commit, replay, ACK ou publicação confirmada; métricas não substituem o ledger.

SIGTERM muda prontidão, interrompe novas admissões e drena operações em andamento.
O deadline referenciado padrão de 30 s cobre também toda a limpeza; falha de
fechamento não cancela esse limite, e sinais repetidos não o prorrogam. A API fecha conexões ociosas e encerra o
socket da resposta já concluída; não destrói uma requisição financeira em execução.
OPERATIONS_HOST configura o bind dos workers; HTTP_SHUTDOWN_MILLISECONDS configura
o orçamento HTTP. Os papéis continuam sendo processos Bun separados sobre as duas
dependências do Compose; não há novo container de aplicação nesta etapa.

## Agendador de referências e falhas permanentes

```sh
bun run migration:up
bun run worker:references
bun run references:failures
bun run references:failures <transactionId>
```

O processo usa o mesmo ResumePendingTransaction da aplicação: seleciona IDs sem
lock financeiro, bloqueia a wallet e relê estado/agendamento em um contexto exclusivo.
Defaults: polling de 1 s após cada lote, até 50 IDs e cinco operações concorrentes;
REFERENCE_* configura polling, lote, concorrência e shutdown. A varredura usa cursor
para que registros ilegíveis não impeçam alcançar as próximas wallets. O cursor é
local e descartável; prazo, tentativas e próximo instante permanecem no PostgreSQL.
Nenhuma chamada externa ocorre na transação financeira.

Referência disponível prevalece sobre prazo vencido. Se ainda indisponível, prazo
ou limite esgotados geram REJECTED com evento, sem DLQ. Erros transitórios não
consomem uma verificação de referência nem prorrogam o prazo. SIGTERM para novas
admissões e drena operações iniciadas; o limite de shutdown padrão é 30 s.

A classificação automática de FAILED é deliberadamente restrita: uma referência
persistida que não pode ser reidratada gera INVALID_REFERENCE_STATE. Exige rollback
confirmado, nova transação, lock da wallet, mesmo estado/agendamento, ausência de
ledger/evento de efeito e confirmação de que a referência continua inválida. Uma
referência reparada ou um terminal concorrente prevalecem. Corrupção da própria
pendência/wallet, erro desconhecido, falha no rollback e commit incerto não são
classificados como FAILED. Não há reparo automático de dados corrompidos.

A migration 005 grava diagnóstico imutável com transactionId, failureCode, correlação
e horário no mesmo commit do FAILED. Com origem SQS, o routing também grava a tarefa
tardia canônica de DLQ; qualquer falha reverte toda a recuperação. Sem origem SQS,
o diagnóstico existe sem fabricar envelope. A inspeção lista até 100 metadados, ou
consulta o ID exato; não expõe corpo original nem reabre estado terminal.

## Referências

O desenho financeiro e os limites estão na [arquitetura](../ARCHITECTURE.md).
A [matriz de evidências](evidence.md) e o [relatório de entrega](delivery.md)
registram os checks, ambientes e limites da validação atual.
