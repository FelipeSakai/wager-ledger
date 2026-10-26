# Wager Ledger

Processador distribuído de transações de apostas, desenvolvido a partir do
[desafio técnico](https://github.com/junglegaming/backend-challenge).

## Estado atual

Base inicial executável com Bun, NestJS e TypeScript em modo estrito.
`GET /` retorna `{ "name": "wager-ledger", "status": "bootstrap" }`.

O endpoint inicial apenas identifica a aplicação. Não verifica dependências externas.

## Requisitos

- Bun 1.4.4 (ou versão 1.x compatível).

## Executar

```sh
bun install --frozen-lockfile
```

Copie `.env.example` para `.env` e ajuste a porta se necessário.
Bun carrega o arquivo `.env` automaticamente.

```sh
bun run dev
```

Acesse `http://localhost:3000` (ou a porta configurada em `PORT`).

## Validação e build

```sh
bun run typecheck
bun run build
bun run start:prod
```

`bun run start` executa o código fonte sem observar alterações.
O build usa o compilador TypeScript com suporte aos decorators do NestJS.

## Escopo planejado

A stack aprovada inclui MikroORM. As próximas etapas serão definidas em conjunto:

- PostgreSQL, migrations reversíveis e Docker Compose;
- SQS com LocalStack ou MiniStack;
- carteiras, precisão monetária e ledger imutável;
- idempotência persistente, concorrência, inbox e outbox;
- testes de domínio, integração e múltiplas instâncias;
- observabilidade e documentação das decisões em `ARCHITECTURE.md`.

Esses recursos ainda não estão implementados. Não há integração com banco,
mensageria, autenticação ou processamento de transações nesta base inicial.
