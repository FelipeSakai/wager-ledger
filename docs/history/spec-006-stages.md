# Histórico da SPEC-006

Este arquivo preserva evidências por etapa; alegações de pendência valem para a data do recorte.
Consulte o [contrato atual](../specs/006-outbox-and-events.md) e o [mapa de evidências](../evidence.md).

## Evidência incremental — revisão 0.2, 27/10/2026

Na etapa de abertura/processamento autorizada, EVT-D01/D02 foram aplicados ao
recorte de emissão. [IntegrationEvent e quatro classes](../../src/modules/financial/application/events/financial-events.ts)
usam factories, versão 1 e snapshots defensivos. O
[produtor da aplicação](../../src/modules/financial/application/events/financial-outbox.ts)
cria os envelopes com correlationId e IDs do runtime, no mesmo commit financeiro.
Replays/reagendamentos não recriam fatos. Os metadados do futuro worker/SQS,
causationId e o publisher EVT-D03 ainda precisam de integração própria.

[Testes de classes](../../tests/unit/financial-events.test.ts) cobrem serialização,
MoneyProps e imutabilidade. [Integração](../../tests/integration/financial-use-cases.test.ts)
comprova abertura zero/positiva, LOSS/rejeição, rollback após flush, resultado
pendente/conclusão e 50 replays sem fatos adicionais. EVT-009/010/011 e o aspecto
SQL de EVT-001/014 têm evidência. A suíte completa passou com 412 testes e zero
falhas. Não há prova de publicação, consumo, fencing, lease, crash após envio ou
shutdown: EVT-002–EVT-008/012/013 continuam pendentes conforme o roteiro.

## Evidências de publicação — revisão 0.3, 27/10/2026

[PublishOutbox](../../src/modules/financial/application/use-cases/publish-outbox.ts)
coordena [portas de store/transporte](../../src/modules/financial/application/ports/financial-outbox-store.ts),
sem SDK/ORM na aplicação. O [store MikroORM](../../src/modules/financial/infrastructure/events/mikro-financial-outbox-store.ts)
usa claims curtos com SKIP LOCKED e token/lease por evento. Todos os claims do lote
iniciam imediatamente sob concorrência limitada ao próprio lote (máximo 10); há
renovação enquanto o envio está em andamento. Posse é verificada antes de enviar,
e confirmação/falha/release são condicionados à posse vigente. Um erro de banco
mantém o evento recuperável em vez de afirmar publicação.

O [adapter de saída](../../src/modules/financial/infrastructure/events/sqs-event-publication.ts)
reutiliza o SDK com timeout de 5 s. A
[validação de envelope](../../src/modules/financial/application/events/outbox-envelope.ts)
verifica metadados, tipo/versão e MoneyProps antes de serializar o payload persistido,
sem recalcular saldo ou reconstruir fato novo. Envelope inválido suspende com
INVALID_EVENT_ENVELOPE; falha de envio persiste SQS_SEND_FAILED, attempts/nextAttemptAt.

A [migration 004](../../src/modules/financial/infrastructure/persistence/migrations/Migration202610270004.ts)
acrescenta lastErrorCode, constraints de claim/datas, imutabilidade de publicação
confirmada e outbox_resume_audit. Evento novo nasce não publicado/não claimed.
Confirmar sem claim válido ou reabrir publicado é recusado; payload original segue
imutável. [Comando operacional](../../scripts/outbox-recovery.ts) inspeciona metadados
ou retoma um evento suspenso com operador/horário e identidade preservada.
O [worker](../../src/bootstrap/outbox-worker.ts) tem processo/loop/shutdown próprios.

Ambiente: Bun 1.4.4, PostgreSQL 17.11, MikroORM 7.2.5, LocalStack 4.0.3 e SDK SQS
3.1157.0, sem novas dependências nesta etapa. Base 44710c3 com mudanças locais.
Suíte completa: 537 aprovados/zero falhas/1.947 asserções (394 unitários + 143 de
integração); instalação congelada, typecheck e build passaram.

[Testes de publicação reais](../../tests/integration/financial-outbox.test.ts),
[unidade/contratos](../../tests/unit/outbox-publisher.test.ts),
[processo de publisher](../../tests/support/outbox-race-worker.ts) e
[consumidor de teste persistente](../../tests/support/event-test-consumer.ts).

| Cenários | Evidência executada |
|---|---|
| EVT-001 | Barreira após flush mantém unidade financeira aberta; publisher não pode claimar; rollback não envia |
| EVT-002 | Eventos confirmados sobrevivem ao SIGKILL do publisher antes do envio; outro processo retoma após lease |
| EVT-003 | Dois processos com PIDs/pools distintos: um mantém seu claim enquanto o outro publica os demais, sem sobreposição |
| EVT-004 | SIGKILL depois de aceitação SQS e antes da confirmação SQL; retry em novo processo usa mesma identidade; inbox persistente de teste recusa duplicata forçada |
| EVT-005 | Claim expirado/reclamado por outro contexto invalida token antigo para confirmação, renovação e registro de falha |
| EVT-006/EVT-007 | Dez falhas SQS reais contra destino inexistente persistem tentativas e suspensão; log/counter sem publishedAt falso |
| EVT-008 | Retomada individual com operador auditado publica mesmo eventId/payload |
| EVT-009–EVT-011 | Abertura zero/positiva, LOSS, rejeição, pendência/conclusão e replay mantêm matriz e identidades dos eventos |
| EVT-012 | Projeção de teste recebe versões fora de ordem e duplicatas; só versão mais nova altera seu saldo textual |
| EVT-013 | SIGTERM drena envio admitido; restante retoma; stop durante aquisição libera lote não enviado |
| EVT-014 | Role de aplicação não reescreve payload/apaga evento; sem claim não confirma e publicado não reabre |

Os testes forçam uma entrega duplicada com outro deduplicationId para avaliar a
inbox independentemente da janela FIFO; não aguardam cinco minutos reais. A projeção
com inbox é um artefato de teste em banco descartável, não um novo consumidor de
produção. A falha entre envio/confirmação é provocada em barreira com SIGKILL, e a
retomada usa lease vencido observado no banco. Renovação lenta também foi comprovada.

Logs JSON e counters locais não equivalem a endpoint de métricas/alerta externo.
CausationId é opcional no contrato e não foi adicionado aos produtores nesta etapa.
SDK/filas foram exercitados no LocalStack, sem deploy AWS. Não há limpeza automática
nem ordem estrita por wallet. Agendador de referências, recuperação automática de
FAILED, IdP, health e observabilidade completa seguem em etapas próprias.
