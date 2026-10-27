# SPEC-006 — Outbox e eventos de integração

| Campo | Conteúdo |
|---|---|
| ID | SPEC-006 |
| Estado | Rascunho |
| Revisão | 0.1 |
| Requisitos relacionados | M04, M08–M12, D06, D08, O01–O04 |
| Dependências | SPEC-002 e contratos de SPEC-003/SPEC-004; SQS/LocalStack da SPEC-005 |
| Aprovação do conteúdo | Revisão prevista antes da implementação; defaults recomendados |
| Implementação | Não iniciada |

## Objetivo e limites

Persistir a intenção de publicação junto ao resultado financeiro e permitir que publishers concorrentes retomem eventos após falhas. Não há publicação externa antes do commit nem promessa de exactly-once entre banco e broker.

O publisher não recalcula saldo, reaplica apostas ou cria um evento novo ao tentar publicar novamente. Projeções, notificações e barramento genérico são extensões opcionais; o mínimo é emitir eventos financeiros verificáveis em uma fila separada de comandos.

## Eventos e contratos

Usar `IntegrationEvent` abstrata e uma classe concreta por tipo, com tipo/versão definidos na classe. Envelope mínimo: eventId, eventType, aggregateId, correlationId, causationId opcional, occurredAt UTC, version e data. Payload persistido é JSON imutável com MoneyProps, sem instância ORM ou Money.

Default EVT-D01: aggregateId é walletId nos eventos financeiros; transactionId fica em data. eventId é UUID estável gerado uma vez e reaproveitado em toda tentativa. causationId referencia o comando/mensagem que originou o fato; no worker de referência, preservar vínculo à operação original e à execução atual em metadados apropriados.

| Evento v1 | Quando | Dados mínimos recomendados |
|---|---|---|
| WagerTransactionProcessed | PROCESSED, incluindo LOSS e OPENING positiva | transactionId, walletId, playerId, origin, kind, money, balance observado e processedAt; provider/IDs externos somente quando houver |
| WagerTransactionRejected | Rejeição de negócio, inclusive expiração de referência | transactionId, walletId, origin, kind, failureCode e instante da rejeição |
| WalletBalanceChanged | Mudança efetiva de saldo, incluindo abertura positiva | transactionId, walletId, direction, money, balanceBefore, balanceAfter e walletVersion |
| WagerTransactionPendingReference | Primeira transição para espera de referência | transactionId, walletId, providerId, referência externa, motivo e instante de entrada |

OPENING usa origin INTERNAL, sem provedor/jogo/rodada fictícios; demais operações externas usam PROVIDER. LOSS produz Processed, mas não BalanceChanged. Rejeição não produz BalanceChanged. Abertura zero não produz esses eventos. Reagendamento da mesma pendência não produz outro PendingReference.

Default EVT-D02: proteger eventId e a identidade lógica `(transactionId, eventType)` da emissão financeira para não recriar o mesmo fato durante replay/recuperação. A transição pendente e sua posterior conclusão têm tipos diferentes. Não usar essa unicidade genérica para futuros domínios que precisem repetir eventos do mesmo tipo sem nova decisão de identidade.

## Modelo de outbox

Registro contém envelope imutável, transactionId/aggregateId, occurredAt, attempts, nextAttemptAt, publishedAt opcional, claimToken, leaseUntil e estado operacional de suspensão quando necessário. Claims/tentativas são mutáveis; payload/eventId não são.

A transação financeira insere outbox no mesmo EntityManager de wallet, ledger, inbox e resultado. Falha em qualquer gravação ou trigger desfaz o conjunto. Um commit financeiro bem-sucedido deixa os eventos disponíveis para outro processo mesmo se o processo original morrer.

## Publisher concorrente — EVT-D03

Defaults recomendados:

| Parâmetro | Valor |
|---|---|
| Lote | Até 10 registros vencidos por claim |
| Polling sem trabalho | 1 segundo, com jitter entre réplicas |
| Lease | 30 segundos, renovado a cada 10 segundos quando necessário |
| Timeout de envio | 5 segundos por tentativa |
| Backoff | Base 1 segundo, exponencial, teto 300 segundos, com jitter |
| Limite automático | 10 falhas consecutivas antes de suspensão operacional e alerta |
| Fila de saída | wager-events.fifo |
| DLQ de saída | wager-events-dlq.fifo, para política do consumidor de eventos |

1. Em transação curta, selecionar lote elegível por `FOR UPDATE SKIP LOCKED`, registrar claimToken exclusivo e lease; confirmar e liberar locks.
2. Publicar fora da transação SQL, conferindo/renovando o claim antes de enviar. Limitar concorrência e lote para que registros não expirem aguardando execução local.
3. Enviar com MessageDeduplicationId igual a eventId e MessageGroupId igual a aggregateId.
4. Após sucesso, marcar publishedAt por atualização condicional no token/lease vigente. Um publisher antigo não pode confirmar o claim de outro.
5. Em falha, incrementar attempts e nextAttemptAt apenas se ainda possuir o claim. Expiração permite retomada por outra instância.

Se o SQS aceitar o envio e o processo morrer antes da confirmação SQL, haverá nova tentativa com o mesmo eventId. A duplicata é esperada e deve ser segura para o consumidor. A janela de deduplicação do broker não é suficiente: a demonstração usa consumidor de teste com deduplicação persistente por eventId.

FIFO preserva ordem de chegada ao grupo, mas publishers distintos podem enviar fatos em ordem diferente da ocorrência. Esta versão não promete ordem global nem ordem estrita de versões emitidas. Consumidores precisam reconhecer duplicatas e eventos atrasados; WalletBalanceChanged inclui walletVersion para esse controle. Garantia de publicação estritamente ordenada por wallet é uma otimização opcional, não base da correção financeira.

## Suspensão, recuperação e encerramento

Ao atingir o limite automático, manter o registro recuperável e não publicado, suspender novas tentativas automáticas e emitir diagnóstico/alerta. Não apagar, fingir sucesso ou descartar o evento. O limite pausa automação, não encerra a obrigação de entrega. Falhas de longa duração exigem retomada operacional explícita, com o mesmo eventId/payload.

Ferramenta administrativa mínima pode ser um comando local documentado para inspecionar e retomar registros selecionados, com trilha de operador/horário e sem publicar dentro de uma transação financeira. Um dashboard é opcional. Payload inválido por bug exige correção controlada e nova decisão de compatibilidade; não reescrever silenciosamente um fato histórico.

No SIGTERM, parar novos claims, concluir envios dentro do prazo e liberar claims não enviados ou deixar leases expirarem. Resultado de envio incerto continua não publicado até nova confirmação segura; não alterar a transação financeira terminal.

Retenção/limpeza automática de outbox e inbox fica fora da primeira versão. Ledger nunca participa de limpeza operacional. Qualquer política futura de arquivamento precisa preservar rastreabilidade e capacidade de replay.

## Falhas e observabilidade

| Falha | Comportamento |
|---|---|
| Banco indisponível antes do claim | Nenhum envio autorizado pelo claim; retry do polling |
| SQS indisponível após claim | Backoff persistido ou retomada após lease, sem perder evento |
| Timeout de envio com resultado incerto | Reenvio pelo mesmo eventId; possível duplicata |
| Lease perdido durante envio | Publisher antigo não marca publicado; consumidor tolera duplicata |
| Crash após envio e antes de publishedAt | Outro publisher retoma; teste demonstra deduplicação |
| Falha de schema/envelope | Diagnóstico e suspensão recuperável, sem alterar fato financeiro |

Medir tentativas, suspensões, publicações e idade do evento pendente mais antigo. Logs usam IDs de correlação/evento/transação/wallet, sem payload financeiro completo. Métricas e status não substituem registros duráveis.

## Cenários de aceite

| ID | Condição | Resultado esperado |
|---|---|---|
| EVT-001 | Rollback financeiro depois de enfileirar evento | Nenhum evento visível para publicação |
| EVT-002 | Commit financeiro e morte antes de publicar | Outro processo publica o evento persistido |
| EVT-003 | Dois publishers disputam o mesmo conjunto | Claims distintos; nenhum registro abandonado |
| EVT-004 | Crash após envio e antes de confirmação | Reenvio com mesmo eventId; consumidor persistente aplica uma vez |
| EVT-005 | Publisher antigo confirma após perder lease | Atualização rejeitada pelo fencing de claimToken |
| EVT-006 | Falhas de SQS e reinício | attempts/agendamento/claims retomáveis, sem perda |
| EVT-007 | Limite de falhas atingido | Registro suspenso recuperável; alerta; nenhuma marca falsa de sucesso |
| EVT-008 | Retomada operacional selecionada | Mesmo envelope/eventId, com trilha de recuperação |
| EVT-009 | LOSS, rejeição, abertura zero e abertura positiva | Matriz de eventos respeitada, sem evento artificial de saldo |
| EVT-010 | Retry/replay do comando e repetição de pendência | Não recriar fatos já enfileirados |
| EVT-011 | Serializar os quatro tipos | Classe concreta, versão, IDs, datas e MoneyProps corretos |
| EVT-012 | Eventos chegam fora de ordem ao consumidor de teste | Controle por identidade/versão impede efeito duplicado ou regressão indevida |
| EVT-013 | SIGTERM e lote parcialmente enviado | Claims/leases permitem continuação segura por outra instância |
| EVT-014 | Tentar modificar eventId ou payload persistido por escrita da aplicação | Proteção de integridade recusa alteração do fato |

## Testes e revisão

PostgreSQL e LocalStack reais; dois publishers em processos independentes; barreiras antes/depois de envio e confirmação; consumidor de teste com inbox própria para eventId. Inspecionar outbox, mensagens e ledger, sem inferir deduplicação apenas pela ausência de duplicata observada no broker.

EVT-D01 a EVT-D03 são recomendações de contrato/configuração. Revisar limites após medir latência; não ampliar retries sem limitar recursos. Dashboard, ordem estrita de publicação e limpeza automática são opcionais. Entrega recuperável, fencing, diagnóstico e deduplicação demonstrada são parte do mínimo.

Rascunho 0.1 de 26/10/2026. Não há publisher, consumidor de eventos de produção ou testes implementados. Não existe evidência de entrega executada nesta etapa documental.
