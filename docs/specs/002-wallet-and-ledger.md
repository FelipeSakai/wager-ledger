# SPEC-002 — Wallet, abertura e ledger

| Campo | Conteúdo |
|---|---|
| ID | SPEC-002 |
| Estado | Aprovada |
| Revisão | 1.0 |
| Requisitos relacionados | F03, F04, F09, D01–D08; suporte a A05, A06, A08, A12, M04, M10 e M11 |
| Dependências de definição | SPEC-001 revisão 1.0; arquitetura; ADRs 0001 e 0002 |
| Dependências de implementação | Money, unidade de trabalho MikroORM/PostgreSQL, migrations e contratos mínimos de transação/outbox |
| Aprovação do conteúdo | Aprovado pelo responsável pelo projeto em 26/10/2026 |
| Implementação | Não iniciada |

Este documento define o contrato aprovado de Wallet, abertura e ledger, conforme a [arquitetura](../../ARCHITECTURE.md). A [SPEC-001](001-money.md) permanece aprovada e não é reaberta aqui. As cinco decisões desta spec estão encerradas; implementação e evidências de execução continuam pendentes.

## Objetivo

Manter uma carteira por player e moeda, com saldo exato, não negativo e reconstruível pelo histórico financeiro imutável. Criar a carteira sem janelas em que o saldo inicial exista sem seu registro de origem. Garantir que qualquer movimentação futura preserve essa relação em múltiplos processos.

## Escopo e exclusões

Inclui abertura, identidade e moeda da carteira, saldo, versão, timestamps, débito/crédito de domínio, criação e integridade de lançamentos, fronteira transacional e obrigações do schema.

Não oferece endpoints genéricos de depósito, saque, ajuste de saldo, exclusão de carteira ou edição de ledger. Após abertura, movimentações só ocorrem pelos casos de uso financeiros autorizados. Não inclui câmbio, partidas dobradas ou event sourcing completo.

Processamento externo, idempotência de apostas e transições de WagerTransaction serão detalhados na SPEC-003. Reversões ficam na SPEC-004; consumo SQS/inbox na SPEC-005; publicação de outbox na SPEC-006; consultas, paginação e reconciliação na SPEC-007. A separação documental não autoriza dividir uma operação financeira em commits independentes.

## Vocabulário e responsabilidades

| Termo | Significado |
|---|---|
| Wallet | Aggregate root que encapsula player, moeda, saldo e versão |
| Saldo materializado | Valor atual persistido para operação e consulta |
| Ledger | Histórico append-only das movimentações que efetivamente alteram saldo |
| OPENING | Transação interna que explica um saldo inicial positivo |
| Versão da wallet | Número iniciado em 1 na criação; aumenta por mudança efetiva de saldo |
| Unidade de trabalho | Contexto SQL compartilhado por todos os registros da operação |

Money define valor e aritmética. Wallet decide se uma mudança de saldo é permitida. O caso de uso coordena Wallet, transação, ledger e outbox. O adaptador persiste tudo no mesmo EntityManager transacional. Controller não altera saldo diretamente.

O domínio pode construir carteiras em moedas representáveis para testes; a aplicação da primeira versão aceita somente BRL. Nenhuma conversão de USD para BRL é implícita.

## Regras herdadas da arquitetura

| ID | Regra |
|---|---|
| WAL-R01 | No máximo uma wallet por `(playerId, currency)`, com unicidade no PostgreSQL |
| WAL-R02 | Saldo não negativo e dentro da faixa de Money, no domínio e no schema |
| WAL-R03 | Moeda da operação, da wallet e do ledger precisa ser a mesma |
| WAL-R04 | Toda mudança de saldo tem um lançamento correspondente e vice-versa, no mesmo commit |
| WAL-R05 | Toda wallet nasce com versão 1, inclusive quando há OPENING positivo |
| WAL-R06 | A versão incrementa somente quando o saldo muda; replay, rejeição e LOSS não incrementam |
| WAL-R07 | Saldo inicial positivo gera OPENING processada e um CREDIT com before zero e after igual ao saldo inicial |
| WAL-R08 | Saldo inicial zero não gera crédito nem ledger de valor zero |
| WAL-R09 | Uma transação financeira gera no máximo um lançamento por wallet |
| WAL-R10 | Ledger não admite UPDATE/DELETE; correções usam novas operações válidas |
| WAL-R11 | Débito/crédito dependem de lock por wallet, sem lock global, com mesma ordem em todos os caminhos |
| WAL-R12 | Domínio usa factories e estado encapsulado; rehydrate não reaplica transições de negócio |
| WAL-R13 | Inbox e outbox, quando aplicáveis, participam da mesma transação financeira; ACK/publicação externa só após commit |

Definição complementar aprovada em Q-WAL-01: debit, credit e criação de ledger exigem valor estritamente positivo. Abertura e saldo zero continuam válidos; operações sem efeito financeiro não geram lançamento artificial.

Definição complementar aprovada em Q-WAL-02: cada lançamento registra walletVersion, com unicidade por wallet/versão, para identificar a versão produzida pela movimentação e ordenar o histórico financeiro.

Definição complementar aprovada em Q-WAL-03: OPENING tem origem INTERNAL, identidade estável vinculada à wallet e não atribui provider, game ou round fictícios. Abertura positiva registra os eventos de processamento e saldo na mesma outbox transacional; abertura zero não produz eventos financeiros.

Definição complementar aprovada em Q-WAL-04: o PostgreSQL protege as regras locais por constraints e as relações financeiras entre registros por validações diferidas no commit, com verificações incrementais por wallet/versão. O SQL e a demonstração de correção serão entregues na etapa de implementação do banco.

Definição complementar aprovada em Q-WAL-05: IDs internos são gerados pelo backend como UUIDs; playerId recebido é UUID válido; timestamps usam UTC, com identidade e createdAt imutáveis. Contratos de erros distinguem entrada inválida, conflito, saldo insuficiente, falha transitória e corrupção persistida, sem mutação parcial no domínio.

## Contratos aprovados — Q-WAL-05

### Abertura HTTP

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

O formato de playerId é UUID válido, sem impor uma versão única ao identificador recebido. IDs internos de wallet, transação e ledger são gerados pelo backend como UUIDs; o cliente não escolhe o ID da wallet. `initialBalance` é obrigatório e segue exatamente o contrato de Money.

Resposta após commit, com status `201`:

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

O contrato não cria autenticação ou cadastro próprio de players. Validar formato de playerId não comprova identidade ou autorização do chamador. O ponto de extensão de identidade segue o ADR 0003.

### Resultado e erros

| Situação | Status | Código / resultado |
|---|---|---|
| Wallet criada e confirmada | 201 | Recurso criado |
| Mesmo player/moeda já existente | 409 | WALLET_ALREADY_EXISTS |
| Payload/playerId inválido ou erro de entrada Money | 400 | INVALID_WALLET_INPUT ou código de Money preservado |
| Moeda válida no domínio, mas não habilitada na aplicação | 400 | UNSUPPORTED_WALLET_CURRENCY |
| Infraestrutura indisponível temporariamente | 503 | INFRASTRUCTURE_UNAVAILABLE, sem saldo parcial |
| Falha inesperada ou integridade persistida inválida | 500 | INTERNAL_ERROR, sem detalhes internos na resposta |

Os códigos e os status desta seção estão aprovados. A forma do envelope de erro será padronizada na SPEC-003 sem alterar esses significados; os códigos aprovados de Money continuam estáveis. Uma exceção de constraint deve ser traduzida por sua causa conhecida, sem tratar qualquer falha SQL como wallet duplicada.

Erros de domínio e reconstrução aprovados em Q-WAL-05:

| Código | Condição e fronteira |
|---|---|
| INVALID_MOVEMENT_AMOUNT | debit/credit recebem Money com magnitude zero ou negativa, sem alterar o agregado |
| INSUFFICIENT_FUNDS | debit válido supera o saldo disponível; o caso de uso de reversão deverá traduzi-lo para seu failureCode específico na SPEC-004 |
| INVALID_LEDGER_ENTRY | create recebe direction inválida, magnitude não positiva ou before/after incompatíveis |
| INVALID_PERSISTED_WALLET | rehydrate encontra identidade, moeda, Money, versão ou timestamps estruturalmente inválidos |
| INVALID_PERSISTED_LEDGER_ENTRY | rehydrate encontra registro de ledger estrutural ou aritmeticamente inválido |

Conflito de moeda em operação ou criação de lançamento preserva CURRENCY_MISMATCH de Money. Overflow de resultado preserva MONEY_OUT_OF_RANGE. Na reconstrução, falhas de integridade são encapsuladas no código do registro persistido correspondente. Saldo insuficiente não é corrupção de dados nem falha transitória; um erro de reconstrução não é exposto como erro de entrada do cliente.

Todos esses erros terão código estável e mensagem legível, preservando saldo, versão e updatedAt quando ocorrerem no domínio. Mensagens não expõem SQL ou estado financeiro completo. O mapeamento da rejeição de débito em wagering será tratado na SPEC-003, sem acrescentar endpoints genéricos de débito/crédito a esta spec.

Criar wallet não ganha idempotência de replay por esta spec: repetir uma abertura confirmada retorna conflito, sem nova carga inicial. Se o commit ocorrer e a resposta se perder, um novo POST retorna 409; as consultas permitirão inspecionar o recurso. Qualquer mudança para replay de criação exigirá revisão explícita do contrato.

### Estado de domínio

Wallet encapsula `id`, `playerId`, `currency`, `balance`, `version`, `createdAt` e `updatedAt`. Identidade, player, moeda e createdAt não mudam após abertura. Timestamps usam UTC; na abertura são iguais. Em movimentação, updatedAt recebe o instante fornecido pelo contexto da operação, sem exigir timestamps distintos para operações no mesmo instante. Consultas, replay, LOSS e rejeição não alteram timestamps da wallet.

Factories: `Wallet.open` e `Wallet.rehydrate`; operações: `debit` e `credit`. Os métodos não fazem I/O. A mudança válida produz os dados necessários para o lançamento; o caso de uso persiste a mudança e seu ledger atomicamente. Uma falha de domínio deixa o agregado original sem alterações parciais de saldo, versão ou updatedAt.

rehydrate reconstrói o estado persistido sem executar abertura, crédito ou débito. Deve detectar corrupção estrutural, como saldo negativo, moeda inconsistente ou versão inválida, sem gerar eventos ou novos lançamentos. Validação de integridade não é repetição de uma transição.

## Abertura e tratamento de valores

### Saldo inicial zero

Criar wallet com saldo `"0.00"`, versão 1 e timestamps de criação. Não criar OPENING, ledger ou eventos financeiros sem alteração de saldo. Reconstrução do ledger vazio resulta em zero, não null. A ausência de OPENING não torna essa wallet inválida.

### Saldo inicial positivo

Criar wallet, OPENING processada e CREDIT na mesma unidade de trabalho. O lançamento tem before `"0.00"`, money igual ao initialBalance e after igual ao saldo da wallet. Versão final de abertura permanece 1; o crédito de abertura não conta como uma segunda movimentação após a criação.

OPENING não pode ser recebida de HTTP nem SQS. Conforme Q-WAL-03 aprovada, sua origem é explicitamente INTERNAL, com identidade estável vinculada ao ID da wallet. Não inventar provider, game ou round externos para preencher campos destinados a operações de provedores. O backend define a origem interna; o cliente não pode escolhê-la para contornar validações.

A representação compartilhada de transações na SPEC-003 deverá preservar esse contrato mínimo, distinguindo campos internos e externos. O schema deve impedir uma segunda OPENING para a mesma wallet, mesmo com outro ID de transação. Formato técnico da identidade estável e mapeamento físico são detalhes da implementação, sujeitos à unicidade e aos testes correspondentes; não mudam o conflito de POST duplicado definido nesta spec.

Também aprovada em Q-WAL-03: persistir os eventos `WagerTransactionProcessed` e `WalletBalanceChanged` para abertura positiva, com IDs estáveis, valores coerentes e walletVersion 1 no evento de saldo. Wallet, OPENING processada, ledger e os dois registros de outbox são confirmados juntos. Não publicar no broker dentro da transação. A abertura zero não emite esses eventos. Envelope e publisher serão detalhados na SPEC-006 sem omitir a origem interna ou fabricar contexto externo.

### Movimentações posteriores — Q-WAL-01

Aprovado: `debit`, `credit` e `WalletLedgerEntry.create` exigem money estritamente positivo. Zero é válido como saldo e para abrir uma carteira, mas não cria uma movimentação artificial. Rejeitar zero/negativo antes de mudar saldo, versão ou updatedAt: debit/credit usam INVALID_MOVEMENT_AMOUNT; criação de ledger usa INVALID_LEDGER_ENTRY, conforme Q-WAL-05.

Isso não define sozinho a aceitação de todas as requisições externas com valor zero. A SPEC-003 decidirá a política por tipo de operação; se um tipo puder existir sem efeito financeiro, não deve chamar debit/credit nem gerar ledger zero. LOSS continua sem efeito no saldo.

Débito igual ao saldo é permitido e resulta em zero. Débito maior que saldo gera rejeição de domínio sem modificar o agregado. Crédito que ultrapassa MAX de Money falha explicitamente, preservando saldo e versão. Depois de cada mudança válida, incrementar versão uma vez. Um novo saldo igual ao anterior não pode ser usado para fabricar versão ou ledger.

## Ledger imutável e ordenação — Q-WAL-02

Campos mínimos: `id`, `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter` e `createdAt`. Todos são imutáveis. `direction` é DEBIT ou CREDIT; money representa a magnitude positiva, não um valor com sinal.

Aprovado: acrescentar `walletVersion` ao lançamento para identificar a versão produzida pela movimentação. Usar unicidade `(walletId, walletVersion)`, além de `(walletId, transactionId)`. Timestamps não são o critério único para ordenar o ledger. As garantias de continuidade e correspondência de saldos no commit seguem a estratégia aprovada em Q-WAL-04, ainda sem implementação.

- Abertura positiva: lançamento na versão 1, before zero.
- Abertura zero: versão 1 sem lançamento; a primeira movimentação posterior produz versão 2.
- Cada movimentação posterior produz a próxima versão, sem salto ou duplicação.
- Versões sem mudança de saldo não criam lançamentos adicionais.

Factory `WalletLedgerEntry.create` valida moeda, não-negatividade de before/after e aritmética exata: CREDIT soma, DEBIT subtrai. `rehydrate` reconstrói registro íntegro sem aplicar uma movimentação na wallet. Não há métodos de editar/excluir lançamento ou de mudar direction/transactionId.

O saldo reconstruído começa em zero e inclui o crédito OPENING quando existir. Não somar initialBalance outra vez, pois isso duplicaria a abertura. Partidas dobradas ficam fora desta versão.

## Garantias do schema — Q-WAL-04

As obrigações abaixo seguem a arquitetura e a estratégia aprovada em Q-WAL-04. A aprovação do mecanismo não comprova sua execução: DDL, funções, permissões e migrations serão implementados e testados na etapa de banco.

| Garantia | Proteção prevista |
|---|---|
| Uma wallet por player/moeda | UNIQUE com colunas obrigatórias |
| Saldo finito e não negativo, até MAX | NUMERIC(20, 2), NOT NULL e CHECKs explícitos; rejeitar também NaN |
| Identidade, moeda e createdAt estáveis | Restrições de escrita/privilégios e triggers quando necessários |
| Um ledger por wallet/transação | UNIQUE e FKs para wallet e transação |
| Mesma wallet/moeda/contexto | FKs compostas e validação relacional no commit |
| Ledger aritmeticamente válido | CHECK local de direction, magnitude, before/after e aritmética |
| Ledger append-only | Privilégios sem UPDATE/DELETE/TRUNCATE para a aplicação e proteção por triggers |
| Ordem financeira estável | walletVersion e unicidade por wallet/versão aprovadas em Q-WAL-02; continuidade protegida pelo mecanismo de Q-WAL-04 |
| Saldo sem ledger ou ledger sem mudança legítima | Validação cruzada da wallet, transação e sequência do ledger no commit |

Conforme Q-WAL-04 aprovada, combinar constraints relacionais com constraint triggers diferidas para validar a transição no commit. Conferir que a alteração de saldo/versão tem o lançamento correspondente, que before reflete a versão anterior, que after corresponde à nova versão e que a transação referenciada está no estado e contexto financeiro corretos. Validar também o caminho inverso, impedindo inserir um ledger órfão de mudança de saldo.

A regra precisa tratar abertura positiva na versão 1, abertura zero sem lançamento, ordem de inserção e eventual execução de mais de uma mudança na mesma unidade SQL. Um teste que altera saldo e depois repõe o mesmo saldo não pode contornar o histórico exigido.

Desenho incremental aprovado como estratégia de implementação:

1. Em cada INSERT de wallet, registrar a verificação diferida da imagem de criação: versão 1 e, se saldo positivo, OPENING/ledger da mesma versão; se zero, ausência de crédito de abertura.
2. Em cada UPDATE financeiro, conferir a relação entre saldo e versão. Mudança de saldo exige versão anterior + 1; saldo inalterado não permite incremento artificial. A verificação diferida de cada transição usa seus valores before/after, não apenas a imagem final da wallet.
3. Conferir no commit que existe exatamente um ledger para a versão produzida, com before igual ao saldo anterior e after igual ao saldo daquela transição. Duas mudanças na mesma unidade SQL precisam de dois lançamentos e duas versões, mesmo que o saldo final retorne ao valor inicial.
4. Ao inserir ledger, adquirir o lock da wallet também nas escritas SQL diretas, na ordem comum, e programar validação inversa: não aceitar versão posterior à wallet, quebra com o lançamento predecessor/sucessor ou cabeça do ledger incompatível com saldo/versão finais. Considerar a raiz zero sem lançamento na versão 1.
5. Aplicar a unicidade wallet/versão e wallet/transação, a correspondência da transação financeira e a imutabilidade para impedir duplicação ou alteração posterior da cadeia. Identidade/moeda da wallet e estado terminal da transação não podem ser alterados para invalidar um lançamento já confirmado.

A estratégia usa buscas por wallet/versão e seus vizinhos indexados, evitando somar todo o histórico em cada operação. As funções SQL precisam cobrir todas as tabelas que podem invalidar a relação, inclusive mudanças de estado ou contexto da transação referenciada; a implementação e os testes de concorrência demonstrarão essa cobertura. Não considerar apenas um trigger no UPDATE da wallet como proteção suficiente. Se o detalhamento do SQL exigir mudança da estratégia ou dos contratos aprovados, apresentar o impacto para revisão antes de adotá-la.

CHECK isolado não garante relações entre tabelas. As migrations deverão implementar e testar o mecanismo completo, sem depender apenas do service. Referências técnicas: [constraints do PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html) e [constraint triggers](https://www.postgresql.org/docs/current/sql-createtrigger.html).

A aplicação usa papel de banco sem privilégios de superusuário, alteração de schema ou desativação das proteções. O papel de migrations é separado. Rollback de migration será testado em ambiente descartável; não autoriza apagar histórico financeiro em ambiente com dados reais sem plano específico aprovado.

## Fluxos transacionais e concorrência

### Abrir wallet

1. Validar transporte, playerId, Money e moeda habilitada.
2. Iniciar unidade de trabalho com EntityManager exclusivo.
3. Inserir wallet protegida pela unicidade player/moeda. Como a linha ainda não existe, a proteção contra duas aberturas concorrentes vem da constraint, não de lock de uma linha inexistente.
4. Se o saldo for positivo, inserir OPENING, ledger e eventos de outbox no mesmo contexto, conforme contratos desta spec e da SPEC-006.
5. Confirmar a transação, incluindo validações diferidas, e só então devolver 201.

Se qualquer gravação ou validação de commit falhar, nada da abertura persiste. Ao capturar erro SQL que abortou a transação, executar rollback antes de consultar ou traduzir o conflito em um novo contexto. Não fazer top-up de uma wallet existente para resolver uma colisão de abertura.

### Movimentar wallet existente

Adquirir lock de linha da wallet antes dos registros de transação/referência, conforme ADR 0002. Usar o saldo relido sob lock para decidir. Persistir atualização, ledger, transação, outbox e inbox quando aplicável na mesma unidade de trabalho. Nenhuma chamada de rede acontece enquanto o caso de uso segura a transação financeira.

Wallets diferentes avançam em paralelo; a mesma wallet é serializada pelo lock. Idempotência do caso de uso impede uma mesma transação de alcançar debit/credit duas vezes; a constraint do ledger é uma proteção adicional, não substitui a identidade financeira da SPEC-003.

Para falhas de infraestrutura, rollback e retry seguem classificação limitada na SPEC-003. Rejeições de negócio não alteram wallet/ledger; o registro auditável da rejeição pertence à transação de wagering. Esta spec não transforma erros técnicos em saldo insuficiente.

## Cenários de aceite

Os cenários são critérios de aceite aprovados do contrato alvo. Casos dependentes de specs futuras permanecem identificados; a aprovação documental não significa que os testes tenham sido implementados ou executados. Níveis: U = unidade; I = integração com PostgreSQL real; C = concorrência multiprocesso; E = contrato HTTP/SQS quando disponível.

| ID | Dado / quando | Então | Nível / vínculo |
|---|---|---|---|
| WAL-001 | Abrir wallet com 0.00 BRL | Saldo zero, versão 1; sem OPENING, ledger ou evento financeiro | U/I; D06, Q-WAL-03 |
| WAL-002 | Abrir wallet com 100.00 BRL | OPENING processada, um CREDIT 0.00 → 100.00 e saldo 100.00, tudo atômico | U/I; D03, D06 |
| WAL-003 | Inspecionar versão e timestamps da abertura positiva | Versão 1; createdAt = updatedAt; ledger com walletVersion 1 | U/I; D04, Q-WAL-02 aprovada, Q-WAL-05 |
| WAL-004 | Repetir abertura do mesmo player/moeda | 409; uma wallet e uma única carga inicial, sem top-up | I/E; D01, A08 |
| WAL-005 | Dois processos abrirem o mesmo player/moeda simultaneamente | Uma criação e um conflito; apenas um conjunto de abertura confirmado | C; D01, D06 |
| WAL-006 | Players distintos abrirem wallets BRL | Wallets independentes, sem colisão de identidade | I; D01 |
| WAL-007 | Construir Money/Wallet de outra moeda em teste de domínio e enviar USD à aplicação | Domínio preserva moeda; aplicação rejeita USD sem criar wallet | U/E; F09, Q-WAL-05 |
| WAL-008 | Abrir com amount inválido, negativo ou acima de MAX | Erro correspondente, sem registros financeiros parciais | U/I/E; SPEC-001 |
| WAL-009 | Debitar 25.00 de saldo 100.00 na versão 1 | Saldo 75.00, versão 2; um DEBIT before 100.00/after 75.00 | U/I; D03, D04 |
| WAL-010 | Debitar o saldo inteiro de 100.00 | Saldo zero permitido; versão aumenta e ledger é coerente | U/I; D02 |
| WAL-011 | Debitar 100.01 de saldo 100.00 | Saldo insuficiente; saldo, versão, updatedAt e ledger preservados | U/I; D02, Q-WAL-05 |
| WAL-012 | Creditar 10.00 em saldo 100.00 | Saldo 110.00, versão incrementada e CREDIT correspondente | U/I; D03, D04 |
| WAL-013 | Creditar 0.01 em saldo MAX | Erro de intervalo; nenhum efeito parcial no agregado ou banco | U/I; SPEC-001, D02 |
| WAL-014 | Debitar/creditar USD em wallet BRL | CURRENCY_MISMATCH, sem alteração parcial | U/I; D04 |
| WAL-015 | Chamar debit/credit ou criar ledger com zero/negativo | INVALID_MOVEMENT_AMOUNT em debit/credit e INVALID_LEDGER_ENTRY na criação do ledger; sem movimento ou mudança de saldo, versão ou updatedAt | U/I; Q-WAL-01, Q-WAL-05 |
| WAL-016 | Processar LOSS, rejeição ou replay por casos de uso futuros | Nenhuma mudança de saldo, versão, updatedAt ou ledger adicional | I/E; SPEC-003, D08 |
| WAL-017 | Criar ledger com before/after aritmeticamente incompatíveis | Factory e banco rejeitam; nenhum commit inválido | U/I; D07 |
| WAL-018 | Inserir dois lançamentos para a mesma wallet/transação | Banco impede duplicação; segunda tentativa não altera saldo | I; D07 |
| WAL-019 | Tentar UPDATE, DELETE ou TRUNCATE do ledger com papel da aplicação | Operação recusada; histórico preservado | I; D07, Q-WAL-04 |
| WAL-020 | Tentar saldo negativo, NaN, identidade/moeda alterada ou versão inválida por SQL | Banco recusa, mesmo sem passar pelo domínio | I; D02, Q-WAL-04 |
| WAL-021 | Tentar confirmar mudança de saldo/versão sem ledger correspondente | Commit falha e restaura estado anterior | I; D03, Q-WAL-04 |
| WAL-022 | Tentar inserir ledger sem movimento válido ou com outra wallet/moeda/transação | Commit falha; sem lançamento órfão ou incoerente | I; D03, Q-WAL-04 |
| WAL-023 | Injetar falha após inserir wallet, OPENING, ledger ou outbox, antes do commit | Rollback completo; abertura sem fragmentos persistidos | I; D03, M04, Q-WAL-03 |
| WAL-024 | Disputar wallet de 100.00 com duas BET de 80.00 em processos distintos | Uma processada e outra rejeitada; saldo 20.00; um débito, além do crédito OPENING | C; SPEC-003, A06 |
| WAL-025 | Manter lock em wallet A e movimentar wallet B em outro processo | B confirma antes da liberação de A; sem lock global | C; A05 |
| WAL-026 | Após abertura zero, aplicar primeiro crédito positivo | Versão 2; primeiro ledger tem before zero; nenhuma OPENING artificial | U/I; Q-WAL-02 |
| WAL-027 | Usar mesma versão em dois lançamentos ou saltar versão de uma mudança | Banco rejeita e preserva a sequência válida | I; Q-WAL-02, Q-WAL-04 |
| WAL-028 | Reconstruir saldo do ledger após vários débitos/créditos | Saldo coincide com o persistido, sem somar abertura duas vezes | I; D03, A12 |
| WAL-029 | Reidratar wallet/ledger íntegros e tentar reidratar estados corruptos | Íntegros não criam movimentos; corrupção é sinalizada explicitamente | U/I; F04, Q-WAL-05 |
| WAL-030 | Perder a resposta de abertura após commit e repetir o POST | Conflito, uma wallet e uma carga inicial; sem replay inventado | I/E; A08 |
| WAL-031 | Alterar saldo e depois repor o valor inicial na mesma transação, omitindo um dos lançamentos | Commit falha; saldo final igual ao inicial não oculta uma transição sem ledger | I; Q-WAL-04 |
| WAL-032 | Tentar inserir lançamento em uma lacuna ou raiz histórica que rompa before/after dos vizinhos | Banco rejeita a cadeia incoerente, mesmo se o saldo final da wallet não mudar | I; Q-WAL-02, Q-WAL-04 |
| WAL-033 | Inspecionar a transação de abertura positiva | Origem INTERNAL, identidade estável vinculada à wallet e ausência de provider/jogo/rodada fictícios | U/I; Q-WAL-03 aprovada |
| WAL-034 | Abrir com saldo positivo e consultar a outbox após commit | Um evento WagerTransactionProcessed e um WalletBalanceChanged coerentes; saldo usa walletVersion 1; nada publicado antes do commit | I; Q-WAL-03 aprovada, SPEC-006 |
| WAL-035 | Tentar inserir segunda OPENING para uma wallet, com outro ID de transação | Banco impede duplicação de abertura e crédito | I; Q-WAL-03 aprovada, Q-WAL-04 |
| WAL-036 | Submeter OPENING ou tentar assumir origem INTERNAL por HTTP/SQS externos | Entrada não obtém um crédito interno nem contorna as validações do provedor | E; Q-WAL-03 aprovada, SPEC-003/SPEC-005 |
| WAL-037 | Provocar cada falha de entrada, débito, ledger e reconstrução prevista no contrato | Código correspondente e mensagem segura; saldo insuficiente distinto de corrupção; nenhuma mutação parcial no domínio | U/E quando aplicável; Q-WAL-05 |

## Estratégia de testes e conclusão

- Unidade com Bun: factories, débito/crédito, moeda, saldo insuficiente, overflow, versão, timestamps e aritmética do ledger, sem inicializar framework/banco.
- Integração: PostgreSQL real com migrations up/down e papel real da aplicação. Testar constraints e rejeição de commit, não apenas exceptions no service.
- Concorrência: pelo menos três processos/contextos disponíveis no harness final; para cada disputa, usar barreiras que provem sobreposição. Em wallets independentes, manter A bloqueada enquanto B conclui, sem depender só de sleeps ou medições de tempo.
- Atomicidade: provocar falhas em pontos distintos, incluindo validação diferida no commit; reconsultar por outra conexão depois do rollback.
- Outbox: verificar persistência atômica dos registros e ausência de publicação antecipada. Entrega no SQS pertence à SPEC-006.
- Encerrar cenários financeiros com saldo igual ao reconstruído pelo ledger e contagem correta das movimentações. Testes de infraestrutura que não produzem wallets válidas conferem ausência de estado parcial.

Os cenários de wagering e transporte só poderão ser verificados quando as specs responsáveis estiverem aprovadas e implementadas. Isso não autoriza omitir essas dependências numa entrega que alegue o fluxo financeiro completo.

Ainda não existem Wallet, ledger, migrations, Compose ou testes desta spec. Nenhum script novo ou resultado de execução está sendo declarado. Para marcar como Verificada, partir desta revisão aprovada, implementar em etapa autorizada, executar os cenários aplicáveis e registrar caminhos, comandos e evidências reais na matriz. SQL de proteção precisa ser demonstrado com banco real e papel da aplicação.

## Decisões aprovadas

| ID | Questão | Decisão | Impacto | Situação |
|---|---|---|---|---|
| Q-WAL-01 | Magnitude de movimentação | Exigir valor estritamente positivo em debit/credit e ledger; abertura zero continua válida e LOSS não movimenta saldo | Domínio; regras de aceitação por tipo continuam na SPEC-003 | Aprovada em 26/10/2026 |
| Q-WAL-02 | Versão no ledger | Acrescentar walletVersion, unicidade por wallet/versão e ordenação estável; abertura positiva na versão 1 e primeira mudança após abertura zero na 2 | Entidade, schema e futuras consultas; continuidade no banco detalhada em Q-WAL-04 | Aprovada em 26/10/2026 |
| Q-WAL-03 | Identidade e eventos de OPENING | Origem INTERNAL definida pelo backend, identidade estável por wallet, sem provider/jogo/rodada fictícios; no máximo uma OPENING por wallet; eventos de processamento e saldo na mesma outbox apenas para abertura positiva | Contratos mínimos de transação/outbox e coerência com SPEC-003/SPEC-006; mecanismo de schema em Q-WAL-04 | Aprovada em 26/10/2026 |
| Q-WAL-04 | Enforcement cruzado no banco | Constraints relacionais, permissões e validação diferida incremental por movimento, cobrindo abertura, múltiplas mudanças e ausência de ledger em ambas as direções, sem somar todo o histórico por operação | Schema, migrations, desempenho e verificação de integridade; SQL e evidências pendentes da implementação | Aprovada em 26/10/2026 |
| Q-WAL-05 | Contratos complementares e erros | UUIDs gerados pelo backend e playerId UUID válido; timestamps UTC; identidade/createdAt imutáveis; falha sem mutação parcial; códigos e status de abertura, débito, ledger e reconstrução definidos na seção de contratos, preservando erros de Money | API, domínio, mappers e tradução de erros; envelope geral na SPEC-003 | Aprovada em 26/10/2026 |

## Dependências futuras e limites da aprovação

Não há decisões funcionais pendentes nesta spec. Detalhes do DDL, funções SQL, formato físico da identidade interna, nomes de classes auxiliares e versão de dependências serão definidos na implementação autorizada dentro destes contratos. Se exigirem mudança de comportamento ou estratégia aprovada, apresentar o impacto antes de alterar a spec ou ADR.

A SPEC-003 detalhará transações externas, idempotência, aceitação de zero por tipo e o envelope geral de erros. A SPEC-004 traduzirá saldo insuficiente de reversão para código distinto do de BET. As specs de SQS, outbox e consultas detalharão transporte, publicação e acesso. Essas dependências não reabrem o contrato aprovado de abertura e ledger nem autorizam uma entrega com commit financeiro parcial.

## Registro de revisão e aprovação

| Revisão | Data | Alteração | Estado |
|---|---|---|---|
| 0.1 | 26/10/2026 | Rascunho de abertura, invariantes, ledger, garantias no banco e cenários de aceite | Rascunho |
| 0.2 | 26/10/2026 | Aprovação parcial da magnitude estritamente positiva de movimentações; preservação de abertura zero e operações sem efeito financeiro | Rascunho |
| 0.3 | 26/10/2026 | Aprovação de walletVersion no ledger, unicidade por wallet/versão e ordenação financeira independente dos timestamps | Rascunho |
| 0.4 | 26/10/2026 | Aprovação da origem INTERNAL, identidade estável e eventos da abertura positiva na outbox; cenários de duplicação e origem externa indevida | Rascunho |
| 0.5 | 26/10/2026 | Aprovação da estratégia de proteção no PostgreSQL e detalhamento dos códigos de erro ainda propostos em Q-WAL-05; SQL e testes permanecem na implementação | Rascunho |
| 1.0 | 26/10/2026 | Aprovação integral, incluindo UUIDs, timestamps, identidade imutável, ausência de mutação parcial, códigos de erro e status HTTP | Aprovada |

Aprovação do conteúdo: concedida pelo responsável pelo projeto em 26/10/2026, abrangendo Q-WAL-01 a Q-WAL-05 e os critérios desta revisão. Implementação, instalação de dependências, commit e publicação dependem de autorização da etapa correspondente. Evidências executadas: nenhuma.
