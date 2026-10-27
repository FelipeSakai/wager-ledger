# Histórico da SPEC-005

Este arquivo preserva evidências por etapa; alegações de pendência valem para a data do recorte.
Consulte o [contrato atual](../specs/005-sqs-and-inbox.md) e o [mapa de evidências](../evidence.md).

## Evidências executadas — revisão 0.4, 27/10/2026

Runtime Bun 1.4.4, MikroORM 7.2.5, PostgreSQL 17.11, LocalStack 4.0.3 com digest fixo
no Compose e SDK @aws-sdk/client-sqs 3.1157.0 fixado no lockfile. Base 44710c3 com
alterações locais. Instalação congelada, typecheck e build concluídos. Suíte completa:
502 aprovados/zero falhas/1.808 asserções; 374 unitários + 128 de integração.

Implementação: [validação](../../src/modules/financial/presentation/sqs/transaction-envelope.ts),
[producer](../../src/modules/financial/presentation/sqs/sqs-transaction-producer.ts),
[handler](../../src/modules/financial/presentation/sqs/handle-sqs-delivery.ts),
[consumidor](../../src/modules/financial/presentation/sqs/sqs-consumer.ts),
[adapter SQS](../../src/platform/messaging/sqs-client.ts),
[dispatcher](../../src/modules/financial/application/use-cases/dispatch-dlq.ts),
[store operacional](../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store.ts),
[migration 003](../../src/modules/financial/infrastructure/persistence/migrations/Migration202610270003.ts) e
[entrypoint](../../src/bootstrap/sqs-worker.ts). ProcessTransaction recebe a entrega
validada e grava inbox/origem no seu próprio EntityManager, antes do único commit.

A migration adiciona sqs_inbox, sqs_origins, dlq_transfers e dlq_resume_audit, com
permissões restritas, identidades/fatos imutáveis e unicidades. A função de routing
SQL cria responsabilidade tardia da origem canônica na transição pendente→FAILED.
Falha nessa inserção reverte também a transição financeira. Isso protege a fronteira
de recuperação futura; não classifica automaticamente erros como FAILED.

Testes: [SQS/PostgreSQL reais](../../tests/integration/financial-sqs.test.ts),
[envelope/producer](../../tests/unit/sqs-envelope.test.ts) e
[worker de processos](../../tests/support/sqs-race-worker.ts).

| Cenários / recorte | Evidência real |
|---|---|
| SQS-001–SQS-004 | Consumo válido, replay e nova inbox para operação HTTP; corrida HTTP/TCP + SQS; conflito de conteúdo com diagnóstico distinto |
| SQS-005/SQS-015 | SIGKILL após barreira de commit e antes de ACK; outro processo recebe novamente com uma inbox e um efeito |
| SQS-006/SQS-007 | Falha após flush/inbox reverte tudo; rejeição auditável e pendência com origem preservada antes de ACK |
| SQS-008 | Lock SQL causa falhas transitórias reais; redrive nativo leva corpo à DLQ após limite configurado de teste |
| SQS-009/SQS-010 | JSON inválido gera diagnóstico durável sem transação fictícia; ACK depende de envio confirmado |
| SQS-011 | Heartbeats reais mantêm mensagem invisível além do timeout original, sem duplicar finanças |
| SQS-012/SQS-013 | SIGTERM de processo drena operação admitida; grupos são sequenciais e mensagens posteriores não ultrapassam uma falha transitória |
| SQS-014 | Três PIDs/pools: espera pelo lock observada no PostgreSQL; outras wallets confirmam antes da liberação |
| SQS-016 | Reenvio forçado com deduplicationId diferente prova inbox independente da deduplicação do broker; não foi esperado um intervalo real de cinco minutos |
| SQS-018/SQS-020 | Broker aceita DLQ e resposta se perde por injeção; retry conserva transferId, e ACK só depois da confirmação SQL |
| SQS-019 | Envelope para FAILED já persistido cria disposição e tarefa, sem reaplicar efeito financeiro |
| SQS-021/SQS-022 | IDs de 1/128 preservados; inválidos recusados no producer ou diagnosticados no consumer |
| SQS-023/SQS-024/SQS-029 | Pendência já ACKada evolui para FAILED no harness; origem primeira é preservada entre envelopes; outro processo inicia dispatcher e envia com fila de origem vazia; replay consulta FAILED atual |
| SQS-026/SQS-027 | Pendência HTTP captura origem SQS; permissão negada ao inserir tarefa reverte FAILED e conserva pendência/inbox |
| SQS-028 | Claims concorrentes, lease expirado, confirmação antiga recusada, suspensão e retomada auditada preservam responsabilidade |

Limites: SQS-017/025 não foram exercitados em todas as combinações de crash/falha;
a morte no instante exato do envio tardio e a perda de visibilidade apesar de heartbeat
continuam sem prova dedicada. A recuperação financeira permanente foi preparada
pelas portas de persistência no harness; o algoritmo de classificação/recuperação
segura e o agendador automático de referências ainda precisam de etapa própria.
Não há publisher de eventos financeiros, redrive automático administrativo, limpeza
de histórico, IdP ou observabilidade completa. O driver/CLI desta entrega é local,
com credenciais de teste para LocalStack; não houve deploy em AWS.

## Agendador e recuperação executados — revisão 0.5, 27/10/2026

Etapa autorizada implementou [scheduler](../../src/modules/financial/application/use-cases/schedule-pending-references.ts),
[store de candidatos](../../src/modules/financial/infrastructure/references/mikro-pending-reference-store.ts),
[worker](../../src/bootstrap/reference-worker.ts) e recuperação em
[ResumePendingTransaction](../../src/modules/financial/application/use-cases/resume-pending-transaction.ts).
Polling padrão de 1 s após lote, até 50 IDs e cinco operações concorrentes; limites
configuráveis no entrypoint. Candidatos não retêm locks; cada retomada bloqueia wallet
e relê estado/agendamento. A varredura usa cursor descartável para não ficar presa
nos primeiros erros; cronograma e limites financeiros são persistentes.

FAILED automático é restrito a INVALID_REFERENCE_STATE: falha de reidratação de
referência persistida. Somente após rollback confirmado pelo adaptador, outra
unidade relê pendência/agendamento sob lock, verifica ausência de efeito e confirma
que a referência continua inválida. Reparação da referência ou terminal concorrente
prevalecem. Corrupção da própria pendência/wallet, erro desconhecido, rollback sem
confirmação e commit incerto não viram FAILED. Falhas transitórias revertidas não
consomem tentativa nem prorrogam TTL. Expiração gera REJECTED com evento, sem DLQ.

A [migration 005](../../src/modules/financial/infrastructure/persistence/migrations/Migration202610270005.ts)
grava diagnóstico imutável/correlacionado na transição pendente→FAILED, junto da
obrigação canônica de DLQ da migration 003 quando existe origem SQS. Falha de qualquer
escrita reverte o terminal. HTTP-only tem diagnóstico sem envelope SQS inventado.
`references:failures [transactionId]` inspeciona metadados; terminais não reabrem.

[Evidência real](../../tests/integration/financial-references.test.ts): REV-007/010–014,
REV-020/021 e PROC-024/025 no recorte implementado. Três processos disputam referência
pronta/ausente com avanço de outra wallet, sem efeito/check duplicado. SIGKILL em
barreiras antes/depois do commit e outro scheduler comprovam restart; SIGTERM drena.
O teste de perda de conexão termina o backend SQL da própria fixture antes do
rollback: sem FAILED e sem conexão retida no pool. Commit confirmado com resposta
indisponível é injetado e preserva o terminal vencedor. Outro processo despacha a
DLQ do FAILED automático após ACK e crash com fila de origem vazia. Negar escrita
de diagnóstico/tarefa reverte a recuperação inteira. Saldo é reconciliado pelo ledger.
[Testes de scheduler](../../tests/unit/reference-scheduler.test.ts) verificam limite,
concorrência, isolamento de erro, cursor e drenagem. Corrupção é preparada apenas
com role proprietária em bancos descartáveis, nunca pelos endpoints da aplicação.

Suíte completa: 565 aprovados, zero falhas, 2.100 asserções; 403 unitários e 162
integrações. Bun 1.4.4, PostgreSQL 17.11, MikroORM 7.2.5 e LocalStack 4.0.3.
Os recortes anteriores acima são históricos. Não há classificador genérico para
qualquer exceção, reparo automático de corrupção, reabertura de FAILED ou deploy AWS.
Health, IdP e observabilidade completa permanecem pendentes.
