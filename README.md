# Wager Ledger

Processador de apostas com Bun, NestJS, PostgreSQL/MikroORM e SQS via LocalStack.
HTTP e SQS compartilham o núcleo financeiro; saldo, ledger, transação, inbox e
outbox são confirmados na mesma transação SQL.

## Iniciar localmente

Requisitos: **Bun 1.4.4** e **Docker Compose**. Na raiz do projeto:

```sh
bun install --frozen-lockfile
bun run setup
```

O setup prepara o .env com uma chave local de cursor, PostgreSQL, LocalStack,
migrations e quatro filas. Preserva configuração existente, dados e volumes.
Credenciais do exemplo são exclusivas do ambiente local. Portas de dependências:
PostgreSQL 55439 e LocalStack 4566, ambas em loopback.

Execute cada papel em um terminal separado:

| Papel | Comando | Porta operacional |
|---|---|---:|
| API | `PORT=3001 bun run dev` | 3001 |
| Consumidor de comandos + DLQ | `bun run worker:sqs` | 3101 |
| Publisher da outbox | `bun run worker:outbox` | 3102 |
| Agendador de referências | `bun run worker:references` | 3103 |

Os exemplos deste guia usam a API na porta 3001, definida pelo prefixo `PORT=3001`.
O `.env.example` configura 3000; o prefixo do comando prevalece sobre esse valor.
Para usar outra porta, ajuste PORT e as URLs dos exemplos.

```sh
curl --fail http://127.0.0.1:3001/health/live
curl --fail http://127.0.0.1:3001/health/ready
curl --fail http://127.0.0.1:3001/metrics
```

Os workers oferecem os mesmos três endpoints em suas portas. `GET /` só identifica
a aplicação. Para executar a API compilada: `bun run build` e
`PORT=3001 bun run start:prod`.

## Experimentar a API e o SQS

[Exemplos HTTP](examples/requests.http): abrir wallet com 100.00, apostar 25.00,
creditar WIN de 10.00 e repetir a aposta. O replay preserva 75.00, enquanto a wallet
atual tem 85.00. Copie o ID retornado pela abertura para a variável walletId.
Use novos IDs/chaves quando quiser iniciar outra demonstração.

[Envelope SQS](examples/sqs-bet.json): substitua walletId pelo ID da mesma wallet
HTTP e ajuste playerId se necessário. O exemplo reutiliza a identidade da BET
HTTP para demonstrar deduplicação entre canais:

```sh
bun run sqs:send examples/sqs-bet.json
```

Todo amount é uma string com duas casas; a aplicação usa BRL. Money também modela
USD para provar conflitos de moeda. OPENING é interna. LOSS exige zero e não move
saldo. REFUND/ROLLBACK exigem referência e valor integral; uma referência admite
uma única reversão processada entre os dois tipos.

| Operação HTTP | Rota |
|---|---|
| Abertura e saldo | `POST /wallets`, `GET /wallets/:walletId` |
| Ledger paginado | `GET /wallets/:walletId/ledger?limit=50&cursor=...` |
| Submissão | `POST /wagering/transactions`, com `Idempotency-Key` |
| Consulta de transação | `GET /wagering/transactions/:transactionId` |
| Consulta externa | `GET /providers/:providerId/wagering/transactions/:externalTransactionId` |
| Reconciliação | `POST /wallets/:walletId/reconciliation` |

Submissão distingue 200 processada, 202 pendente, 422 rejeitada, 400 entrada inválida,
409 conflito, 503 indisponibilidade e 500 falha interna. Consultas de recursos
existentes usam 200. Abertura usa 201 e conflito recuperável com walletId no 409.

## Validar

```sh
bun run format:check
bun run typecheck
bun run build
bun test --timeout 30000
```

Typecheck inclui o check de arquitetura. `test:unit` executa somente unitários;
`test:integration` exige PostgreSQL e LocalStack reais. Testes financeiros usam
bancos/filas UUID descartáveis e reconciliam saldo com ledger; removem apenas seus
recursos. A [matriz de evidências](docs/evidence.md) aponta cada critério do desafio,
os testes e o resultado da execução mais recente.

A [CI](.github/workflows/ci.yml) prepara dependências e roda esses checks em
Ubuntu 24.04, com Bun e Actions fixados. O resultado hospedado estará disponível
quando esta revisão for publicada; não se declara uma execução remota ainda inexistente.

Para aplicar a formatação: `bun run format`. Prettier é dependência de desenvolvimento
fixada; migrations históricas ficam fora da reformatação para preservar seu conteúdo.

## Operar e entender

| Documento | Uso |
|---|---|
| [Arquitetura](ARCHITECTURE.md) | Fronteiras, fluxo transacional, decisões e trade-offs |
| [Guia das pastas](src/modules/financial/README.md) | Onde acrescentar regras, casos de uso e adaptadores |
| [Demonstração](docs/demo.md) | Sequência de apresentação e comandos de prova |
| [Operação](docs/operations.md) | Configuração, migrations, métricas e recuperação |
| [Evidências](docs/evidence.md) | Requisitos de avaliação e provas executadas |
| [Specs](docs/specs/README.md) e [ADRs](docs/adr/README.md) | Contratos e justificativas |
| [Histórico](docs/history/README.md) | Evidências dos recortes anteriores |

```sh
bun run outbox:inspect
bun run dlq:inspect
bun run references:failures
```

Retomadas exigem ID e operador; veja o manual. SIGTERM interrompe admissões e drena
trabalho/recursos dentro do orçamento configurado. Para parar as dependências
preservando os volumes: `docker compose stop`. Não usar `down -v` para preparar a demo.

## Limites assumidos

- IdP adiado: ProviderIdentityPort/guard local não autentica. Binds padrão em loopback.
- Entrega at-least-once, sem promessa de exactly-once ou ordem estrita de publicação.
- FAILED automático somente para INVALID_REFERENCE_STATE após recuperação segura.
- Compose executa dependências; API/workers rodam com Bun no host.
- Sem deploy AWS, dashboard, tracing, teste de carga ou consumidor de eventos de produção.
- Métricas são por processo; não somar gauges SQL repetidos entre papéis.
