# 0001 — Núcleo financeiro coeso e domínio independente

Estado: aceita em 26/10/2026; núcleo, casos de uso, persistência e transportes verificados no recorte local.

As evidências datadas preservam o estado de cada etapa. O estado atual consolidado está na [revisão de entrega](../delivery.md).

## Contexto

O processamento financeiro exige que saldo, transação, ledger, inbox e outbox sejam consistentes no mesmo commit, com regras de domínio encapsuladas e execução em múltiplas instâncias. A arquitetura precisa permitir manutenção, auditoria e testes reproduzíveis.

## Decisão

Usar monólito modular com arquitetura hexagonal e DDD aplicado ao núcleo financeiro. Wallets, transações e ledger ficam no módulo `financial`, com camadas `domain`, `application`, `infrastructure` e `presentation`. API e workers compartilham os casos de uso e podem rodar como processos independentes.

Domínio usa classes, factories, transições explícitas e `Money` imutável. Modelos de persistência são separados, com mappers para `rehydrate`. O domínio não depende de decorators NestJS ou ORM. A aplicação define portas; infraestrutura implementa; bootstrap compõe.

`Money` usa Decimal.js para aritmética decimal exata, strings nos contratos e `NUMERIC(20, 2)` no PostgreSQL, sem conversão intermediária para ponto flutuante. A moeda acompanha o valor em coluna separada.

### Detalhamento aceito em 26/10/2026

O contrato monetário exige string com exatamente duas casas, como `"25.00"`. Entradas numéricas e formas `"25"`/`"25.0"` são rejeitadas, sem normalização silenciosa. A alternativa de aceitar menos casas e completar o texto foi descartada para manter o contrato previsível.

O domínio representa moedas diferentes, com BRL e USD nos testes de conflito. A primeira versão da aplicação usa somente BRL nas entradas, saldos, transações, ledger e apresentação de valores. Essa habilitação comercial pertence à aplicação e pode evoluir sem limitar Money a uma única moeda. O adiamento de câmbio e visualização convertida está registrado no ADR 0003.

Usar construtor exclusivo de Decimal.js com precisão de trabalho 40, isolado da configuração global. A faixa de representação acompanha NUMERIC(20, 2), até 18 dígitos inteiros e dois decimais: limite positivo `999999999999999999.99`. Persistir o decimal monetário diretamente, sem convertê-lo em centavos inteiros. Exceder a faixa gera erro explícito; nenhum arredondamento silencioso é admitido.

A precisão de trabalho preserva somas e subtrações de dois valores na faixa antes da checagem de overflow. Agregações sem limite de termos exigirão estratégia própria. Limites comerciais são independentes desse teto de representação. Versão e instalação da dependência ficam para a etapa de implementação.

### Contrato monetário concluído em 26/10/2026

A [SPEC-001](../specs/001-money.md) foi aprovada integralmente na revisão 1.0. O catálogo é um subconjunto local de códigos ISO com BRL e USD, versionado no Git; alterações exigem revisão explícita. A validação não converte caixa, remove espaços nem busca dados externos. A aplicação continua habilitada somente para BRL.

Amount exige forma decimal canônica com duas casas, sem sinal positivo, espaços, zeros excedentes à esquerda ou formato regional. from aceita apenas não negativos; rehydrate admite negativos internos e valida a integridade, sem repetir transições de negócio. Wallet permanece sujeita a saldo não negativo.

Toda operação binária, inclusive equals, rejeita moedas distintas com CURRENCY_MISMATCH. toJSON devolve amount e currency; toString usa amount, espaço e código. Os códigos INVALID_MONEY_AMOUNT, INVALID_CURRENCY, CURRENCY_MISMATCH, MONEY_OUT_OF_RANGE e INVALID_PERSISTED_MONEY fazem parte do contrato aprovado.

Essas decisões encerram as pendências funcionais de Money. Versão/instalação de Decimal.js, implementação e evidências ficam para etapas autorizadas próprias. A aprovação não comprova garantias de banco ou de processamento financeiro.

### Implementação de Money verificada em 27/10/2026

A etapa inicial foi autorizada e implementou Money/MoneyError em `src/modules/financial/domain/`, mantendo o contrato 1.0. Decimal.js 10.6.0 está fixada sem faixa em package.json e bun.lock. O construtor exclusivo usa `defaults: true` e precisão 40 para isolar também os limites de expoente de configurações globais anteriores à importação. Campos privados de runtime, instância congelada e snapshots novos na serialização preservam a imutabilidade.

Os 22 cenários da SPEC-001 foram cobertos por 128 testes Bun, com instalação congelada, typecheck e build concluídos. As evidências e caminhos estão na SPEC-001 e na matriz de requisitos. Esse resultado se limita ao objeto monetário; a etapa subsequente de domínio está registrada abaixo, enquanto mappers, PostgreSQL e atomicidade financeira continuam pendentes.

### Implementação do domínio de Wallet/ledger verificada em 27/10/2026

A etapa seguinte autorizada implementou Wallet, WalletLedgerEntry, seus erros e validações estruturais sem novas dependências. O backend fornece IDs e instante ao domínio. debit/credit constroem um lançamento válido antes de alterar saldo, versão e updatedAt; as datas são copiadas defensivamente. rehydrate recebe dados monetários em MoneyProps e encapsula corrupção no código do registro. A abertura positiva ainda exige orquestração futura de OPENING, ledger inicial e outbox na mesma unidade SQL.

As assinaturas escolhidas e as fronteiras estão descritas na SPEC-002. A suíte soma 277 testes aprovados, com 149 novos de Wallet/ledger; typecheck e build concluídos. Essa etapa comprova modelos e invariantes locais. Naquela etapa, unicidades, append-only no banco e múltiplas instâncias ainda dependiam de integração; as provas subsequentes estão registradas ao final deste ADR.

### Magnitude das movimentações aceita em 26/10/2026

Na SPEC-002, Q-WAL-01 foi aprovada: debit, credit e criação de ledger exigem valor estritamente positivo. Saldo e abertura zero continuam permitidos. LOSS e outros resultados sem efeito financeiro não geram lançamentos ou incremento de versão. A aceitação de valores zero nos contratos externos de cada tipo será definida na SPEC-003; essa decisão não altera a capacidade de Money representar zero ou negativos internos.

### Versão no ledger aceita em 26/10/2026

Q-WAL-02 foi aprovada: cada lançamento carrega walletVersion, com unicidade `(walletId, walletVersion)` além de `(walletId, transactionId)`. A abertura positiva tem lançamento na versão 1. A abertura zero não tem ledger na versão 1, e sua primeira movimentação posterior produz versão 2. A sequência ordena o histórico independentemente de timestamps repetidos. O mecanismo incremental de enforcement dessa continuidade no banco foi aprovado em Q-WAL-04 e está registrado no ADR 0002; sua implementação permanece pendente.

### Identidade e eventos de abertura aceitos em 26/10/2026

Q-WAL-03 foi aprovada: OPENING tem origem INTERNAL atribuída pelo backend e identidade estável vinculada à wallet, sem provedor, jogo ou rodada externos fictícios. No máximo uma OPENING pode existir por wallet. Para saldo inicial positivo, persistir a transação processada, um CREDIT e os eventos WagerTransactionProcessed/WalletBalanceChanged na mesma unidade de trabalho, com walletVersion 1 no evento de saldo. Abertura zero não produz esses registros financeiros. Eventos só são publicados após commit. Os contratos de transação e eventos das próximas specs deverão preservar essa distinção de origem e o registro auditável do saldo inicial.

### Contrato de Wallet e ledger concluído em 26/10/2026

A SPEC-002 foi aprovada integralmente na revisão 1.0, encerrando Q-WAL-01 a Q-WAL-05. IDs internos usam UUIDs gerados pelo backend; playerId recebido é UUID válido; timestamps são UTC, com identidade e createdAt imutáveis. Falhas de domínio preservam saldo, versão e updatedAt.

Os códigos INVALID_MOVEMENT_AMOUNT, INSUFFICIENT_FUNDS, INVALID_LEDGER_ENTRY, INVALID_PERSISTED_WALLET e INVALID_PERSISTED_LEDGER_ENTRY distinguem falhas de operação e integridade. Erros aplicáveis de Money são preservados; a aplicação traduz saldo insuficiente de reversão para failureCode específico. Na abertura, status aprovados são 201, 400, 409, 503 e 500 conforme as causas definidas na spec.

O contrato inclui a estratégia SQL aceita em Q-WAL-04 e detalhada no ADR 0002. Na data da aprovação documental, SQL e seus testes ainda não existiam; a evidência da etapa autorizada subsequente consta ao final deste ADR.

### Recuperação da criação aceita em 27/10/2026

A revisão 1.1 da SPEC-002 mantém 409 WALLET_ALREADY_EXISTS na repetição da abertura e acrescenta `error.details.walletId` para recuperar uma criação cuja resposta se perdeu. Resolver o ID pelo par player/moeda validado, após rollback quando necessário; o cliente consulta o recurso existente e seu saldo atual. Um novo initialBalance não altera a wallet. A alternativa de introduzir replay idempotente na criação foi descartada para preservar o contrato já aceito. A exposição do ID segue a mesma política de acesso da consulta. O detalhamento de persistência por movimento também incorporado nessa revisão consta do ADR 0002.

## Alternativas consideradas

- Microsserviços por wallet, wagering e ledger: aumentam a complexidade da atomicidade, exigindo protocolo distribuído sem benefício que justifique esse custo no escopo atual.
- Estrutura só por controllers/services/entities do framework: tende a misturar regras financeiras com transporte e persistência.
- Modelo de domínio decorado pelo ORM: reduz mapeamento inicial, mas acopla reidratação e invariantes ao mecanismo de persistência.
- Event sourcing completo ou ledger de partidas dobradas: possíveis extensões, mas trazem escopo adicional; o requisito pede ledger auditável e reconciliação, não essas abordagens.

## Consequências

Fronteira transacional explícita, domínio testável sem containers e um único núcleo para HTTP/SQS. Haverá custo de manter modelos e mappers separados. O módulo financeiro não deve virar um agrupamento sem limites; novas subdivisões dependem de necessidade real e não podem quebrar a atomicidade.

## Como validar

Testes unitários sem NestJS/banco; revisão e futuro check de imports; testes de ida e volta dos mappers preservando valor/moeda/estado; integração comprovando rollback conjunto dos registros financeiros.

## Evidência incremental de persistência — 27/10/2026

Etapa autorizada de PostgreSQL/MikroORM concluída: roles separadas, bootstrap SQL,
Compose, migration reversível e quatro modelos ORM com mappers monetários em string.
`MikroFinancialUnitOfWork` mantém um contexto/lock por unidade SQL, flush por movimento
e um único commit externo. Constraints e validações diferidas incrementais foram
executadas com o papel da aplicação; migrations up/down/up apenas em banco descartável.

MikroORM 7.2.5, PostgreSQL 17.11, Bun 1.4.4. A suíte completa passou com 315 testes
(277 unitários + 38 de integração), zero falhas e 1.041 asserções. Inclui WAL-038–WAL-040,
rollback após flush, round-trip monetário e lock por wallet com três processos reais.
A SPEC-002 detalha caminhos e limites. Fixtures de persistência não implementam casos
de uso, replay, inbox, publisher, referências pendentes ou ACK. REV-D01 foi comprovada
no índice em sequência entre tipos; sua corrida concorrente continua pendente.

## Evidência subsequente de aplicação — 27/10/2026

Etapa de abertura/processamento autorizada implementou WagerTransaction e os casos
OpenWallet/ProcessTransaction/ResumePendingTransaction, preservando as portas.
Defaults PROC-D01/D02/D03, prazo/backoff/limite de referência e envelopes EVT-D01/D02
foram aplicados nesse recorte: hash SHA-256/JSON-v1, replay histórico, BRL na aplicação,
reversão única e rejeições auditáveis. Classes concretas de eventos e produção de
outbox agora existem. A migration 002 acrescenta versão do hash/agendamento durável;
o backfill técnico é transacional e preserva resultados/ledger, comprovado com dados.

A suíte atual aprovou 412 testes (342 unitários + 70 de integração), zero falhas e
1.427 asserções; instalação congelada/typecheck/build passaram. Inclui 50 reenvios
em três processos com sobreposição observada no banco, reversões concorrentes e
retomada/expiração de referência com relógio injetado. SQL constraints continuam
sendo a barreira final; colisão de identidade exige rollback antes de reler.
São três tentativas no máximo e orçamento conferido antes de repetir, sem promessa
de deadline absoluto para falhas de rede. HTTP/SQS, inbox, scheduler automático,
publisher, FAILED/DLQ e observabilidade permanecem pendentes. Evidências anteriores
deste ADR registram o limite de cada etapa, não o estado atual dessas capacidades.

## API e consultas verificadas — 27/10/2026

Etapa autorizada implementou HTTP dos casos de uso e consultas/reconciliação da
SPEC-007. Bootstrap compõe as dependências e fecha o ORM; apresentação não importa
ORM nem duplica regras financeiras. ProviderIdentityPort/guard existem, com uma
implementação local explícita sem autenticação e bind padrão em loopback.
QRY-D01/D02 foram aplicados: HMAC-SHA256 com segredo estável, paginação por versão,
READ ONLY/REPEATABLE READ e soma NUMERIC sem typmod para diagnóstico exato.

HTTP usa correlação UUID, JSON limitado a 32 KiB, códigos/status explícitos e filtro
que não expõe SQL/stack. Diagnóstico de divergência gera log/counter local sem reparo.
Suíte completa: 459 testes aprovados, zero falhas e 1.653 asserções (354 unitários +
105 de integração), com PostgreSQL real e HTTP/TCP; instalação congelada, typecheck
e build passaram. Inclui cursor em outra instância, reenvios HTTP concorrentes,
commit entre leituras da reconciliação e corrupção apenas em fixtures descartáveis.
IdP, SQS/inbox, publisher, agendador automático, FAILED/DLQ, health e observabilidade
completa continuam pendentes; nenhum commit/push/publicação foi feito nesta etapa.

## SQS/inbox e encaminhamento operacional verificados — 27/10/2026

Etapa autorizada implementou LocalStack 4.0.3 fixado por digest, SDK SQS 3.1157.0,
producer/envelope, consumidor com heartbeat/shutdown e inbox na unidade financeira.
Os defaults SQS-D01–D03 foram aplicados; SQS-D04/D05 permanecem preservados. Nova
migration acrescenta inbox/origem/transferências/auditoria. A origem primeira fica
imutável sob lock da wallet e o routing de pendente→FAILED cria a responsabilidade
DLQ no mesmo SQL; falha nessa gravação reverte o terminal. O dispatcher envia fora
da unidade financeira e confirma por token/lease, independentemente de nova entrega.
Retomada de suspensão é local e auditada; corpo nunca entra em logs ou resposta HTTP.

A suíte total aprovou 502 testes/zero falhas/1.808 asserções (374 unitários + 128 de
integração), com PostgreSQL/LocalStack reais e processos independentes. Inclui crash
após commit, SIGTERM, heartbeat/redrive, corrida HTTP/SQS, três consumidores e DLQ
tardia retomada em outro processo. Instalação congelada/typecheck/build passaram.
Transições FAILED do harness comprovam o contrato SQL, sem implementar classificação
ou recuperação automática de falha permanente. Publisher de eventos financeiros,
agendador de referências, IdP, health real e observabilidade completa permanecem
pendentes. Dispatcher de DLQ não é o publisher financeiro. Não houve commit/push/deploy.

## Publisher financeiro verificado — 27/10/2026

Etapa autorizada aplicou EVT-D03: lote/concorrência até dez, lease/renovação, envio
fora do SQL e confirmação por token/lease. O evento persistido mantém ID/payload;
falhas geram backoff/suspensão recuperável e retomada local auditada. Migration 004
protege claims/datas, confirmação e imutabilidade de publicado; não muda saldos ou
transações financeiras. As filas de eventos são separadas das filas de comandos.

Suíte completa: 537 aprovados, zero falhas e 1.947 asserções (394 unitários + 143 de
integração), com PostgreSQL/LocalStack e processos independentes; instalação congelada,
typecheck e build passaram. Inclui crash antes/depois de envio, dois publishers,
SIGTERM, heartbeat/fencing, dez falhas SQS e retomada. A prova de deduplicação usa
inbox/projeção de teste, não um novo serviço consumidor de eventos. Sem promessa
de exactly-once nem ordem estrita por wallet. Scheduler/recuperação automática de
FAILED, IdP, health e observabilidade completos continuam pendentes. Nenhuma nova
dependência ou publicação em nuvem foi necessária; commit/push não foram realizados.
