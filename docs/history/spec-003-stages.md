# Histórico da SPEC-003

Este arquivo preserva evidências por etapa; alegações de pendência valem para a data do recorte.
Consulte o [contrato atual](../specs/003-wager-processing-and-idempotency.md) e o [mapa de evidências](../evidence.md).

## Evidências executadas — 27/10/2026

[WagerTransaction](../../src/modules/financial/domain/wagering/wager-transaction.ts),
[ProcessTransaction](../../src/modules/financial/application/use-cases/process-transaction.ts),
[validação/JSON canônico](../../src/modules/financial/application/transactions/transaction-command.ts),
[política](../../src/modules/financial/application/financial-policy.ts) e
[retry](../../src/modules/financial/application/financial-retry.ts).

Testes: [domínio](../../src/modules/financial/domain/wagering/wager-transaction.test.ts),
[contrato de hash](../../tests/unit/transaction-command.test.ts),
[integração](../../tests/integration/financial-use-cases.test.ts) e
[harness multiprocesso](../../tests/support/use-case-race-worker.ts).

Ambiente Bun 1.4.4, PostgreSQL 17.11, MikroORM 7.2.5, base 44710c3 com mudanças locais.
Suíte completa: 412 testes aprovados/zero falhas/1.427 asserções, sendo 342 unitários
e 70 de integração. Instalação congelada, typecheck e build concluídos.

| Cenários / recorte | Evidência real |
|---|---|
| PROC-001–PROC-005 | BET/WIN/LOSS, magnitude auditável e replay conservando saldo histórico após outra operação |
| PROC-006–PROC-009/PROC-019 | Conflitos por key/identidade, provider distinto, wallet inexistente; JSON/hash esperado fixado e independente da ordem de campos |
| PROC-010 | Validação do comando, inclusive campos internos e referência null; header/HTTP ainda pendentes |
| PROC-011 | 50 reenvios por três processos com PIDs distintos e barreira; PostgreSQL observa os três esperando pelo lock; um débito e 49 replays |
| PROC-012 | Processos reais: duas BET 80.00 em 100.00 resultam em PROCESSED/REJECTED e 20.00 |
| PROC-014/PROC-015 | Injeção de falha após flush real reverte registros; terminais imutáveis no domínio/schema; inbox ainda ausente |
| PROC-016/PROC-017 | Lock timeout real seguido de sucesso em contexto novo; esgotamento retorna indisponível sem FAILED fictício; outros erros não viram rejeição |
| PROC-018 | Referências opcionais validadas, espera persistida e retomada por caso de uso; ver SPEC-004 |
| PROC-021–PROC-023 | Overflow do saldo rejeitado e reproduzível; amount acima de MAX recusado antes de admitir identidade |

A aplicação cria PENDING em memória dentro da unidade SQL e insere o resultado
final/pendência. A unicidade é confirmada ao gravar; colisão global desfaz a unidade
inteira antes de uma nova consulta, descartando os objetos locais. Não há commit
intermediário de reserva nem publicação. São três tentativas no máximo, com orçamento
conferido antes de repetir e timeouts SQL por tentativa; não se promete deadline
absoluto de rede. Serialização/deadlock são classificados, mas a injeção real de
deadlock ainda não foi demonstrada. PROC-013/024/025, commit incerto com desconexão,
recuperação permanente e todos os aspectos de ACK/inbox/transporte seguem pendentes.

## Evidência subsequente de HTTP — 27/10/2026

O [controller](../../src/modules/financial/presentation/http/financial.controller.ts)
chama ProcessTransaction sem reproduzir regras. O resultado persistido escolhe o
status HTTP e httpStatus não é serializado no payload; correlação UUID é retornada
no envelope/header. O [filtro](../../src/modules/financial/presentation/http/financial-exception-filter.ts)
traduz entrada/conflito/ausência/indisponibilidade e protege falhas internas.
[Testes HTTP reais](../../tests/integration/financial-http.test.ts) comprovam
200/422/202, replay histórico, key obrigatória, conflitos, campos internos/money
inválidos, JSON malformado, limite de body de 32 KiB e 503 por lock timeout real.
Dez reenvios HTTP concorrentes geram um movimento. GET de REJECTED/PENDING_REFERENCE/
FAILED usa 200, sem confundir consulta com replay; FAILED é fixture administrativa,
sem afirmar recuperação de produção. A suíte total aprovou 459 testes/zero falhas,
1.653 asserções; typecheck/build/instalação congelada passaram. SQS/inbox, commit
incerto com desconexão e recuperação permanente/FAILED/DLQ continuam pendentes.

## Integração SQS subsequente — 27/10/2026

ProcessTransaction agora recebe uma entrega validada opcional para registrar inbox
no mesmo contexto SQL, sem alterar seu contrato financeiro HTTP. Verificações de
identidade/envelope precedem efeitos; replay SQS bloqueia/reconsulta a wallet antes
de associar inbox/origem e conferir o estado corrente. A SPEC-005 revisão 0.4 registra
as provas de commit/ACK/redelivery e DLQ. Uma corrida HTTP/TCP + SQS gera o mesmo
transactionId e um débito. A suíte total tem 502 aprovados/zero falhas/1.808 asserções.
A classificação/recuperação segura de FAILED continua pendente: os testes preparam
transições pelas portas para provar atomicidade do encaminhamento tardio, sem
inventar um algoritmo automático de recuperação nem marcar falhas desconhecidas.

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

## Organização e compatibilidade — revisão 0.6, 27/10/2026

Etapa autorizada move os tipos/estado para domain/wagering e a coordenação
compartilhada para application/transactions. O adaptador stored-wager-result lê
o httpStatus legado, valida sua coerência e o remove do estado de negócio.
Resultados terminais antigos não são reescritos; replay mantém saldo e estado
históricos e a apresentação devolve os mesmos status HTTP. Novos resultados
persistidos são neutros em relação ao transporte. Nenhuma alteração de hash,
identidade ou regra monetária. Provas em stored-wager-result.test.ts e no cenário
legado PostgreSQL de financial-use-cases.test.ts; 610 testes totais aprovados.
