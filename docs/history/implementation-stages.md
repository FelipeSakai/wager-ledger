# Histórico de implementação — 27/10/2026

As capacidades e contagens abaixo descrevem o encerramento de cada etapa.
O estado atual está na [arquitetura](../../ARCHITECTURE.md) e no [mapa de evidências](../evidence.md).

### Histórico das etapas

As seções datadas a seguir registram a evidência disponível ao concluir cada etapa.
Menções a recursos pendentes e contagens antigas valem apenas para aquele recorte;
o estado consolidado está no início deste documento e na revisão de entrega.

### Persistência implementada em 27/10/2026

`FinancialUnitOfWork` é uma porta da aplicação. `MikroFinancialUnitOfWork` cria um
EntityManager por execução, inicia READ COMMITTED e mantém o lock pessimista da
wallet até o único commit externo. `FlushMode.COMMIT` evita auto-flush por leituras;
o adaptador executa um flush explícito para cada movimento, preservando as imagens
intermediárias mesmo quando o saldo final coincide com o inicial. Erro após um
flush reverte wallet, transação, ledger e outbox juntos.

As quatro tabelas do schema `financial` são wallets, wager_transactions,
wallet_ledger_entries e outbox_messages. Constraints locais, índices únicos,
triggers imediatas e validações diferidas incrementais verificam cada transição;
nenhuma operação soma o histórico inteiro. Os mappers usam `DecimalType('string')`
e `NUMERIC(20,2)`. O papel da aplicação tem DML limitado e não é proprietário;
migrations usam outra role. Não há sincronização automática do schema.

MikroORM core/postgresql/migrations 7.2.5 estão fixados no lockfile. As migrations
SQL manuais incluem contratos mínimos de transação/eventos necessários à integridade
da abertura, que naquela etapa ainda não incluíam WagerTransaction/hash/replay. A etapa de
aplicação descrita abaixo acrescenta esses recursos; inbox/publisher/SQS seguem pendentes. As fixtures e o worker
de corrida montam intenções apenas para provar a persistência. Os cenários
WAL-038–WAL-040, round-trip monetário e disputa com três processos estão na
[suite real](../../tests/integration/financial-persistence.test.ts).

### Casos de uso implementados em 27/10/2026

`OpenWallet` gera IDs e cria saldo/OPENING/ledger/eventos atômicos. `ProcessTransaction`
compartilha validação, hash canônico SHA-256/JSON-v1, identidade global e política de
WagerTransaction. Domínio mantém estados e regras; aplicação coordena portas,
runtime de IDs/clock/hash e outbox; infraestrutura traduz apenas erros SQL reconhecidos.
Novos provedores passam por lista local; replay durável é consultado antes de nova
admissão. Um resultado terminal preserva balance/httpStatus, sem depender do saldo atual.

A unicidade SQL decide colisões entre wallets diferentes. O perdedor desfaz a unidade
e relê a identidade em contexto novo. A mesma wallet é serializada pelo lock. As
regras de rejeição são explícitas; falhas inesperadas/corrupção não viram rejeição
ou FAILED financeiro. Políticas de retry e referência são configuráveis por injeção.

`ResumePendingTransaction` recebe um ID candidato, bloqueia wallet antes de reler
estado/agendamento e aplica ou reagenda a referência. Prazo e tentativas são duráveis;
a referência já disponível prevalece sobre prazo expirado. Reenvio de submissão
não tenta executar a pendência. Não há seleção automática/polling nem recuperação
SQS nesta etapa. Quatro classes de IntegrationEvent alimentam a outbox sem envio.

Evidência: 412 testes totais, sendo 342 unitários e 70 reais de integração, incluindo
50 reenvios por três processos com sobreposição observada no PostgreSQL e disputa
REFUND/ROLLBACK. API financeira, inbox, publisher, scheduler automático, FAILED/DLQ
e observabilidade continuam pendentes. A API NestJS atual ainda serve somente bootstrap.

### API e leituras implementadas em 27/10/2026

`src/bootstrap/http-application.ts` compõe casos de uso, ORM, queries e controllers.
Substitui o AppModule de bootstrap anterior; `main.ts` valida configuração e fecha o
ORM no encerramento. Cada operação financeira mantém sua unidade de trabalho; cada
consulta usa contexto READ ONLY/REPEATABLE READ próprio. Controllers traduzem entrada,
status/envelope e chamam aplicação, sem SQL ou regras financeiras.

`FinancialQueries` usa portas de leitura/cursor/diagnóstico. Ledger pagina por versão
decrescente, recorte superior fixo e HMAC-SHA256 com chave estável entre instâncias.
Reconciliação soma NUMERIC sem typmod dentro da mesma fotografia da wallet, sem lock
financeiro nem correção. Totais/diferenças diagnósticos fora da faixa de Money são
strings exatas. Logs sanitizados e counters locais registram divergência/integridade.

`ProviderIdentityPort` é invocada pelo guard; a implementação local deliberadamente
permite acesso sem autenticar. O bind padrão é 127.0.0.1. Correlation ID é UUID válido
ou novo UUID; bodies JSON limitam-se a 32 KiB. Erros conhecidos preservam código e
status; erros internos não expõem SQL/stack. Não há exposição pública aprovada.
A integração passou com 459 testes totais (354 unitários e 105 de integração),
incluindo HTTP/TCP real, cursor em outra instância e movimentação entre leituras da
reconciliação. Health real, IdP, SQS, publisher, scheduler e métricas exportadas seguem
pendentes; o endpoint raiz continua informativo.

### Consumo SQS e recuperação operacional — 27/10/2026

O entrypoint `bootstrap/sqs-worker.ts` compõe consumidor e loop de dispatcher de DLQ.
`HandleSqsDelivery` valida o envelope e chama o mesmo ProcessTransaction do HTTP,
passando uma entrega validada para gravar inbox/origem no contexto financeiro.
Não há commits separados para afirmar processedAt antes do efeito financeiro.
Leituras iniciais da inbox não adquirem lock; a gravação financeira/operacional
segue wallet antes de inbox/transação. Colisão exige rollback e nova consulta.

A migration 003 adiciona quatro tabelas operacionais: sqs_inbox, sqs_origins,
dlq_transfers e dlq_resume_audit. Dados de origem e corpo são imutáveis e restritos
à role da aplicação, sem exposição HTTP. A primeira origem de PENDING_REFERENCE
é escolhida sob lock da wallet. Na transição para FAILED, o trigger de routing cria
a transferência canônica na mesma unidade SQL; falha na criação desfaz o terminal.
Isso prepara a recuperação financeira futura, que ainda não classifica falhas sozinha.

O dispatcher usa SKIP LOCKED, token/lease, envio fora da unidade financeira e
confirmação condicionada. Envio incerto admite duplicata com o mesmo transferId;
source ACK exige confirmação durável. Suspensão não descarta responsabilidade;
retomada local registra operador/horário. Não confundir esse dispatcher operacional
com o publisher de eventos financeiros, que permanece pendente.

Consumidor recebe até sua capacidade, renova visibilidade enquanto aguarda e para
renovações antes de ACK/backoff. Mensagens de um grupo são sequenciais; falha bloqueia
as posteriores do lote. No shutdown, para polling e drena admitidas antes de liberar
mensagens não iniciadas. SQL e SQS têm timeouts; esgotamento do prazo de encerramento
termina o processo sem ACK especulativo, permitindo redelivery/deduplicação.

LocalStack 4.0.3 e SDK SQS 3.1157.0 estão fixados. A suíte total tem 502 testes,
zero falhas e 1.808 asserções: 374 unitários + 128 de integração. Inclui SIGKILL
após commit, SIGTERM com operação admitida, heartbeat/redrive reais, corrida HTTP/SQS,
três consumidores com lock observado e dispatcher tardio iniciado em outro processo.
Agendador de referências, recuperação automática de FAILED, publisher, IdP e métricas
completas permanecem pendentes; não há exactly-once entre banco e broker.

### Publisher financeiro implementado — 27/10/2026

`PublishOutbox` usa portas de store/transporte e runtime, sem ORM/SDK na aplicação.
O store adquire até dez eventos por transação curta com SKIP LOCKED e token/lease
individual. Todos iniciam envio sob concorrência limitada ao lote; o envio SQS ocorre
após commit operacional e fora de transação financeira. EventId/payload persistidos
não são reconstruídos; aggregateId é grupo FIFO. Posse é conferida antes do envio,
renovada enquanto necessário e exigida na confirmação. Lease perdido impede marcar
publicado, mesmo quando o broker pode ter aceitado a mensagem.

Tentativas/backoff são duráveis. Dez falhas suspendem automação sem descartar o fato;
envelope inválido também suspende para diagnóstico, sem reescrita. A migration 004
adiciona código operacional de falha, auditoria de retomada e guardas contra confirmar
sem claim ou reabrir publicado. O comando de recuperação inspeciona metadados e
retoma por eventId com operador/horário, preservando identidade e corpo.

O processo de publisher tem lifecycle próprio: parar claims, drenar envios admitidos
e liberar/expirar não enviados. Crash antes/depois de enviar retoma com o mesmo ID.
A entrega permanece at-least-once. Consumidor de teste usa inbox persistente por ID
e projeção que só aceita versão mais nova; não há serviço consumidor de eventos de
produção nesta entrega. A ordem estrita de publicação por wallet continua fora do
mínimo, mesmo usando FIFO na saída.

Evidências: 537 testes totais, zero falhas e 1.947 asserções (394 unitários + 143 de
integração). Dois publishers em processos independentes, SIGKILL em barreira antes/
depois do envio, SIGTERM, renovação, fencing, dez falhas reais de SQS e retomada
foram comprovados. API, consumidor de comandos e dispatcher de DLQ continuam próprios;
não foram adicionadas dependências. Scheduler de referências, recuperação automática
de FAILED e observabilidade completa continuam pendentes.

### Agendador e recuperação segura — etapa de 27/10/2026

SchedulePendingReferences depende de portas e ResumePendingTransaction. O store SQL
seleciona até 50 IDs elegíveis, sem FOR UPDATE nem transação longa. Cinco operações
concorrentes por padrão revalidam cada candidato sob lock da wallet; o cursor da
varredura avança mesmo após erros e reinicia ao terminar o recorte. Datas do cursor
preservam os microssegundos do PostgreSQL. Não existe lease financeiro ou mutex local
para substituir o lock; instâncias concorrentes consultam o estado durável atual.

Uma verificação bem-sucedida reagenda uma vez ou conclui com saldo/ledger/outbox
atômicos. Referência disponível tem precedência sobre expiração; indisponibilidade
após TTL/limite produz REJECTED, sem FAILED/DLQ. Retry técnico usa novo contexto e
não confirma incremento de tentativa ou extensão do prazo quando reverte.

A classificação automática atual cobre somente falha de reidratação da referência
persistida: INVALID_REFERENCE_STATE. O adaptador usa a transação callback do driver
SQL do MikroORM, ligando-a ao EntityManager exclusivo. Esse helper libera a conexão
mesmo se o rollback falhar e só devolve a exceção original após rollback confirmado.
O helper transacional de alto nível do MikroORM suprime falhas de rollback; por isso
não serve como certificado para esta recuperação. Não houve nova dependência.

Após certificação, outra unidade bloqueia a wallet, relê pendência/agendamento,
confere ausência de efeitos e revalida a falha. Referência reparada ou outro terminal
prevalecem. Corrupção da pendência/wallet, exceção genérica, erro de conexão e commit
incerto não autorizam FAILED. Ledger e terminais não são reparados ou reabertos.

A migration 005 estende o routing existente para gravar failure_diagnostics imutável
com correlação/horário. FAILED, diagnóstico e obrigação canônica de DLQ quando há
origem SQS compartilham o commit; sem origem há diagnóstico sem envelope fictício.
O dispatcher envia depois. O novo processo reference-worker tem shutdown de 30 s,
para admissões e drena trabalho iniciado. Inspeção operacional retorna metadados.

Evidências: 565 testes/zero falhas/2.100 asserções (403 unitários + 162 integrações).
Três PIDs disputam referência disponível/ausente enquanto outra wallet avança;
SIGKILL antes/depois de commit e SIGTERM comprovam retomada/drenagem. Perda real
de conexão antes do rollback conserva pendência e libera o pool. FAILED automático
após ACK é retomado por outro dispatcher; falhar na tarefa/diagnóstico reverte tudo.
Fixtures de corrupção existem somente em bancos UUID descartáveis. Não há prova de
deploy AWS nem recuperação genérica de todas as falhas permanentes possíveis.

### Observabilidade e health — etapa de 27/10/2026

A aplicação depende da porta FinancialTelemetry; domínio permanece sem logging/ORM.
report protege o resultado financeiro de uma implementação de telemetria que falhe.
OperationalTelemetry mantém catálogo de eventos/campos/enums, logs JSON com identidade
do processo e registro Prometheus local de cardinalidade limitada. Não serializa
exceções, comandos, valores monetários, credenciais, chaves ou receipt handles.

Processamento e abertura emitem transição somente após commit. Replay é separado;
reagendamento pendente não repete a transição inicial. Locks, retry e latência são
medições técnicas de tentativas; outbox distingue envio de confirmação. Correlação
aceita aparece na outbox e é recuperada do evento PendingReference ao retomar pelo
scheduler. Transferências DLQ carregam IDs/correlação existentes, sem fabricar contexto
para diagnóstico de envelope inválido. Falha de log não reabre publicação confirmada.

OperationalService separa liveness, readiness e amostragem periódica. Probes paralelos
leves verificam PostgreSQL/schema e acesso SQS às filas exigidas pelo papel. Deadline
padrão de 2 s, aquisição SQL limitada a 2 s e consultas operacionais com timeouts.
Nenhuma mensagem/entidade financeira é criada pelos probes. API verifica quatro
filas; consumidor e publisher verificam seus pares; referências verifica só SQL.
Respostas públicas contêm nomes/estados e causas fixas, sem endereços ou stack.

A API oferece /health/live, /health/ready e /metrics. Workers têm servidor operacional
próprio em loopback, portas padrão 3101/3102/3103; é preciso coletar cada processo.
Backlog/lag incluem suspensos e são amostrados a cada 15 s. Falha preserva a última
observação e publica sucesso=0/horário do último sucesso; não fabrica fila vazia.
Gauges SQL são visões repetidas do mesmo banco, sem soma entre roles. Contagem DLQ
SQS é aproximada. Não há telemetria contábil durável, TSDB, tracing ou dashboard.

SIGTERM marca draining antes do fechamento, recusa novas admissões e drena trabalho
iniciado com limite de 30 s. Na API, o socket é capturado antes de finish para fechar
a conexão após enviar a resposta; o acesso tardio a response.socket já pode retornar
null. Isso evita aguardar keep-alive até o timeout sem destruir transação admitida.
Servidores de workers mantêm prontidão 503 durante a drenagem e fecham com os recursos.

590 testes/zero falhas/2.224 asserções: 413 unitários e 177 integrações. A suite
financial-observability.test.ts usa PostgreSQL/LocalStack, falhas limitadas ao banco
UUID e um processo HTTP separado para SIGTERM em operação bloqueada no SQL. Prova
correlação concorrente, publicação SQS, replay/inbox/DLQ, counters pós-commit, falha de
sink, perda de dependências, backlog suspenso e preservação após falha de coleta.
Compose mantém PostgreSQL/LocalStack; os quatro papéis Bun foram iniciados e sondados
localmente. Não há container de aplicação, IdP ou deploy AWS nesta etapa.
