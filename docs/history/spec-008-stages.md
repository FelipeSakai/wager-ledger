# Histórico da SPEC-008

Este arquivo preserva evidências por etapa; alegações de pendência valem para a data do recorte.
Consulte o [contrato atual](../specs/008-observability-and-health.md) e o [mapa de evidências](../evidence.md).

## Evidências executadas — revisão 0.3, 27/10/2026

Implementação:

- [Porta e isolamento de falhas](../../src/modules/financial/application/ports/financial-telemetry.ts).
- [Logs/catálogo/registro Prometheus](../../src/modules/financial/infrastructure/observability/operational-telemetry.ts).
- [Probes SQL/SQS](../../src/modules/financial/infrastructure/observability/dependency-probes.ts) e [lifecycle/coleta](../../src/platform/observability/operational-service.ts).
- [API](../../src/bootstrap/http-application.ts), [composição dos workers](../../src/bootstrap/worker-operations.ts) e entrypoints existentes.
- [Testes unitários](../../tests/unit/operational-telemetry.test.ts) e [PostgreSQL/LocalStack/HTTP/processo](../../tests/integration/financial-observability.test.ts).

Readiness exige SQL/schema e filas conhecidas: HTTP quatro filas, SQS seu par de
comandos, outbox seu par de eventos; referências exige somente SQL. Cada papel oferece
live/ready/metrics, com loopback padrão. Probes independentes têm deadline de 2 s;
consulta SQL operacional tem statement timeout de 1 s/lock de 250 ms e aquisição
limitada a 2 s. Respostas contêm nomes/estados/causa fixa, sem endereço ou exceção.
Coleta a cada 15 s inclui suspensos, mantém valor/horário anterior na falha e muda
operational_probe_success para zero. Antes do primeiro sucesso não publica zeros
fictícios. SQS conta aproximadamente disponíveis, em voo e atrasadas das DLQs do papel.

Counters de transição são pós-commit; replay e checagem pendente sem mudança não
são nova aplicação. Locks/retries/latência observam tentativas técnicas. IDs nunca
são labels e quantias não viram métricas. Gauges SQL repetem o mesmo banco por papel;
não somá-los entre processos. Counters podem perder observação após crash/reiniciar;
não substituem o ledger. O consumidor de eventos de produção não existe neste recorte.

Logs JSON têm UTC/role/instanceId e IDs aplicáveis; campos/enums são catalogados e
não incluem corpo, valores monetários, chave, receipt, SQL ou segredo. Correlação da
pendência é lida da outbox imutável antes da conclusão. O dispatcher usa metadados
existentes da origem; diagnóstico sem transação não recebe provider/correlação fictícios.
A falha de sink é isolada também após confirmação de publicação e na reconciliação.

| Cenários | Prova real |
|---|---|
| OBS-001/002/003 | HTTP concorrente conserva correlação; logs de envio SQS preservam correlação do evento; abertura sem provider; campos/IDs maliciosos e bodies são excluídos |
| OBS-004/006 | Replay business/inbox separado, rejeição auditável, rollback sem counter financeiro, retry por lock SQL e cardinalidade limitada com 200 IDs distintos |
| OBS-005/013/014 | Suspensos permanecem no backlog; lock de tabela provoca falha real de amostragem, mantendo a última observação; DLQ SQS real tem gauge aproximado e despacho confirmado |
| OBS-007/009 | Negar conexões e terminar backends somente do banco UUID faz ready=503/live=200; fila requerida removida/endpoint SQS indisponível afetam ready; guard que nega tudo não bloqueia health |
| OBS-008 | Novo processo HTTP entra em espera por lock real, recebe SIGTERM e conclui resposta/commit antes de encerrar com código zero; prontidão 503 e bloqueio de novas admissões testados na API |
| OBS-010/011/012 | Setup/roles/migrations e processos de concorrência das etapas anteriores permanecem aprovados; não foi ensaiado Compose com containers de aplicação |

O socket da resposta é capturado antes de finish: acessá-lo depois já pode retornar
null e deixar keep-alive aguardando até o timeout. O encerramento fecha ociosas e
respostas concluídas; não destrói operação financeira admitida. Orçamento padrão
30 s; probes em andamento são encerrados e pools/SDK são fechados no lifecycle.

590 aprovados, zero falhas, 2.224 asserções: 413 unitários e 177 integrações. Bun 1.4.4,
MikroORM 7.2.5, PostgreSQL 17.11, LocalStack 4.0.3. Instalação congelada, typecheck e
build passaram. API e três workers foram reiniciados no ambiente local; live/ready/
metrics responderam 200 nas portas 3001/3101/3102/3103, sem criar operação financeira.
Não foram instalados Prometheus/Grafana/tracing nem feitos carga, IdP ou deploy AWS.
Commit/push não fazem parte desta etapa. O histórico 0.2 acima não é o estado atual.
