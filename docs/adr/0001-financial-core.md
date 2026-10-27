# 0001 — Núcleo financeiro coeso e domínio independente

Estado: aceita em 26/10/2026; implementação pendente.

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

### Magnitude das movimentações aceita em 26/10/2026

Na SPEC-002, Q-WAL-01 foi aprovada: debit, credit e criação de ledger exigem valor estritamente positivo. Saldo e abertura zero continuam permitidos. LOSS e outros resultados sem efeito financeiro não geram lançamentos ou incremento de versão. A aceitação de valores zero nos contratos externos de cada tipo será definida na SPEC-003; essa decisão não altera a capacidade de Money representar zero ou negativos internos.

### Versão no ledger aceita em 26/10/2026

Q-WAL-02 foi aprovada: cada lançamento carrega walletVersion, com unicidade `(walletId, walletVersion)` além de `(walletId, transactionId)`. A abertura positiva tem lançamento na versão 1. A abertura zero não tem ledger na versão 1, e sua primeira movimentação posterior produz versão 2. A sequência ordena o histórico independentemente de timestamps repetidos. O mecanismo incremental de enforcement dessa continuidade no banco foi aprovado em Q-WAL-04 e está registrado no ADR 0002; sua implementação permanece pendente.

### Identidade e eventos de abertura aceitos em 26/10/2026

Q-WAL-03 foi aprovada: OPENING tem origem INTERNAL atribuída pelo backend e identidade estável vinculada à wallet, sem provedor, jogo ou rodada externos fictícios. No máximo uma OPENING pode existir por wallet. Para saldo inicial positivo, persistir a transação processada, um CREDIT e os eventos WagerTransactionProcessed/WalletBalanceChanged na mesma unidade de trabalho, com walletVersion 1 no evento de saldo. Abertura zero não produz esses registros financeiros. Eventos só são publicados após commit. Os contratos de transação e eventos das próximas specs deverão preservar essa distinção de origem e o registro auditável do saldo inicial.

### Contrato de Wallet e ledger concluído em 26/10/2026

A SPEC-002 foi aprovada integralmente na revisão 1.0, encerrando Q-WAL-01 a Q-WAL-05. IDs internos usam UUIDs gerados pelo backend; playerId recebido é UUID válido; timestamps são UTC, com identidade e createdAt imutáveis. Falhas de domínio preservam saldo, versão e updatedAt.

Os códigos INVALID_MOVEMENT_AMOUNT, INSUFFICIENT_FUNDS, INVALID_LEDGER_ENTRY, INVALID_PERSISTED_WALLET e INVALID_PERSISTED_LEDGER_ENTRY distinguem falhas de operação e integridade. Erros aplicáveis de Money são preservados; a aplicação traduz saldo insuficiente de reversão para failureCode específico. Na abertura, status aprovados são 201, 400, 409, 503 e 500 conforme as causas definidas na spec.

O contrato inclui a estratégia SQL aceita em Q-WAL-04 e detalhada no ADR 0002. SQL, código e testes ainda não existem; a aprovação documental não autoriza implementar nem declara as garantias verificadas.

## Alternativas consideradas

- Microsserviços por wallet, wagering e ledger: aumentam a complexidade da atomicidade, exigindo protocolo distribuído sem benefício que justifique esse custo no escopo atual.
- Estrutura só por controllers/services/entities do framework: tende a misturar regras financeiras com transporte e persistência.
- Modelo de domínio decorado pelo ORM: reduz mapeamento inicial, mas acopla reidratação e invariantes ao mecanismo de persistência.
- Event sourcing completo ou ledger de partidas dobradas: possíveis extensões, mas trazem escopo adicional; o requisito pede ledger auditável e reconciliação, não essas abordagens.

## Consequências

Fronteira transacional explícita, domínio testável sem containers e um único núcleo para HTTP/SQS. Haverá custo de manter modelos e mappers separados. O módulo financeiro não deve virar um agrupamento sem limites; novas subdivisões dependem de necessidade real e não podem quebrar a atomicidade.

## Como validar

Testes unitários sem NestJS/banco; revisão e futuro check de imports; testes de ida e volta dos mappers preservando valor/moeda/estado; integração comprovando rollback conjunto dos registros financeiros.
