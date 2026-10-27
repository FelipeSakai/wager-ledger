# Histórico da SPEC-004

Este arquivo preserva evidências por etapa; alegações de pendência valem para a data do recorte.
Consulte o [contrato atual](../specs/004-reversals-and-pending-references.md) e o [mapa de evidências](../evidence.md).

## Evidências de aplicação — revisão 0.4, 27/10/2026

O estado anterior 0.3 acima registra o aceite documental. Na etapa seguinte autorizada,
[WagerTransaction](../../src/modules/financial/domain/wagering/wager-transaction.ts) implementa
as políticas de contexto, tipo, estado, magnitude, direção e reserva de reversão.
[ResumePendingTransaction](../../src/modules/financial/application/use-cases/resume-pending-transaction.ts)
relê a pendência sob lock da wallet, respeita nextAttemptAt e impede reaplicação.
A [migration 002](../../src/modules/financial/infrastructure/persistence/migrations/Migration202610270002.ts)
persiste prazo, tentativas, motivo e próximo instante, com proteções de imutabilidade.

[Domínio](../../src/modules/financial/domain/wagering/wager-transaction.test.ts) e
[integração real](../../tests/integration/financial-use-cases.test.ts) comprovam:
REFUND; ROLLBACK com direção inversa; replay sem novo efeito; insuficiência específica;
contexto/tipo/estado/amount inválidos; WIN com amount diferente e LOSS zero;
pendência antes da BET, retomada única e expiração; prazo não prorrogado e evento
PendingReference sem repetição. O teste de limite usa relógio/política injetados.
REFUND/ROLLBACK disputam a BET em processos independentes: uma efetivada, outra
REFERENCE_ALREADY_REVERSED. ROLLBACK de REFUND não libera a BET original.
A disponibilidade da referência tem precedência sobre expiração no domínio.

Suíte total: 412 aprovados, zero falhas; 342 unitários e 70 de integração, com
reconciliação SQL. A retomada concorrente foi testada em contextos reais na mesma
instância; o harness multiprocesso cobre disputa das reversões. Ainda não há loop
agendador, prova de reinício do scheduler, origem SQS, FAILED permanente ou tarefa
DLQ tardia. REV-020/021 e aspectos de transporte/recuperação continuam pendentes.

## Origem SQS e encaminhamento tardio comprovados — 27/10/2026

A SPEC-005 revisão 0.4 implementou a origem canônica antes do ACK da pendência,
inclusive quando esta nasceu por HTTP. A migration 003 cria a tarefa tardia na
mesma transição SQL para FAILED e reverte o terminal se a tarefa não puder ser salva.
Os testes preparam essa transição pelas portas em banco isolado; outro processo
despacha o corpo original com a fila de origem vazia. O agendador automático e o
caso de uso de classificação/recuperação de FAILED ainda não foram implementados.
Isso complementa a prova de REV-020/021 no limite de persistência/transporte, sem
considerar verificados todos os caminhos financeiros de falha permanente.

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
