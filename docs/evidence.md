# Critérios de avaliação e evidências

A matriz segue as áreas do [desafio oficial](https://github.com/junglegaming/backend-challenge#14-avaliação--100-pontos).
Pesos não são notas atribuídas por nós. Cada linha aponta código/testes para o avaliador.

| Área / peso | Pergunta de revisão | Evidência executável |
|---|---|---|
| Correção financeira / 20 | Saldo, ledger, moeda e reversões permanecem corretos? | [Domínio Money](../src/modules/financial/domain/money/money.test.ts), Wallet/ledger/wagering e [proteções SQL](../tests/integration/financial-persistence.test.ts) |
| Concorrência / 20 | Três processos, 50 duplicatas e disputa por saldo preservam um efeito? | [Casos de uso](../tests/integration/financial-use-cases.test.ts): PROC-011/012, REV-005; [SQS](../tests/integration/financial-sqs.test.ts): SQS-014/017 |
| Idempotência / 15 | Conflito é distinto de replay, inclusive após outras operações/restart? | [Comando/hash](../tests/unit/transaction-command.test.ts), casos de uso, inbox e replay legado PostgreSQL |
| Mensageria e falhas / 15 | Crash antes/depois de ACK/envio e SIGTERM conservam responsabilidades? | [SQS](../tests/integration/financial-sqs.test.ts), [outbox](../tests/integration/financial-outbox.test.ts), [referências](../tests/integration/financial-references.test.ts), [entrypoints](../tests/integration/financial-worker-lifecycle.test.ts) |
| Modelagem e arquitetura / 10 | Camadas e invariantes têm responsabilidades claras? | [Guia do módulo](../src/modules/financial/README.md), [check AST](../scripts/check-architecture.ts), [testes negativos](../tests/unit/architecture-rules.test.ts) |
| Testes / 10 | A prova usa serviços reais e disputa observada? | tests/integration, processos de tests/support, [workflow Linux](../.github/workflows/ci.yml) e comando de validação abaixo |
| Observabilidade / 5 | Logs correlacionam etapas e métricas refletem falhas sem expor dados? | [Observabilidade real](../tests/integration/financial-observability.test.ts), [catálogo/limites](../tests/unit/operational-telemetry.test.ts) |
| Documentação / 5 | Outro desenvolvedor consegue iniciar, verificar e entender limites? | [README](../README.md), [arquitetura](../ARCHITECTURE.md), [operação](operations.md), [exemplos](../examples/requests.http), [ADRs](adr/README.md) |

## Reproduzir

```sh
bun install --frozen-lockfile
bun run setup
bun run format:check
bun run typecheck
bun run build
bun test --timeout 30000
```

A suíte usa bancos/filas UUID e compara saldo com soma exata do ledger. Há provas
com barreiras e processos reais; contagem de testes sozinha não comprova essas garantias.
Os serviços e volumes do operador não são apagados pelo setup nem pelas fixtures.

## Provas acrescentadas após a revisão

| Prova | Resultado exigido |
|---|---|
| Shutdown de três entrypoints reais | Limpeza normal sai 0; limpeza que trava/falha com recurso aberto sai 1 no deadline, inclusive após novo SIGTERM |
| SQS-017: heartbeat falha e visibilidade expira | Mesmo transportMessageId em dois PIDs, receipts diferentes e espera simultânea no PostgreSQL; uma inbox e um débito |
| SQS-025: processo morre antes/depois do envio tardio à DLQ | Lease expira, outro processo confirma a mesma tarefa/transferId, corpo preservado e saldo reconciliado |
| Retry/lock correlacionados | Correlação, wallet e provider percorrem a falha de lock e o retry real |
| Dois grupos SQS | Contextos distintos percorrem lock, transição e ACK com IDs validados |
| PROC-017: resposta de COMMIT perdida em TCP real | Banco confirma; cliente recebe indisponibilidade; nova unidade no mesmo pool recupera um efeito e a mesma inbox, sem duplicar outbox |
| PROC-020: moeda do saldo histórico corrompida | Domínio, GET interno/externo e replay recusam corrupção sem reparar terminais; rejeições legítimas de contexto continuam reidratáveis |
| Estilo e fronteiras | Prettier e check de arquitetura integrados à validação/CI |

Os testes de lifecycle usam preload exclusivo do harness para travar uma dependência;
os entrypoints de produção não interpretam flags de injeção de falha.
SQS-017 injeta falha de renovação no adaptador e usa expiração/redelivery reais do
LocalStack. SQS-025 mata o processo em barreiras do envio SQS real. A deduplicação FIFO
pode suprimir a segunda entrega à DLQ; não se afirma entrega exatamente uma vez.

## Execução registrada

639 testes aprovados, zero falhas e 2.452 asserções em macOS arm64 e Ubuntu 24.04 AMD64
(443 unitários + 196 integrações; 25 arquivos). Formatação, arquitetura, typecheck
e build aprovados. Tempos e condições no [relatório de entrega](delivery.md).
O ensaio Linux local usa cópia sem node_modules, dist ou .env, em Ubuntu 24.04
AMD64 por emulação, com binário oficial Bun 1.4.4 e dependências reais.
Essa execução não é uma execução do GitHub Actions.
O workflow hospedado só terá resultado depois de publicado; não há badge de aprovação
nem alegação de CI remota executada nesta revisão local.

A prova de COMMIT perdido está em
[financial-commit-loss.test.ts](../tests/integration/financial-commit-loss.test.ts),
com [proxy TCP exclusivo de teste](../tests/support/postgres-commit-response-proxy.ts).
A transação é observada por uma conexão independente após o corte da resposta.
Não há throw simulado substituindo COMMIT nem flags de teste no runtime de produção.

## Limites

Sem IdP, deploy AWS, benchmark, dashboard ou consumidor de eventos de produção.
FAILED automático continua restrito a INVALID_REFERENCE_STATE; não é classificação
genérica de qualquer falha. Nem todos os interleavings possíveis foram demonstrados.
As specs definem cenários estáveis; registros de etapas antigas ficam no histórico.
