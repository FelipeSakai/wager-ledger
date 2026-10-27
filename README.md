# Wager Ledger

Processador distribuído de transações de apostas com controle de carteiras,
ledger imutável e processamento idempotente de operações financeiras.

## Estado atual

Base inicial executável com Bun, NestJS e TypeScript em modo estrito.
`GET /` retorna `{ "name": "wager-ledger", "status": "bootstrap" }`.

O endpoint inicial apenas identifica a aplicação. Não verifica dependências externas.

A arquitetura alvo está definida e documentada. As garantias financeiras e a
infraestrutura descritas nos documentos ainda dependem de implementação e testes.

A [SPEC-001 — Money](docs/specs/001-money.md) está aprovada na revisão 1.0.
Ela define o contrato monetário do domínio; sua implementação ainda não foi iniciada.

A [SPEC-002 — Wallet, abertura e ledger](docs/specs/002-wallet-and-ledger.md)
está aprovada na revisão 1.0, com contratos e estratégia de persistência definidos.
Sua implementação e as evidências de teste ainda estão pendentes.

As [SPEC-003 a SPEC-008](docs/specs/README.md) também estão redigidas, como rascunhos
com contratos recomendados, cenários de aceite, parâmetros operacionais e opcionais
identificados. Sua revisão ocorrerá junto às etapas de implementação autorizadas.

## Documentação do projeto

| Documento | Conteúdo |
|---|---|
| [AGENTS.md](AGENTS.md) | Instruções de trabalho, limites arquiteturais e aprovação por etapa |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Estrutura alvo, diagramas, invariantes, fluxos e limitações |
| [Decisões arquiteturais](docs/adr/README.md) | Contexto, alternativas e consequências das escolhas aprovadas |
| [Rastreabilidade](docs/requirements.md) | Requisitos do produto e critérios de aceite |
| [Especificações](docs/specs/README.md) | Contratos, cenários de aceite e decisões por funcionalidade |
| [Roteiro de demonstração](docs/demo.md) | Validação operacional e cenários de demonstração do sistema |

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

A stack aprovada inclui MikroORM e SQS via LocalStack. O desenho adota monólito
modular com domínio financeiro independente e processos de API/workers compartilhando
os mesmos casos de uso.

Na primeira versão, entradas, saldos, transações, ledger e valores apresentados
pela aplicação serão em BRL. O objeto Money permanece multimoeda, com testes de
conflito BRL/USD. Conversão cambial, cotações externas e visualização em outras
moedas ficam fora desta versão.

As próximas etapas serão definidas em conjunto:

- PostgreSQL, migrations reversíveis e Docker Compose;
- SQS com LocalStack, inbox e publicação por outbox;
- carteiras, precisão monetária e ledger imutável;
- idempotência persistente, concorrência, inbox e outbox;
- testes de domínio, integração e múltiplas instâncias;
- observabilidade e documentação das decisões em `ARCHITECTURE.md`.

Esses recursos ainda não estão implementados. Não há integração com banco,
mensageria, autenticação ou processamento de transações nesta base inicial.
