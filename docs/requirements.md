# Rastreabilidade dos requisitos

Esta matriz define os requisitos funcionais, técnicos e operacionais do Wager Ledger. Alterações de escopo devem ser refletidas na arquitetura, nos ADRs e nos critérios de aceite antes da implementação correspondente.

Esta matriz distingue implementação de intenção. **Bootstrap** significa que há código inicial verificável. **Parcial** identifica evidência apenas no componente indicado. **Verificado no domínio** não comprova persistência ou integração. **Planejado** significa que ainda faltam implementação e testes. **Adiado** identifica uma capacidade reservada para uma fase posterior. Caminhos futuros abaixo são destinos propostos, não arquivos existentes.

Estado atual: núcleo, transportes, operação local e checks implementados; API, SQS/inbox, publisher, agendador, health e métricas locais implementados. Evidências anteriores estão no [histórico](history/requirements-stages.md); resultados atuais estão no [mapa](evidence.md). A [revisão de entrega](delivery.md) consolida a validação atual.

Arquitetura: [ARCHITECTURE.md](../ARCHITECTURE.md). Decisões: [ADRs](adr/README.md). Demonstração: [demo.md](demo.md).

## Relação com as specs

O [índice de specs](specs/README.md) organiza a definição de cada funcionalidade. Os estados documentais não substituem os estados de implementação desta matriz.

| Spec existente | Requisitos detalhados | Situação |
|---|---|---|
| [SPEC-001 — Money](specs/001-money.md) | F04–F08 no contexto do objeto Money; suporte a D02, D03 e D07 | Verificada no domínio, contrato 1.0; 128 testes unitários; round-trip ORM comprovado em 27/10/2026 |
| [SPEC-002 — Wallet, abertura e ledger](specs/002-wallet-and-ledger.md) | F03, F04, F09, D01–D08; suporte a A05, A06, A08, A12, M04, M10 e M11 | Parcial, contrato 1.1; Domínio, persistência e abertura HTTP verificados; SQS/inbox verificados no recorte da SPEC-005 |
| [SPEC-003 — Processamento e idempotência](specs/003-wager-processing-and-idempotency.md) | F04, F09, D04, D05, D08, D09, D12, D15, A01–A07, A10, A11, M02, M04, M10, M11, O03, O04 | Recorte 0.7 verificado; replay, integridade da moeda e perda real da resposta de COMMIT |
| [SPEC-004 — Reversões e pendências](specs/004-reversals-and-pending-references.md) | D05, D10–D15, A01, A03, A05, M04, M10, M12, O03, O04 | Recorte 0.5 verificado; reversões, scheduler e recuperação segura de referência |
| [SPEC-005 — SQS e inbox](specs/005-sqs-and-inbox.md) | F02, M01–M07, M12, A07, D05, O01–O04 | Recorte 0.6 verificado: inbox/DLQ, redelivery com heartbeat perdido e crash tardio |
| [SPEC-006 — Outbox e eventos](specs/006-outbox-and-events.md) | M04, M08–M12, D06, D08, O01–O04 | Recorte 0.3 verificado: enfileiramento/publicação, claims/fencing e retomada auditada |
| [SPEC-007 — Consultas e reconciliação](specs/007-queries-and-reconciliation.md) | A03, A08, A09, A10, A12, D03, D04, D07, O01, O02, O04 | API/SQL verificados 0.3; cursor HMAC e reconciliação consistente |
| [SPEC-008 — Observabilidade e operação](specs/008-observability-and-health.md) | F01–F03, A13, O01–O08, M06, M07, M12 | Recorte 0.4 verificado: health/métricas, correlação técnica e deadline completo |

Os requisitos F04–F08 abrangem múltiplas camadas; verificar Money e os modelos de Wallet/ledger isoladamente não encerra todo esse conjunto. Persistência, transportes e concorrência/idempotência possuem evidências próprias nas suítes indicadas abaixo.

Todo requisito possui ao menos uma spec responsável ou de suporte na tabela. Essa associação não comprova execução; as evidências de domínio estão registradas abaixo e nas SPEC-001/002. Os defaults foram adotados nas etapas indicadas pelas specs; persistência e mensageria têm evidências reais próprias.

## Fundação, stack e modelagem

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| F01 | Bun 1.x, TypeScript estrito e NestJS | package.json, bun.lock, tsconfig.json, main.ts e bootstrap/http-application.ts | Instalação congelada, typecheck/build e testes HTTP/TCP reais | Verificado no recorte atual de API |
| F02 | PostgreSQL, SQS e Compose | Compose com PostgreSQL 17.11 e LocalStack 4.0.3 fixado por digest | SQS FIFO/DLQ/redrive reais; SDK SQS 3.1157.0 fixado; recursos de teste isolados | Verificado no ambiente local; implantação AWS fora do recorte |
| F03 | MikroORM e migrations reversíveis; persistência de cada movimento com um único commit | src/platform/database/ e src/modules/financial/infrastructure/persistence/ | MikroORM 7.2.5; migration up/down/up; mappers exatos; WAL-038–WAL-040 em integração | Verificado no recorte atual de persistência |
| F04 | Construtores privados/protegidos, factories e rehydrate | Money, Wallet, WalletLedgerEntry, WagerTransaction no domínio; classes de eventos na aplicação | Factories/rehydrate, imutabilidade e transições com Bun; invariantes de persistência reais | Verificado no domínio implementado |
| F05 | Money imutável com Decimal.js e precisão de trabalho 40; faixa NUMERIC(20, 2) e escala dois | Money/MoneyError; Decimal.js 10.6.0 fixada; records.ts/mappers.ts | 128 testes MNY e round-trip ORM próximo de MAX em PostgreSQL real | Domínio e round-trip verificados |
| F06 | Nenhum number/float/double para dinheiro | Money/MoneyProps; NUMERIC(20,2) e DecimalType string nos mappers | Valores grandes preservados no domínio/ORM; numbers limitados a datas/versões/metadados | Verificado em domínio, persistência e contratos HTTP/SQS |
| F07 | Rejeitar entradas inválidas, negativas e moeda conflitante; exigir forma decimal canônica com duas casas, sem normalizar | Domínio, validador de comando e controllers HTTP | Money inválido/numérico, campos internos, moeda, JSON malformado e limites recusados antes de aceitar identidade | Parcial — domínio/aplicação/HTTP verificados; SQS/inbox verificados no recorte da SPEC-005 |
| F08 | Domínio independente do framework/ORM, com catálogo local BRL/USD; aplicação inicialmente BRL | Money usa Decimal.js/erro local; Wallet/ledger só usam domínio local e linguagem | MNY-008/009/021 e WAL-007/014 executados; imports e ciclos verificados por AST; check integrado ao typecheck | Verificado no domínio/aplicação e protegido por check de arquitetura |
| F09 | Entradas, saldos, transações, ledger e apresentação exclusivamente BRL na primeira versão; câmbio fora do escopo | OpenWallet, ProcessTransaction, FinancialQueries e HTTP | BRL na API; USD recusado na abertura/submissão; valores em strings exatas nas consultas | Verificado no recorte HTTP; SQS/inbox verificados no recorte da SPEC-005 |








## Wallet, transações e ledger

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| D01 | Wallet única por player + moeda | OpenWallet, constraint SQL e POST /wallets | Criação única; HTTP 201/409 com walletId recuperável, inclusive após mudança de saldo | Verificado em domínio/SQL/HTTP |
| D02 | Saldo nunca negativo, inclusive por escrita direta | Wallet e migration financeira | Domínio e SQL direto com role app recusam negativo, NaN, infinito e overflow | Verificado no recorte de domínio/persistência |
| D03 | Saldo e ledger correspondentes e atômicos, protegidos por constraints e validações diferidas incrementais no commit | Wallet, MikroFinancialUnitOfWork e validações SQL diferidas | Rollback conjunto; SQL inconsistente recusado; WAL-038–WAL-040; reconciliação final | Verificado no recorte atual de persistência |
| D04 | Sem lost update; mesma moeda; versão inicia 1 e muda só com saldo | Wallet, WagerTransaction e lock pessimista | Disputa de saldo em processos reais; LOSS/rejeição sem versão; replay conserva saldo histórico | Verificado no recorte de aplicação/persistência |
| D05 | Tipos e transições explícitos; estados terminais imutáveis | WagerTransaction e schema | Terminais não reabrem; recuperação de INVALID_REFERENCE_STATE após rollback confirmado, nova unidade/lock e prova de ausência de efeitos | Verificado no recorte classificado; sem classificador genérico |
| D06 | OPENING de origem INTERNAL e identidade estável por wallet; crédito e eventos de abertura na mesma transação | OpenWallet, migration, ledger e classes de eventos | Zero sem registros; positiva/MAX com crédito/OPENING e dois eventos; duplicatas/rollback reais | Verificado no caso de uso/persistência |
| D07 | Ledger append-only, magnitude positiva, aritmética válida e unicidades por wallet/transação e wallet/versão | WalletLedgerEntry e migration financeira | SQL recusa mutação/arithmetic inválida e duplicatas wallet/transação/versão | Verificado no recorte atual de persistência |
| D08 | LOSS e rejeições não criam ledger | WagerTransaction, ProcessTransaction e schema | LOSS/rejeições sem ledger nem alteração de saldo/versão/updatedAt; eventos correspondentes | Verificado na aplicação/persistência |
| D09 | BET debita e rejeita saldo insuficiente; WIN credita dentro da faixa de saldo | ProcessTransaction e WagerTransaction | BET/WIN, rejeição de saldo insuficiente/overflow e replay estável após mudança de saldo | Verificado na aplicação/persistência |
| D10 | REFUND reverte integralmente BET processada | WagerTransaction e índice de reversão | REFUND integral da BET, replay e disputa concorrente com ROLLBACK reais | Verificado no recorte de aplicação |
| D11 | ROLLBACK inverte BET, WIN ou REFUND processada | WagerTransaction e ProcessTransaction | Inversão BET/WIN/REFUND; rejeição REVERSAL_INSUFFICIENT_FUNDS sem movimento | Verificado no recorte de aplicação |
| D12 | Referência no mesmo provider, player, wallet, moeda e rodada; igualdade de valor somente nas reversões | Política de referência em WagerTransaction | Contexto/tipo/estado/magnitude no domínio; WIN 10.00 e LOSS 0.00 sobre BET 25.00 persistidas | Verificado no núcleo compartilhado por HTTP/SQS |
| D13 | Uma reversão efetivada por referência entre REFUND/ROLLBACK, conforme REV-D01 aceita | Índice parcial e política de WagerTransaction | REFUND/ROLLBACK em processos independentes: uma efetivada e outra rejeitada; histórico preservado | Verificado na aplicação/persistência |
| D14 | Referência ausente durável com backoff e limite/TTL | Migration 002, ResumePendingTransaction, scheduler/store/worker | Prazo durável; três processos, TTL/limite e SIGKILL antes/depois de commit; restart retoma sem efeito duplicado | Verificado no recorte local |
| D15 | Failure codes estáveis e distintos por causa | Erros de aplicação/domínio e resultados persistidos | Códigos distintos de BET/reversão, contexto, referência, overflow e corrupção | Verificado em aplicação e apresentação HTTP/SQS |

## Idempotência, concorrência e HTTP

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| A01 | Chave obrigatória, persistente e payload divergente em conflito | Controller HTTP e ProcessTransaction | Idempotency-Key obrigatório; alteração de payload gera 409; replay preserva resultado | Verificado em aplicação/HTTP; SQS/inbox verificados no recorte da SPEC-005 |
| A02 | Hash canônico só de campos de negócio | transaction-command.ts e porta sha256 do runtime | JSON esperado fixado + digest independente; ordem de propriedades/key não alteram hash | Verificado no contrato de comando |
| A03 | Replay mantém resultado e saldo original após outras operações | WagerResult, presenters HTTP e consulta de transação | Replay e GET mantêm saldo histórico; moeda corrompida é recusada sem reescrita (PROC-020) | Verificado em aplicação/persistência/HTTP |
| A04 | Identidade externa por provider sem contornar deduplicação | Schema e ProcessTransaction | Identidade externa com key diferente retorna conflito; corrida global reverte antes de reler | Verificado na aplicação/persistência |
| A05 | Lock por wallet, sem lock global; outras wallets avançam | MikroFinancialUnitOfWork | Três processos independentes; lock observado; wallet B conclui com A bloqueada | Verificado no adaptador |
| A06 | Duas BET de 80.00 em saldo 100.00 | ProcessTransaction e harness de processos | Duas BET 80.00 em 100.00: uma processada, outra rejeitada; saldo 20.00/um débito | Verificado com processos reais; HTTP/SQS/inbox verificados no recorte da SPEC-005 |
| A07 | Mesma BET 50 vezes e pelo menos três instâncias reais | tests/support/use-case-race-worker.ts e suite de aplicação | 50 reenvios em três PIDs; espera pelo lock dos três observada no PostgreSQL; um débito e 49 replays | Verificado na aplicação/persistência |
| A08 | POST wallet e conflito recuperável com walletId existente | POST /wallets, OpenWallet e GET /wallets/:id | 201, 409 com error.details.walletId e recuperação após movimento, sem novo crédito | Verificado em HTTP/PostgreSQL real |
| A09 | Consulta wallet e ledger com cursor opaco estável | FinancialQueries, HmacLedgerCursor e store de leitura | Ordem por versão com timestamps repetidos; recorte fixo com movimento entre páginas; limite 1–100 | Verificado em HTTP/SQL; chave estável exigida |
| A10 | Consulta de transação interna e por provider/ID externo | GET transação interna e GET provider/external ID | Mesmo recurso externo; OPENING consultável sem provider fictício; 404/400 seguros | Verificado em HTTP/SQL |
| A11 | Submissão distingue inválido, conflito, rejeição, pendência e falha transitória | FinancialController e FinancialExceptionFilter | 400/409/422/202/503, 500 seguro; GET de estado existente usa 200; correlação UUID | Verificado em HTTP; SQS/inbox verificados no recorte da SPEC-005 |
| A12 | Reconciliação consistente, sem correção silenciosa | FinancialQueries.reconcile e snapshot READ ONLY/REPEATABLE READ | Commit coordenado entre wallet e soma não altera fotografia; divergência exata/log/counter sem reparo | Verificado em HTTP/SQL e instrumentação local |
| A13 | Health live e ready públicos; ready verifica PostgreSQL/SQS | OperationalService, LocalDependencyProbes e API/workers | Conexões do banco UUID negadas/terminadas, fila removida e endpoint indisponível: ready 503/live 200; health ignora autenticação | Verificado em PostgreSQL/LocalStack/HTTP reais |

## Mensageria e recuperação

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| M01 | Fila FIFO e DLQ exigidas; envelope e messageId compatíveis com transporte | compose.yaml, sqs-client.ts, transaction-envelope.ts e producer | Filas/redrive reais; messageId 1/128 preservado; IDs inválidos recusados ou diagnosticados | Verificado em PostgreSQL/LocalStack |
| M02 | Mesmo caso de uso para HTTP e SQS | ProcessTransaction com entrega opcional validada e handler SQS | Corrida real HTTP/TCP + SQS produz um transactionId, uma inbox e um efeito | Verificado no recorte de consumo |
| M03 | Inbox persistente por consumer/message ID, com hash, vínculo financeiro e origem recuperável de pendências | sqs_inbox/sqs_origins e métodos do contexto financeiro | Hash de envelope distinto do hash de negócio; redelivery sem efeitos; primeira origem imutável; PROC-017 recupera inbox após perda da resposta de COMMIT | Verificado em SQL/SQS reais |
| M04 | Inbox, transação, wallet, ledger e outbox no mesmo commit | FinancialUnitOfWork e migration 003 | Falha depois do flush/inbox reverte inbox/transação/wallet/ledger/outbox no mesmo commit | Verificado no recorte de processamento implementado |
| M05 | ACK após commit e conclusão do encaminhamento exigido; falha posterior ao ACK com tarefa durável | SqsConsumer, HandleSqsDelivery, routing SQL e DispatchDlq | Crash após commit antes de ACK; FAILED automático classificado após ACK cria tarefa e diagnóstico; novo processo envia sem redelivery | Verificado no recorte classificado de referência |
| M06 | Negócio terminal, transiente com retry, permanente com DLQ | Classificação do handler, backoff/visibilidade e diagnóstico persistente | SQL lock transitório sem ACK e redrive nativo; inválido/conflito permanente com DLQ; rejeição de negócio ACKa | Verificado no consumo e no recorte permanente INVALID_REFERENCE_STATE |
| M07 | SIGTERM conclui ou devolve visibilidade | SqsConsumer e entrypoint sqs-worker.ts | SIGTERM em processo com operação admitida drena antes de ACK; queued não é liberada durante commit local | Verificado no cenário de shutdown exercitado |
| M08 | Nenhuma publicação antes do commit financeiro | PublishOutbox e MikroFinancialOutboxStore | Eventos em unidade financeira aberta não são claimáveis; rollback não envia; commit e crash retomam | Verificado em PostgreSQL/LocalStack |
| M09 | Dois publishers, claims recuperáveis e duplicata segura | Store e processos de publisher; consumidor persistente de teste | Dois PIDs/pools com claims distintos; lease/heartbeat/fencing; SIGKILL após envio e replay deduplicado | Verificado no recorte local de publicação |
| M10 | Quatro eventos mínimos e envelope concreto versionado | IntegrationEvent/classes, financial-outbox.ts e publisher | Quatro envelopes v1 preservados no SQS, MoneyProps em strings, IDs estáveis e payload imutável | Verificado em enfileiramento/publicação local |
| M11 | WalletBalanceChanged só quando saldo muda; Processed inclui LOSS | Domínio/casos de uso e publicação por outbox | LOSS/abertura/rejeição/pendência/conclusão preservam matriz; replays não recriam eventos | Verificado em PostgreSQL/LocalStack |
| M12 | Reinício retoma pendências, eventos e transferências DLQ sem perder responsabilidades confirmadas | Inbox/origem, DLQ, publisher e scheduler duráveis | Consumidores/dispatcher/publisher/scheduler retomam por banco/fila; crash antes/depois de envio; suspensão/retomada auditada | Verificado no recorte local; scheduler e recuperação restrita em financial-references.test.ts |

## Observabilidade, documentação e escopo

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| O01 | Logs JSON com IDs exigidos, sem dados sensíveis/payload completo | FinancialTelemetry, OperationalTelemetry e instrumentação de API/workers | Campos/enums catalogados, UTC/role/instanceId/correlação; sem corpo/quantias/segredos; sink falho não altera resultado | Verificado no recorte local |
| O02 | Métricas por estado, duplicatas, retry, DLQ, locks, lag e latência | Registro Prometheus por processo e OperationalService | Transições pós-commit/replays, retry/locks/latência/envios/DLQ, backlog/lag suspenso e erro/desatualização; labels limitadas | Verificado no recorte local; sem TSDB/dashboard |
| O03 | Unidade, integração e concorrência reais com Bun | Testes unitários, integração real e processos independentes | Resultados atuais em evidence.md/delivery.md; instalação congelada/typecheck/build concluídos | Verificado no recorte funcional local; carga opcional não executada |
| O04 | Invariante final saldo = reconstrução pelo ledger | Reconciliação de produto e asserções de integração | Fotografia consistente e soma NUMERIC; diagnósticos maiores que MAX preservam precisão; sem reparo | Verificado em HTTP/SQL e cenários financeiros de mensageria |
| O05 | README com setup e comandos reais | README, scripts de setup/producer/recovery e Compose | API/consumidor/DLQ/publisher disponíveis localmente; inspeção/retomada por ID com auditoria | Verificado no setup local implementado |
| O06 | Arquitetura, decisões, trade-offs e limitações documentados | ARCHITECTURE.md, ADRs e specs | Estado atual, recortes históricos e limites da entrega separados | Documentado e revisado na preparação da entrega |
| O07 | Autenticação externa omitida com decisão e ponto de extensão | ProviderIdentityPort, guard e composição local explícita | Guard invoca porta injetável; testes permitem negar acesso; implementação local não autentica | IdP adiado; ponto de extensão implementado |
| O08 | Carga opcional com ambiente e p50/p95/p99 | Fora do mínimo inicial | Se aprovado: script, metodologia e números medidos | Opcional; não iniciado |

## Critério para mudar o estado de um requisito

Substituir destino por caminhos reais e registrar teste/comando, ambiente e resultado. **Implementado** pode indicar código ainda sem comprovação completa; **Verificado** exige a evidência executada. Não usar porcentagens de conclusão baseadas apenas em número de arquivos.

Se um teste depende de Docker ou de uma conexão indisponível, registrar a limitação e manter a evidência pendente. Não substituir o teste real por mock para marcar o requisito como verificado.

São bloqueadores de uma entrega financeira: ponto flutuante monetário, saldo negativo por corrida, efeito duplicado, deduplicação só em memória, correção só com uma instância, publicação antes de commit, ledger ausente ou integração inteiramente simulada.


## Melhorias após avaliação técnica

SQS-017 prova recebimentos concorrentes após perda de heartbeat; SQS-025 prova
crash antes/depois do envio tardio à DLQ. Os entrypoints reais de workers têm
provas de limpeza normal e travada. Contextos explícitos correlacionam retry/lock
e SQS até ACK. Setup único, exemplos, estilo fixado e workflow Linux estão versionados.
A [matriz de avaliação](evidence.md) e o [relatório](delivery.md) descrevem resultados
e limites, distinguindo Linux local de execução hospedada ainda não realizada.

## Reavaliação: integridade e COMMIT incerto

WagerTransaction valida moeda do resultado persistido sem invalidar rejeições
antecipadas de contexto. financial-http.test.ts prova erro seguro de consulta e
replay, sem reparo silencioso. financial-commit-loss.test.ts usa proxy TCP real,
observa a confirmação do servidor e interrompe sua resposta: indisponibilidade,
um único efeito, inbox/outbox preservadas e replay histórico após outra operação.
O classificador PostgreSQL compartilhado reconhece erros conhecidos de desconexão;
erros genéricos continuam propagando, sem autorizar FAILED.
