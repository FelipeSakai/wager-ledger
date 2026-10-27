# Histórico dos ensaios de entrega

Estes são registros anteriores à etapa de melhorias. Estado atual: [entrega](../delivery.md).

# Revisão de entrega — 27/10/2026

## Resultado

O recorte local está implementado e validado: API, núcleo financeiro, PostgreSQL,
SQS/inbox, outbox, referências, recuperação classificada, consultas e observabilidade.
A revisão corrigiu uma incompatibilidade de tipagem no bootstrap HTTP e informações
desatualizadas nos guias. Não alterou regras financeiras, dependências ou migrations.

Referência conferida: [desafio oficial](https://github.com/junglegaming/backend-challenge).
A autenticação adiada tem decisão e ponto de extensão explícitos. Teste de carga é
opcional. A execução usa Compose para dependências e Bun para os quatro papéis.

## Ensaio reproduzível anterior à refatoração

Foi criada uma cópia dos arquivos versionáveis, incluindo as alterações locais,
sem `.git`, `.env`, `node_modules`, `dist` ou logs. Base Git: `44710c3`, com alterações
locais ainda sem commit. Não foi um clone de uma revisão publicada.

Na cópia:

```sh
bun install --frozen-lockfile
bun run setup:env
bun run typecheck
bun run build
bun test
```

| Verificação | Resultado |
|---|---|
| Instalação congelada | 148 pacotes instalados pelo bun.lock |
| Configuração | Novo .env e chave local de cursor, sem reutilizar segredo anterior |
| Typecheck/build | Aprovados após correção descrita abaixo |
| Suíte completa | 590 aprovados, 0 falhas, 2.224 asserções, 19 arquivos, 28,03 s |
| API compilada | Iniciada em porta temporária; live, ready e metrics retornaram 200; encerramento normal |
| Recursos financeiros | Bancos e filas UUID descartáveis, com limpeza pelas fixtures |

Ambiente: macOS arm64, Bun 1.4.4, TypeScript 5.9.3, NestJS 12.2.0,
MikroORM 7.2.5, Decimal.js 10.6.0, SDK SQS 3.1157.0,
PostgreSQL 17.11 e LocalStack 4.0.3 com imagens fixadas no Compose.
A instalação pôde usar o cache de pacotes do Bun; não reutilizou node_modules.
Os containers existentes de PostgreSQL/LocalStack foram reutilizados; esta revisão
não apagou volumes nem refez o bootstrap de Docker em uma máquina nova. A suíte
exercitou criação de bancos de teste e migrations up/down/up.

## Correções da revisão

- `beginHttpShutdown` chamava `getHttpServer<Server>()`, mas a interface instalada
  não aceita parâmetro de tipo. Agora a atribuição local tipa o servidor retornado.
  O comportamento de drenagem permanece coberto pelo teste HTTP com SIGTERM.
- O início rápido agora prepara LocalStack e as quatro filas antes de consultar
  readiness, e explica os três processos de workers adicionais.
- README, arquitetura, índice de specs, ADRs, requisitos e demo diferenciam estado
  atual de evidências históricas. A recuperação classificada e as métricas não
  aparecem mais como etapas futuras nos resumos atuais.
- O diagrama de estados mostra somente a transição automática implementada para
  FAILED: PENDING_REFERENCE, após a recuperação segura classificada.

## Evidências por capacidade

| Capacidade | Evidência executável |
|---|---|
| Money e invariantes | [Testes do domínio](../../src/modules/financial/domain/money/money.test.ts), Wallet e ledger no mesmo diretório |
| Schema, roles, atomicidade e lock | [Persistência](../../tests/integration/financial-persistence.test.ts) |
| Replay, reversões e três processos | [Casos de uso](../../tests/integration/financial-use-cases.test.ts) |
| Contratos, cursor e reconciliação | [HTTP](../../tests/integration/financial-http.test.ts), [consultas](../../tests/integration/financial-queries.test.ts) |
| Inbox, ACK, redelivery, retry e DLQ | [SQS](../../tests/integration/financial-sqs.test.ts) |
| Publishers, fencing e crash | [Outbox](../../tests/integration/financial-outbox.test.ts) |
| Scheduler e recuperação segura | [Referências](../../tests/integration/financial-references.test.ts) |
| Health, correlação e métricas | [Observabilidade](../../tests/integration/financial-observability.test.ts) |

A revisão estática dos imports não encontrou dependência de Nest/ORM/SDK nas
camadas de domínio/aplicação. As conversões numéricas inspecionadas tratam
contagens, datas, durações e configurações, não quantias monetárias. Naquele ensaio isso foi revisão
de código; a etapa posterior acrescentou o check automatizado descrito abaixo.

## Limites da entrega

- Sem autenticação externa; ProviderIdentityPort/guard local não autentica.
- Sem deploy AWS, containers de API/workers, dashboard, tracing ou teste de carga.
- FAILED automático limitado a INVALID_REFERENCE_STATE após rollback confirmado;
  erro genérico ou commit incerto não autoriza classificar uma transação como FAILED.
- Publicação at-least-once, sem ordem financeira estrita garantida na saída;
  consumidor demonstrado existe somente no harness de testes.
- Specs com recortes parciais mantêm limites de evidência. A suíte não demonstra
  todas as combinações possíveis de crash, rede e perda de lease.
- Logs técnicos de lock/retry podem ter apenas wallet/cause/component; não se
  promete rastreamento distribuído completo em todas as observações.
- Métricas reiniciam com o processo; gauges SQL repetem o mesmo banco por papel.

O [roteiro de demonstração](../demo.md) contém os comandos e resultados esperados.
Commit/push/PR não foram executados nesta etapa; publicar a entrega depende de
uma autorização específica. As referências de evidência ainda correspondem ao
working tree local, não a uma versão remota imutável.

## Atualização após reorganização e desacoplamento

Etapa autorizada em 27/10/2026: domínio por conceito, eventos e coordenação
compartilhada na aplicação, contratos separados, adaptadores financeiros com
proprietário explícito e composição no bootstrap. Referência: [ADR 0004](../adr/0004-module-boundaries-and-layout.md).

A validação atual passou com 610 testes, zero falhas e 2.276 asserções em 26,33 s
(432 unitários + 178 integrações; 21 arquivos). Typecheck executa o novo check de
arquitetura, que verificou 83 arquivos de produção sem dependências invertidas ou
ciclos. Testes negativos demonstram a detecção de violações, inclusive de tipo.

O domínio/aplicação não conhece httpStatus; a apresentação HTTP traduz o resultado.
Um decoder de storage mantém leitura de registros legados, valida inconsistências
e não reescreve resultados antigos. Replay real após movimento adicional preservou
o saldo histórico e o JSON armazenado; resultados novos não contêm o campo HTTP.
Migrations mantêm nomes e SQL, com nova localização; a fronteira transacional
financeira e os contratos públicos foram preservados. Sem dependência nova ou push.

Após limpar somente o dist gerado e recompilar, a API e os três workers foram
reiniciados com o novo build. Live/ready/metrics responderam 200 nas portas
3001/3101/3102/3103. Instalação congelada preservou o lockfile; os links locais e
git diff --check passaram. O smoke operacional não criou transações financeiras.

## Etapa anterior à prova de COMMIT incerto — 27/10/2026

626 aprovados, zero falhas, 2.364 asserções em 23 arquivos: 435 unitários e 191
integrações. macOS arm64: 48,60 s; Linux aarch64: 50,58 s. Ambas as revisões
passaram estilo, arquitetura (84 fontes), typecheck e build. API/três workers
reiniciados, live/ready/metrics 200 nas portas 3001/3101/3102/3103. CI hospedada
não executada. Esse resultado antecede o reforço da moeda do snapshot, a
classificação de desconexão sem código e a prova TCP de perda da resposta de COMMIT.
