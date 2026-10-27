# Demonstração técnica — 15 a 20 minutos

## Preparação

Na raiz, com Bun 1.4.4 e Docker Compose:

```sh
bun install --frozen-lockfile
bun run setup
bun run format:check
bun run typecheck
bun run build
```

Execute API e workers em quatro terminais, conforme o [README](../README.md).
O setup preserva volumes e configuração. Testes criam bancos/filas próprios;
não exigem API/workers permanentes. Nunca editar/corromper dados reais para demonstrar falha.

## Sequência

| Tempo | Demonstração | Evidência |
|---|---|---|
| 2 min | Diagrama e commit financeiro comum | ARCHITECTURE.md |
| 3 min | Abertura, BET, WIN, replay e reconciliação | examples/requests.http |
| 4 min | 50 duplicatas, três PIDs e disputa de saldo | Casos de uso/PROC-011/012 |
| 4 min | Crash, redelivery e DLQ tardia | SQS/outbox/referências |
| 3 min | Shutdown, logs, métricas e limites | Health e suites operacionais |

Nos [exemplos HTTP](../examples/requests.http), abra 100.00 BRL, copie walletId,
aposte 25.00 e credite WIN de 10.00. Repetir a BET retorna seu saldo histórico 75.00;
GET da wallet retorna 85.00. Reconciliação deve retornar consistent=true e diferença zero.
O [envelope SQS](../examples/sqs-bet.json) reutiliza a identidade da BET para provar
replay entre canais. Ajuste walletId/playerId e use `bun run sqs:send`.

## Alternativa interativa: Swagger

Abra [Swagger UI](http://127.0.0.1:3001/docs) com a API em execução. Use Try it out
para criar a wallet, copie id/playerId para o exemplo BET e preencha Idempotency-Key.
Troque o exemplo para WIN/LOSS/reversões e atualize a key junto com o ID externo.
Repetir corpo/key da BET demonstra replay histórico; consultar a wallet mostra saldo atual.
Finalize pelo endpoint de reconciliação com body {}. O contrato JSON está em /docs-json.

## Comandos de prova

```sh
# Contrato OpenAPI, assets locais e execução dos exemplos documentados
bun test --timeout 30000 tests/integration/financial-openapi.test.ts

# Contratos HTTP, cursor e reconciliação
bun test --timeout 30000 tests/integration/financial-http.test.ts

# Cinquenta duplicatas / três processos / disputa 80.00 sobre 100.00
bun test --timeout 30000 tests/integration/financial-use-cases.test.ts -t 'PROC-011|PROC-012|REV-005'

# PostgreSQL confirma COMMIT, a resposta TCP se perde e o replay recupera o resultado
bun test --timeout 30000 tests/integration/financial-commit-loss.test.ts

# Heartbeat falha, há dois recebimentos e só um débito
bun test --timeout 30000 tests/integration/financial-sqs.test.ts -t 'SQS-017'

# Crash antes/depois de enviar a DLQ tardia; outro processo retoma
bun test --timeout 30000 tests/integration/financial-references.test.ts -t 'SQS-025'

# EntryPoints reais: limpeza normal, travada e falha com recurso aberto
bun test --timeout 30000 tests/integration/financial-worker-lifecycle.test.ts

# Dois publishers / crash após envio / fencing e consumidor de teste
bun test --timeout 30000 tests/integration/financial-outbox.test.ts

# Correlação até ACK, readiness, métricas e SIGTERM HTTP
bun test --timeout 30000 tests/integration/financial-observability.test.ts
```

PROC-017 usa um proxy TCP exclusivo de teste: observa COMMIT real do servidor e
interrompe sua resposta. Outra conexão confirma o estado durável e o reenvio
preserva efeito único, inbox e saldo histórico. Essa prova não envia mensagens SQS.

SQS-017 usa expiração/redelivery reais e dois backends esperando o lock no PostgreSQL.
SQS-025 mata o dispatcher em barreiras de envio real e espera a expiração do lease;
a retomada conserva task/transferId/corpo. Deduplicação do broker pode suprimir uma
segunda mensagem; não se promete exatamente uma entrega.

Os testes de deadline executam os três entrypoints reais com um preload exclusivo
do harness que trava ou falha na limpeza com recurso aberto. Produção não possui flags de simulação.
Todos os cenários financeiros conferem saldo reconstruído pelo ledger.

## Operação e encerramento

```sh
curl --fail http://127.0.0.1:3001/health/ready
curl --fail http://127.0.0.1:3001/metrics
bun run outbox:inspect
bun run dlq:inspect
bun run references:failures
```

Inspeções retornam metadados; não imprimir corpo ou credenciais. Métricas têm contexto
por processo, sem IDs nas labels. Não somar gauges SQL repetidos entre papéis.
Ctrl+C/SIGTERM para admissões, drena e fecha recursos com limite. Prazo excedido termina
com código 1 e deixa responsabilidade durável para retomada, sem ACK especulativo.

Para parar dependências preservando volumes: `docker compose stop`.

## Perguntas para defender

- Por que lock na wallet permite outras carteiras avançarem?
- Qual índice/trigger protege cada invariante se outro processo gravar diretamente?
- Como diferenciar replay, conflito, rejeição e commit com resultado incerto?
- O que fica durável antes de ACK e antes de publicar?
- Por que o consumidor precisa deduplicar eventos mesmo com FIFO?
- O que acontece se SIGTERM chegar enquanto uma dependência não fecha?
- Por que auth adiada e LocalStack não equivalem a exposição segura/AWS validada?

Os critérios, testes e resultados estão no [mapa de evidências](evidence.md).
A execução hospedada deve corresponder ao SHA entregue; consulte as
[execuções do workflow](https://github.com/FelipeSakai/wager-ledger/actions/workflows/ci.yml).
