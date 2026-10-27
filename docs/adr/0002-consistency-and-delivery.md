# 0002 — Consistência no PostgreSQL e entrega at-least-once

Estado: aceita em 26/10/2026; PostgreSQL, inbox/outbox, SQS, agendador e recuperação restrita verificados no recorte local.

As evidências datadas preservam o estado de cada etapa. O estado atual consolidado está na [revisão de entrega](../delivery.md).

## Contexto

Mensagens podem chegar duplicadas, fora de ordem ou em paralelo com chamadas HTTP. Um processo pode morrer após commit e antes de ACK/publicação. O banco deve impedir duplicação financeira e saldo negativo em múltiplas instâncias.

## Decisão

- PostgreSQL e MikroORM, com unidade de trabalho e Identity Map explícitos. Cada operação usa um contexto exclusivo, com todos os repositórios compartilhando o mesmo EntityManager transacional.
- Lock pessimista por linha da wallet, com isolamento inicial `READ COMMITTED`, ordem comum de locks e retry limitado para falhas transitórias classificadas.
- Constraints/índices para idempotency key global, identidade externa por provider, reversões efetivadas, inbox e ledger. Schema também protege não-negatividade e imutabilidade; consistência cruzada usa constraints relacionais e validações diferidas incrementais no commit, conforme Q-WAL-04 aprovada na SPEC-002.
- Idempotência com hash canônico SHA-256 e resposta terminal original persistida.
- Inbox, efeitos financeiros e outbox na mesma transação; ACK depois do commit.
- SQS FIFO via LocalStack no Compose. Ordenação por wallet é otimização.
- Outbox com lote concorrente `SKIP LOCKED`, claim/lease, envio fora da transação e confirmação condicional pelo token do claim.
- Referências ausentes ficam persistidas para worker com backoff e limite/TTL. Parâmetros ainda serão definidos.

### Complementos aceitos após revisão em 27/10/2026

- **Reversão efetivada única (REV-D01):** uma referência pode ser revertida uma única vez pelo conjunto REFUND/ROLLBACK. A unicidade parcial por referenceTransactionId para operações PROCESSED não inclui kind. Rejeições, falhas e pendências não consomem a reserva. Isso amplia explicitamente a proteção mínima por referência/tipo do desafio para impedir crédito duplicado por REFUND + ROLLBACK da mesma BET. ROLLBACK de uma REFUND usa a referência REFUND, sem reabrir a BET nem liberar sua reserva.
- **Identidade compatível com FIFO (SQS-D04):** messageId contém de 1 a 128 caracteres ASCII de letras, dígitos, hífen e underscore, sem normalização. Usá-lo diretamente como MessageDeduplicationId na entrada. A alternativa de aceitar IDs arbitrários e derivar um hash de transporte foi descartada para manter um contrato simples entre produtor e consumidor. Transferências à DLQ usam transferId UUID próprio.
- **Responsabilidade após ACK (SQS-D05):** antes de confirmar uma pendência recebida por SQS, preservar a origem canônica e o corpo original em armazenamento operacional restrito. Se o worker terminar a operação em FAILED, confirmar também a tarefa tardia de DLQ na mesma transação de recuperação. Um dispatcher com claims/leases consulta as tarefas no banco e envia após commit, sem exigir redelivery ou receipt handle. A responsabilidade tardia é única por transação/motivo; múltiplos replays já confirmados não multiplicam esse encaminhamento. Sem origem SQS, persistir diagnóstico de falha sem inventar mensagem. Corpo/identidade são imutáveis; confirmação, tentativas e claims são metadados operacionais.

O dispatcher pode executar no role consumidor. A alternativa de depender apenas do recebimento da mensagem original foi descartada porque o ACK já pode tê-la removido. O custo é manter dados de recuperação e tarefas operacionais duráveis, com comando documentado de inspeção/retomada para suspensões. Não introduzir um serviço ou barramento distribuído adicional.

### Proteção do ledger e saldo aceita em 26/10/2026

Q-WAL-04 foi aprovada: PostgreSQL deve recusar commits com saldo sem ledger, ledger sem movimentação válida, inconsistência de moeda/valor/versão ou invalidação do histórico. Regras locais usam constraints; relações financeiras entre registros usam constraint triggers diferidas e verificações por wallet/versão/vizinhos indexados. A estratégia cobre abertura zero/positiva e múltiplas mudanças na mesma unidade SQL sem reler todo o histórico a cada movimento.

Aplicação usa papel sem privilégios para alterar schema, desativar proteções ou editar/excluir/truncar ledger. Funções, permissões, DDL e cobertura de todas as tabelas relevantes serão implementados em migrations e demonstrados por testes reais. A aprovação define a estratégia; não é evidência de correção do SQL ainda inexistente. Mudanças necessárias à estratégia devem passar por revisão explícita.

### Compatibilidade do adaptador aceita em 27/10/2026

Cada movimentação deve chegar ao PostgreSQL como uma transição financeira própria, ainda que compartilhe a unidade SQL com outras. A porta de persistência preserva os snapshots intermediários; o adaptador usa flushes controlados ou UPDATEs explícitos no mesmo contexto, com Identity Map coerente. Manter uma única transação explícita, o lock da wallet e um único commit externo. A alternativa de mapear somente o estado final e fazer um flush ao término foi descartada para esse caso, pois pode eliminar mudanças intermediárias ou emitir um salto de versão incompatível com os triggers.

Provar primeiro WAL-038–WAL-040 com MikroORM/PostgreSQL reais: dois movimentos que retornam ao mesmo saldo, rollback após flush intermediário e abertura seguida de movimento no mesmo commit. Essa prova antecede a dependência dos fluxos completos no adaptador e não significa que a estratégia já esteja implementada.

## Alternativas consideradas

- Optimistic locking: válido, mas adiciona retries sob disputa frequente pela mesma wallet. Pode ser reconsiderado com medições.
- Atualização atômica condicionada: protege saldo, mas exige coordenação cuidadosa com referência, ledger e resposta original; lock de linha facilita explicar a sequência completa.
- Mutex em memória ou lock global: não preserva correção entre processos ou elimina paralelismo entre wallets.
- Somente FIFO/deduplicação do broker: não cobre HTTP nem unicidades permanentes no banco.
- Publicar diretamente no caso de uso: cria janela de perda de evento ou publicação sem commit.
- Publicação externa mantendo lock SQL: alonga transações e prende conexões durante indisponibilidade do broker.

## Consequências e limitações

Uma wallet disputada serializa suas operações. Claims da outbox precisam de expiração e retomada. Publicação duplicada é possível após envio e antes de marcar publicado; event ID estável e deduplicação persistente no consumidor são necessários. Não há exactly-once entre banco e SQS.

Uma falha transitória não deve se tornar rejeição financeira. Erro SQL que aborta a transação exige rollback antes de novas consultas. Workers de referências precisam respeitar wallet antes de registro de transação para evitar inversão de locks.

## Como validar

PostgreSQL e LocalStack reais; duas apostas disputando saldo; 50 reenvios; três processos; dois publishers; redelivery após commit; crash após publicação; referência fora de ordem; migrations e tentativas diretas de violar constraints. Ao final, conferir ledger, saldo, unicidades e retomada dos registros pendentes.

Incluir também REFUND/ROLLBACK concorrentes e sequenciais sobre a mesma referência, limites de messageId e FAILED após ACK com crash antes/depois do envio tardio à DLQ. Validar retomada com fila de origem vazia, responsabilidade única e corpo/transferId preservados.

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

## Agendador e recuperação segura verificados — 27/10/2026

Etapa autorizada aplicou polling de 1 s após lote, até 50 IDs e cinco operações
concorrentes. Seleção sem lock financeiro; revalidação sob lock da wallet. Cursor
local evita ficar preso nos primeiros erros; cronograma permanece no PostgreSQL.
Expiração é REJECTED de negócio, com evento e sem DLQ. Retry revertido não consome
check nem prorroga prazo. Reinício não depende de memória ou de redelivery SQS.

Classificação automática restrita à reidratação inválida da referência persistida:
INVALID_REFERENCE_STATE. O helper callback do driver SQL, associado ao EntityManager
exclusivo, propaga falha de rollback e libera a conexão. O helper transacional de
alto nível suprime esse erro; a alternativa de usá-lo como certificado foi descartada.
Após rollback confirmado, nova unidade/lock verifica estado/agendamento, ausência
de efeitos e persistência da falha. Outro terminal/referência reparada prevalecem.
Corrupção da própria pendência/wallet, erro genérico, falha de conexão e commit incerto
não autorizam FAILED. Nenhuma dependência nova ou reparo financeiro foi introduzido.

Migration 005 mantém diagnóstico imutável/correlacionado no mesmo commit do terminal
e da tarefa canônica de DLQ quando há origem SQS. Sem origem, não inventa mensagem.
Inspeção é somente de metadados; FAILED não reabre. Worker tem drenagem e limite de
shutdown. A prova de conexão perdida também verifica que o pool consegue fechar.

565 testes aprovados/zero falhas/2.100 asserções (403 unitários + 162 integrações).
Inclui três processos, SIGKILL antes/depois de commit, SIGTERM, terminal concorrente,
referência reparada, falha na escrita de tarefa/diagnóstico e dispatcher separado
após ACK/crash. Evidência: tests/integration/financial-references.test.ts. Não é
classificador genérico de todas as falhas permanentes. Health, IdP e observabilidade
completa continuam pendentes. Commit/push/deploy não foram realizados nesta etapa.
