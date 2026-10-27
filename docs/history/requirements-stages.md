# Histórico das evidências de requisitos

Estes resultados descrevem as etapas datadas. A matriz atual está em [requirements](../requirements.md).

Evidência de Money (27/10/2026): [implementação](../../src/modules/financial/domain/money/money.ts), [erros](../../src/modules/financial/domain/money/money-error.ts) e [testes](../../src/modules/financial/domain/money/money.test.ts), sobre a base 44710c3 com alterações locais. Bun 1.4.4, TypeScript 5.9.3 e Decimal.js 10.6.0; `bun install --frozen-lockfile`, `bun run test:unit` (128 aprovados/0 falhas), `bun run typecheck` e `bun run build` concluídos. As evidências são unitárias; nenhum saldo persistido, mapper ORM ou contrato HTTP/SQS foi validado nesta etapa.


Evidência subsequente de Wallet/ledger (27/10/2026): [Wallet](../../src/modules/financial/domain/wallet/wallet.ts), [WalletLedgerEntry](../../src/modules/financial/domain/wallet/wallet-ledger-entry.ts), [erros](../../src/modules/financial/domain/wallet/wallet-error.ts), [testes de Wallet](../../src/modules/financial/domain/wallet/wallet.test.ts) e [testes de ledger](../../src/modules/financial/domain/wallet/wallet-ledger-entry.test.ts), na mesma base com alterações locais. `bun run test:unit` concluiu 277 testes/zero falhas/797 asserções, sendo 149 testes novos e os 128 de Money; typecheck/build concluídos. Os testes referenciam aspectos de domínio de 17 cenários WAL. Naquela etapa SQL e transportes ainda estavam pendentes; as evidências da etapa subsequente estão abaixo.


Evidência subsequente de persistência (27/10/2026): [suite real](../../tests/integration/financial-persistence.test.ts), [harness de processos](../../tests/support/wallet-race-worker.ts), [unidade de trabalho](../../src/modules/financial/infrastructure/persistence/mikro-financial-unit-of-work.ts) e [migration SQL](../../src/modules/financial/infrastructure/persistence/migrations/financial-schema.ts). MikroORM 7.2.5 e PostgreSQL 17.11 arm64; instalação congelada, typecheck e build concluídos. `bun run test` aprovou 315 testes/zero falhas/1.041 asserções, sendo 38 de integração e 277 unitários. Bootstrap vazio das roles verificado em container temporário; up/down/up em banco descartável. WAL-038–WAL-040 comprovam flushes separados e commit único/rollback; três processos provam lock por wallet e avanço independente. Os testes reconciliam saldo/ledger por SQL. O adaptador recebe intenções montadas pelas fixtures: não há caso de uso de produção, hash canônico, replay, inbox, publisher ou HTTP financeiro. REV-D01 tem prova sequencial de índice; sua disputa concorrente permanece pendente.


Evidência subsequente de aplicação (27/10/2026): [OpenWallet](../../src/modules/financial/application/use-cases/open-wallet.ts), [ProcessTransaction](../../src/modules/financial/application/use-cases/process-transaction.ts), [ResumePendingTransaction](../../src/modules/financial/application/use-cases/resume-pending-transaction.ts), [WagerTransaction](../../src/modules/financial/domain/wagering/wager-transaction.ts), [IntegrationEvent/classes](../../src/modules/financial/application/events/financial-events.ts) e [suite real](../../tests/integration/financial-use-cases.test.ts). A suíte total aprovou 412 testes, zero falhas e 1.427 asserções (342 unitários + 70 de integração). Comprova hash/replay/conflitos, abertura, operações/reversões, referências pendentes, eventos atômicos, 50 reenvios com três processos sobrepostos, retry após timeout e migration com histórico existente. Mesmas versões Bun/PostgreSQL/MikroORM da etapa anterior; instalação congelada/typecheck/build passaram. Os limites anteriores descrevem a evidência de cada etapa histórica. O escopo daquela etapa ainda não cobria HTTP/SQS, inbox, scheduler automático, publisher, recuperação de FAILED/DLQ, consultas de produto ou observabilidade.


Evidência subsequente de API/consultas (27/10/2026): [controller](../../src/modules/financial/presentation/http/financial.controller.ts), [bootstrap](../../src/bootstrap/http-application.ts), [queries](../../src/modules/financial/application/queries/financial-queries.ts), [store SQL](../../src/modules/financial/infrastructure/queries/mikro-financial-read-store.ts) e [cursor](../../src/modules/financial/infrastructure/queries/hmac-ledger-cursor.ts). [HTTP real](../../tests/integration/financial-http.test.ts), [snapshots/diagnóstico](../../tests/integration/financial-queries.test.ts) e [cursor unitário](../../tests/unit/ledger-cursor.test.ts) passaram. Suíte completa: 459 aprovados, zero falhas, 1.653 asserções (354 unitários + 105 de integração), nas mesmas versões Bun 1.4.4/MikroORM 7.2.5/PostgreSQL 17.11. Instalação congelada/typecheck/build concluídos. Cursor funciona em outro Nest app com a mesma chave. Barreira confirma movimentação entre leitura da wallet e soma sem falso positivo. Fixtures descartáveis comprovam divergência finita/fora de Money/NaN e resposta segura, sem reparo. ProviderIdentityPort foi ligada ao guard com implementação local sem autenticar. Logs/counters locais existem; IdP, métricas exportadas, health real, SQS/inbox, publisher e scheduler permanecem pendentes. Evidências anteriores registram o limite histórico de cada etapa.


Evidência subsequente de SQS/inbox/DLQ (27/10/2026): [handler](../../src/modules/financial/presentation/sqs/handle-sqs-delivery.ts), [consumidor](../../src/modules/financial/presentation/sqs/sqs-consumer.ts), [adapter SQS](../../src/modules/financial/infrastructure/messaging/aws-sqs-transport.ts), [dispatcher](../../src/modules/financial/application/use-cases/dispatch-dlq.ts), [store operacional](../../src/modules/financial/infrastructure/messaging/mikro-sqs-recovery-store.ts) e [migration 003](../../src/modules/financial/infrastructure/persistence/migrations/Migration202610270003.ts). A [suite real](../../tests/integration/financial-sqs.test.ts) usa bancos e filas UUID descartáveis. Suíte completa: 502 aprovados/zero falhas/1.808 asserções (374 unitários + 128 de integração), incluindo crash em barreira após commit, SIGTERM, três consumidores, heartbeat/redrive, corrida HTTP/SQS e dispatcher tardio iniciado em outro processo com fila de origem vazia. Bun 1.4.4, MikroORM 7.2.5, PostgreSQL 17.11, LocalStack 4.0.3 e SDK SQS 3.1157.0 fixados; instalação congelada/typecheck/build concluídos. A transição FAILED é preparada pelas portas no harness para provar atomicidade; não há classificação/recuperação financeira automática nem agendador de referência. O publisher de eventos financeiros também continua pendente. As evidências anteriores preservam os limites históricos de cada etapa.


Evidência subsequente do publisher (27/10/2026): [caso de uso](../../src/modules/financial/application/use-cases/publish-outbox.ts), [store](../../src/modules/financial/infrastructure/events/mikro-financial-outbox-store.ts), [validação](../../src/modules/financial/application/events/outbox-envelope.ts), [transporte](../../src/modules/financial/infrastructure/events/sqs-event-publication.ts), [migration 004](../../src/modules/financial/infrastructure/persistence/migrations/Migration202610270004.ts) e [entrypoint](../../src/bootstrap/outbox-worker.ts). A [suite de publicação](../../tests/integration/financial-outbox.test.ts) e [processos](../../tests/support/outbox-race-worker.ts) comprovam dois publishers independentes, ausência de claim antes do commit, SIGKILL antes/depois do envio, lease/fencing/heartbeat, dez falhas reais SQS, suspensão/retomada auditada e SIGTERM. [Consumidor persistente de teste](../../tests/support/event-test-consumer.ts) deduplica IDs e mantém a versão mais nova da projeção; não é consumidor de produção. Suíte completa: 537 aprovados/zero falhas/1.947 asserções (394 unitários + 143 de integração). Instalação congelada/typecheck/build passaram, sem dependências novas. Mesmas versões Bun 1.4.4/MikroORM 7.2.5/PostgreSQL 17.11/LocalStack 4.0.3/SDK SQS 3.1157.0. Scheduler de referências, recuperação automática de FAILED, IdP, health real e observabilidade completa permanecem pendentes. As evidências anteriores registram limites históricos de cada etapa.


## Evidência do agendador e recuperação segura — 27/10/2026

[SchedulePendingReferences](../../src/modules/financial/application/use-cases/schedule-pending-references.ts),
[ResumePendingTransaction](../../src/modules/financial/application/use-cases/resume-pending-transaction.ts),
[store](../../src/modules/financial/infrastructure/references/mikro-pending-reference-store.ts),
[worker](../../src/bootstrap/reference-worker.ts) e
[migration 005](../../src/modules/financial/infrastructure/persistence/migrations/Migration202610270005.ts).
A [suite real](../../tests/integration/financial-references.test.ts) cobre 19 cenários
adicionais: três processos, avanços de outra wallet, referência ausente/disponível,
TTL, restart, SIGKILL antes/depois de commit, SIGTERM, rollback perdido, commit
confirmado com resposta indisponível, corrupção de referência/pendência, ausência
de efeito antes de FAILED, terminal concorrente e referência reparada. Diagnóstico
HTTP-only e tarefa SQS após ACK são atômicos; negar qualquer escrita reverte tudo.
Outro dispatcher envia o corpo original após crash, sem redelivery. Fixtures de
corrupção e término de backend ficam limitados aos bancos UUID dos testes.

A classificação financeira atual cobre apenas INVALID_REFERENCE_STATE. Não há
reparo automático de dados nem FAILED por suposição em erro desconhecido/commit
incerto. 565 testes/zero falhas/2.100 asserções (403 unitários + 162 integrações), nas
mesmas versões anteriores. Evidências anteriores acima são históricas. Health,
IdP e observabilidade completa continuam pendentes; sem commit/push/deploy.


## Evidência de health e observabilidade — 27/10/2026

[Porta](../../src/modules/financial/application/ports/financial-telemetry.ts),
[registro/logs](../../src/modules/financial/infrastructure/observability/operational-telemetry.ts),
[probes](../../src/modules/financial/infrastructure/observability/dependency-probes.ts),
[serviço operacional](../../src/platform/observability/operational-service.ts),
[API](../../src/bootstrap/http-application.ts) e
[workers](../../src/bootstrap/worker-operations.ts). [Unidade](../../tests/unit/operational-telemetry.test.ts)
e [integração real](../../tests/integration/financial-observability.test.ts) acrescentam
25 testes: concorrência/correlação, counters após commit, replay/inbox/DLQ, falha de
sink, indisponibilidade SQL/SQS, preservação de backlog e SIGTERM de processo HTTP
com lock real. A instrumentação financeira não captura quantidade monetária ou corpo;
telemetria falha sem mudar o resultado confirmado. Live não depende de infraestrutura.

590 testes/zero falhas/2.224 asserções (413 unitários + 177 integrações); instalação
congelada, typecheck e build passaram. Mismatches/locks/retries/envios e backlog são
exportados em texto Prometheus por processo, sem IDs como labels. Gauges SQL repetem
o banco; não somar entre papéis. Probes têm timeout e sinalização de erro/idade da
última observação. Sem prometheus server, Grafana, tracing, carga, IdP ou AWS.
Compose continua apenas com PostgreSQL/LocalStack; quatro papéis Bun separados
foram iniciados e sondados. Nenhum commit/push nesta etapa. Evidências acima são históricas.

## Revisão final e ensaio de instalação — 27/10/2026

A [revisão de entrega](../delivery.md) validou uma cópia sem .env, node_modules e dist:
instalação pelo lockfile, nova chave local, typecheck, build e 590 testes aprovados
(0 falhas; 2.224 asserções). Foi corrigida a assinatura de getHttpServer no bootstrap
HTTP para compatibilidade com os tipos instalados. O teste existente de SIGTERM
passou na suíte completa. Guias atuais foram corrigidos; nenhuma regra financeira,
migration ou dependência mudou. Containers existentes foram reutilizados; não se
declara instalação Docker em máquina nova. Sem commit/push.

## Organização e fronteiras verificadas — 27/10/2026

O [ADR 0004](../adr/0004-module-boundaries-and-layout.md) registra domínio por conceito,
eventos/coordenação compartilhada na aplicação, adaptadores financeiros no módulo e
configuração no bootstrap. A plataforma não importa o módulo financeiro.
[Check de arquitetura](../../scripts/check-architecture.ts) e
[testes de violações](../../tests/unit/architecture-rules.test.ts) protegem as fronteiras
e detectam ciclos incluindo imports de tipo. Typecheck inclui esse check.

O domínio não conhece httpStatus; a apresentação traduz o estado.
[Decoder](../../src/modules/financial/infrastructure/persistence/stored-wager-result.ts)
e [testes](../../tests/unit/stored-wager-result.test.ts) validam o formato legado.
O novo cenário real de financial-use-cases.test.ts semeia o formato anterior na
fronteira de persistência, modifica a wallet e comprova replay histórico sem
reescrever os resultados legados. Registros novos não incluem o campo HTTP.

610 testes aprovados, zero falhas, 2.276 asserções (432 unitários + 178 integrações),
em 21 arquivos. Typecheck/check de arquitetura/build passaram. Migrations conservam
nome e conteúdo SQL; não houve alteração de schema, dependências ou regras de negócio.
