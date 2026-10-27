# SPEC-005 — Consumo SQS e inbox persistente

| Campo | Conteúdo |
|---|---|
| ID | SPEC-005 |
| Estado | Consumo/inbox/DLQ implementados e verificados no recorte abaixo |
| Revisão | 0.6 |
| Requisitos relacionados | F02, M01–M07, M12, A07, D05, O01–O04 |
| Dependências | SPEC-003, SPEC-004 e persistência da SPEC-002; eventos da SPEC-006 |
| Aprovação do conteúdo | Etapa SQS/LocalStack e inbox autorizada em 27/10/2026; defaults SQS-D01–D03 adotados neste recorte, mantendo SQS-D04/D05 |
| Implementação | Consumidor, producer, inbox/origem, dispatcher/retomada e encaminhamento tardio de FAILED classificado pelo agendador |

## Objetivo e limites

Receber comandos com entrega at-least-once, confirmar efeitos uma única vez no banco e retomar após morte de processo. Consumir SQS não cria regras financeiras próprias: usar o caso de uso da [SPEC-003](003-wager-processing-and-idempotency.md).

Não promete exactly-once entre SQS e PostgreSQL. FIFO e deduplicação do broker são otimizações. Não inclui publicação de eventos, que pertence à [SPEC-006](006-outbox-and-events.md), nem redrive automático irrestrito de mensagens em DLQ.

## Filas e parâmetros recomendados — SQS-D01

| Configuração | Default proposto |
|---|---|
| Emulador local | LocalStack em Docker Compose, com versão fixada ao implementar |
| Entrada | wager-transactions.fifo |
| DLQ | wager-transactions-dlq.fifo |
| MessageGroupId | walletId, validado contra o comando; produtor local deve usar esse valor |
| MessageDeduplicationId | messageId estável do envelope, ASCII conforme SQS-D04; na transferência manual à DLQ, transferId UUID estável |
| Long polling | 20 segundos |
| Lote de leitura | Até 10 mensagens, respeitando capacidade disponível |
| Visibilidade | 60 segundos, renovada a cada 20 segundos enquanto houver trabalho válido |
| Redrive | maxReceiveCount 5 para falhas transitórias não concluídas |
| Backoff de falha transitória | Exponencial com jitter, base 1 segundo e teto 30 segundos via visibilidade |
| Retenção local | Entrada 4 dias; DLQ 14 dias; não tratar DLQ como arquivo permanente |
| Shutdown | Janela de 30 segundos, configurável e menor que o prazo de encerramento do container |

Esses valores são parâmetros de operação propostos, não números obrigatórios do domínio. Nenhum worker pode receber um lote maior do que consegue manter sob visibilidade/heartbeat. Mensagens do mesmo grupo em um lote são processadas sequencialmente; grupos distintos podem avançar em paralelo.

Uma mensagem em DLQ pode liberar o grupo FIFO e mudar a ordem observável de dependências. O domínio continua responsável por referências fora de ordem. A deduplicação FIFO tem janela limitada e não substitui a inbox. Referências técnicas: [termos FIFO](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-key-terms.html), [visibilidade](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) e [DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html).

## Envelope

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-26T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "game-001",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Validar JSON, tipo esperado, messageId conforme SQS-D04, occurredAt ISO válido e contrato do comando. O horário de transporte não determina saldo nem substitui o relógio do processamento. O envelope não pode fornecer origem INTERNAL, estado terminal ou versão da wallet.

messageId do envelope identifica a mensagem de negócio. MessageId e ReceiptHandle do SQS são metadados de transporte diferentes; nunca substituir a identidade da inbox pelo receipt handle. Um novo envio do mesmo comando pode ter outro envelope ID e ainda ser replay financeiro pela idempotency key.

### Formato de messageId — SQS-D04

Contrato adotado na revisão de 27/10/2026: string ASCII de 1 a 128 caracteres, formada somente por letras A–Z/a–z, dígitos, hífen e underscore (`^[A-Za-z0-9_-]{1,128}$`). O ID diferencia maiúsculas/minúsculas e não sofre trim, truncamento ou normalização. UUIDs e o exemplo `msg-123` são válidos. Rejeitar vazio, espaços, Unicode fora desse conjunto e comprimento excedido.

O produtor valida esse formato antes de enviar e usa o próprio messageId como MessageDeduplicationId. O consumidor também valida o envelope, pois receber uma mensagem do SQS não comprova que seus campos internos seguiram o contrato. Corpo inválido segue o diagnóstico/DLQ sem criar inbox financeira válida. A identidade de transferência à DLQ é um UUID gerado pelo backend, não uma cópia de um messageId inválido.

O subconjunto escolhido cabe no limite de 128 caracteres do identificador de deduplicação FIFO e evita divergências entre contrato e transporte. Referência: [SendMessage — MessageDeduplicationId](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html).

## Inbox e unidade de trabalho — SQS-D02

ConsumerName estável recomendado: `wager-transactions-v1`, compartilhado por todas as réplicas desse consumidor, sem PID ou nome de instância na chave. Unicidade `(consumerName, messageId)` no banco.

Persistir payloadHash da representação canônica do envelope validado: messageId, type, occurredAt e data, incluindo a key de negócio. Excluir receipt handle, contador de entregas e atributos técnicos SQS. Este hash detecta mudança no conteúdo de uma mensagem; não é o hash de negócio da SPEC-003, que exclui metadados de transporte.

- Mensagem nova: registrar inbox no mesmo commit de transação, saldo, ledger e outbox.
- Mesmo envelope ID e mesmo hash já confirmado: não reaplicar efeitos financeiros. ACK só pode ser repetido se a disposição durável da entrega permitir; confirmação da inbox não dispensa transferência pendente à DLQ.
- Mesmo envelope ID e hash diferente: INBOX_PAYLOAD_CONFLICT, sem sobrescrever a inbox original ou aplicar o novo conteúdo.
- Comando já processado por HTTP, mas envelope novo: registrar a nova inbox e associar o replay no mesmo contexto SQL, sem novo efeito financeiro.
- PENDING_REFERENCE: confirmar inbox, pendência/evento e origem recuperável descrita abaixo; fazer ACK. O worker persistente da SPEC-004 assume a continuação.

Para uma pendência com entrada SQS, guardar antes do ACK uma origem canônica: vínculo à primeira inbox SQS confirmada para a transação, corpo original imutável e metadados necessários ao encaminhamento, incluindo MessageGroupId e MessageId do transporte. Preservar esses dados em armazenamento operacional restrito, separado dos logs, com integridade e vínculo à transação. A escolha da primeira origem ocorre sob o lock da wallet; envelopes posteriores de replay apontam a mesma transação e não substituem a origem canônica. Isso também vale quando uma pendência nasceu por HTTP e recebe seu primeiro envelope SQS depois. A captura de origem é metadado operacional, sem alterar o comando financeiro ou seu hash.

Além do resultado financeiro, persistir a disposição da entrega: ACK_AFTER_COMMIT para resultados concluídos sem encaminhamento permanente, ou DLQ_REQUIRED para FAILED e demais casos que exigem DLQ. No segundo caso, guardar identidade estável da transferência, vínculo com inbox/diagnóstico e dlqConfirmedAt opcional. processedAt indica conclusão do tratamento financeiro ou diagnóstico, não conclusão automática da transferência. A disposição DLQ_REQUIRED deve ser durável antes de qualquer tentativa de remover a origem.

Cada responsabilidade de transferência possui registro recuperável com transferId UUID, identidade da origem, destino, corpo imutável, MessageGroupId válido, attempts, nextAttemptAt, claimToken, leaseUntil, suspensão operacional e dlqConfirmedAt. O consumidor pode solicitar envio imediato após commit, mas a retomada também consulta esses registros no PostgreSQL e independe da presença da mensagem na fila de origem. Uma origem diagnóstica de conteúdo inválido é distinta da inbox original quando houver INBOX_PAYLOAD_CONFLICT; não sobrescrever seu corpo ou resultado confirmado.

Ao tratar resultado FAILED ou replay de FAILED, criar/consultar a responsabilidade pela DLQ, mesmo que o resultado original tenha vindo por HTTP ou a inbox já exista. Uma disposição anterior de ACK não pode mascarar um encaminhamento obrigatório reconhecido nesta entrega. Atualizar os metadados operacionais em contexto seguro, respeitando a ordem de locks; não reabrir a transação financeira terminal.

Um replay de inbox confirmada como pendência consulta também o estado financeiro durável corrente antes do atalho de ACK. Se tiver evoluído para FAILED, verificar/reutilizar a responsabilidade da origem correspondente ou criar o encaminhamento dessa entrega conforme a regra acima. Não concluir pelo resultado PENDING_REFERENCE antigo armazenado no momento do primeiro ACK.

Manter a ordem de locks da aplicação: wallet antes dos registros financeiros/inbox quando houver wallet válida. Uma leitura inicial da inbox pode reconhecer replay, mas não adquire locks em ordem inversa nem autoriza um novo efeito.

Em falha SQL, rollback remove também a inbox ainda não confirmada. Não marcar processedAt em commit separado antes de aplicar a operação. Na recuperação, usar novo contexto e descartar entidades de uma tentativa revertida.

## ACK, retry e DLQ — SQS-D03

| Situação | Ação |
|---|---|
| PROCESSED ou seu replay | DeleteMessage depois do commit financeiro/inbox e da verificação de que não há DLQ pendente |
| REJECTED de negócio ou seu replay | ACK depois do commit auditável/evento, desde que a disposição da entrega não exija DLQ |
| PENDING_REFERENCE | ACK depois de persistir responsabilidade do worker |
| FAILED, replay de FAILED ou inbox com DLQ_REQUIRED | Transferir/retomar DLQ; DeleteMessage somente após envio confirmado e confirmação durável do encaminhamento |
| Erro transitório de SQL/SQS/lock | Rollback quando aplicável; sem ACK; ajustar visibilidade com backoff e respeitar redrive |
| Falha de DeleteMessage após commit | Permitir redelivery e deduplicação; não desfazer o efeito financeiro |
| Envelope inválido, conflito permanente de identidade/inbox ou comando impossível de admitir | Diagnóstico persistente seguro e transferência para DLQ; remover origem só após confirmação do destino |

Para mensagens permanentes, usar envio explícito à DLQ, preservando corpo original e identificadores relevantes em canal restrito. Registrar metadados de falha, hash e corpo necessário à transferência em armazenamento operacional durável quando o banco estiver acessível, sem criar uma WagerTransaction inválida ou inventar wallet. Proposta de chave diagnóstica: consumerName, MessageId do transporte e hash do corpo. O corpo completo fica apenas no armazenamento restrito de recuperação e na fila, nunca nos logs. Preservar o MessageGroupId válido dos metadados SQS, inclusive quando o walletId do corpo for inválido; MessageDeduplicationId da transferência usa transferId.

Se o banco de diagnóstico estiver indisponível, tratar a entrega como transitória em vez de ACK silencioso. O redrive nativo permanece uma última proteção para mensagens não concluídas; sua chegada pode exigir reconstrução do diagnóstico pelos metadados da DLQ. Se o envio manual à DLQ falhar ou tiver resultado incerto, não apagar a origem. Duplicatas de diagnóstico/DLQ são possíveis; usar identidade estável, sem confiar só na janela FIFO.

FAILED financeiro só segue a condição segura da SPEC-003. Um JSON inválido não é uma transação financeira FAILED. Uma transação FAILED já auditada segue para DLQ com a referência correspondente; nenhuma falha de transporte reabre estado terminal.

### Retomada da transferência permanente

1. Persistir DLQ_REQUIRED e um transferId estável para o conteúdo/entrega relevante, junto à auditoria financeira ou operacional. Não marcar a responsabilidade como concluída só porque existe inbox confirmada.
2. Enviar à DLQ fora da transação financeira, usando a mesma identidade da transferência nos retries.
3. Depois de confirmação positiva do SQS, registrar dlqConfirmedAt em transação operacional curta. Essa atualização não altera wallet, ledger ou estado terminal de WagerTransaction.
4. Fazer DeleteMessage da origem apenas quando o registro durável indicar envio confirmado para a identidade de transferência correspondente.
5. Se ocorrer crash antes de registrar a confirmação, retomar o envio; duplicata na DLQ é possível e precisa ser reconhecível pela identidade estável. Se a confirmação durável já existir, a redelivery pode concluir somente o ACK.

A obrigação de DLQ tem precedência sobre o atalho de deduplicação/replay. Falha ou resultado incerto de envio/registro mantém a origem sem ACK; nunca reaplicar o efeito financeiro para tentar concluir transporte. O redrive nativo continua como proteção para entregas não concluídas, sem autorizar exclusão antecipada pela aplicação.

### Encaminhamento tardio e dispatcher recuperável — SQS-D05

PENDING_REFERENCE pode receber ACK antes de alcançar um estado terminal. Se depois terminar em FAILED no worker da SPEC-004, a mensagem original já pode estar ausente da fila. Havendo origem SQS canônica, a transação de recuperação que grava FAILED deve criar também uma responsabilidade DLQ_REQUIRED a partir dessa origem. Proteger a unicidade da responsabilidade tardia por `(transactionId, motivo PENDING_REFERENCE_FAILED)`, com transferId gerado uma única vez. Repetição da recuperação ou múltiplos envelopes já confirmados não criam uma transferência tardia por replay; usam a origem canônica. Se já existir encaminhamento para a mesma origem/conteúdo, reutilizar sua responsabilidade e confirmação.

Um dispatcher operacional consulta transferências pendentes independentemente de ReceiveMessage. Pode executar como loop do role consumidor; não exige um novo serviço. Usa claims concorrentes com SKIP LOCKED, token e lease, envio fora da transação SQL e confirmação condicional, seguindo a disciplina e os limites iniciais de lease, timeout, backoff e suspensão de EVT-D03 na SPEC-006. Sua tabela e destino são de transferência operacional; esses registros não são novos eventos financeiros nem reabrem a transação FAILED.

Após envio confirmado, persistir dlqConfirmedAt. Sem receipt handle vigente, não tentar DeleteMessage: o trabalho é exclusivamente concluir o encaminhamento tardio. Se a entrega original retornar, o consumidor consulta a responsabilidade correspondente antes de decidir ACK. Crash depois do envio e antes da confirmação pode duplicar a mensagem na DLQ com o mesmo transferId; a recuperação precisa reconhecer essa identidade, sem confiar apenas na janela FIFO.

Se não houver origem SQS, registrar diagnóstico operacional durável por transactionId/failureCode, sem construir um envelope fictício. Um envelope novo recebido depois para essa transação FAILED tem sua própria inbox/disposição e segue o fluxo normal de DLQ. Expiração de referência e outras rejeições de negócio continuam REJECTED, com evento e sem transferência tardia.

Transferências suspensas permanecem inspecionáveis e retomáveis por comando local documentado, com trilha de operador/horário e o mesmo corpo/transferId. Retenção automática da origem recuperável e das tarefas fica fora desta versão. Reinício não pode apagar a obrigação nem depender de memória do consumidor.

## Heartbeat e desligamento

Renovar visibilidade para trabalho em andamento e validar posse do receipt handle atual. Perda de visibilidade pode causar execução concorrente; o banco e a inbox continuam protegendo efeitos. Não liberar a mensagem enquanto uma operação SQL local ainda puder confirmar.

No SIGTERM: parar novas leituras, aguardar as operações admitidas dentro do orçamento, cancelar/encerrar unidades não concluídas e só então devolver visibilidade das mensagens sem commit. As que tiverem disposição durável permitindo ACK podem ser removidas; FAILED/DLQ_REQUIRED seguem a transferência confirmada, mesmo com inbox já processada. Se a conclusão não couber no prazo, deixar responsabilidade recuperável e permitir redelivery. Não manter execução desconectada da mensagem em um processo que declarou shutdown concluído.

## Cenários de aceite

| ID | Condição | Resultado esperado |
|---|---|---|
| SQS-001 | Consumir envelope válido | Mesmo resultado financeiro da entrada HTTP |
| SQS-002 | Redelivery do mesmo envelope processado com ACK permitido | Uma inbox e um efeito financeiro; deduplicação não elimina obrigações de encaminhamento |
| SQS-003 | Envelope novo para operação já feita por HTTP | Nova inbox, replay financeiro e nenhum novo ledger |
| SQS-004 | Mesmo envelope ID com outro conteúdo | INBOX_PAYLOAD_CONFLICT, original intacta, destino permanente auditável |
| SQS-005 | Matar worker após commit e antes de DeleteMessage | Outro processo recebe e não duplica saldo/ledger/eventos |
| SQS-006 | Falha antes/durante commit | Nenhum processedAt ou efeito parcial; mensagem pode retornar |
| SQS-007 | Rejeição de negócio e referência pendente | ACK apenas após registro auditável/persistência da continuação |
| SQS-008 | Erros transitórios repetidos | Backoff, limite de recebimentos e DLQ, sem débito duplicado |
| SQS-009 | Corpo inválido ou conflito permanente | Diagnóstico e DLQ; nenhuma transação financeira fictícia |
| SQS-010 | DLQ indisponível ou envio com resultado incerto | Origem não é apagada prematuramente |
| SQS-011 | Processamento excede visibilidade e há redelivery | Heartbeat e deduplicação protegem a operação |
| SQS-012 | SIGTERM durante operação em andamento | Conclusão segura ou rollback antes da devolução de visibilidade |
| SQS-013 | Várias mensagens do mesmo grupo no lote | Execução sequencial local; banco protege chamadas HTTP concorrentes |
| SQS-014 | Grupos diferentes e três processos | Paralelismo entre wallets, sem mutex global |
| SQS-015 | Reiniciar todos os consumidores | Retomada via filas e registros duráveis, sem estado essencial em memória |
| SQS-016 | Redrive da mesma mensagem depois da janela FIFO | Inbox/idempotência persistentes continuam evitando efeitos duplicados |
| SQS-017 | FAILED e inbox confirmados, envio à DLQ falha e mensagem retorna | Retomar DLQ antes do ACK; não reaplicar finanças nem usar o atalho genérico de inbox |
| SQS-018 | Envio à DLQ confirmado, crash antes de persistir dlqConfirmedAt | Reenvio reconhecível pelo mesmo transferId; ACK só após confirmação durável |
| SQS-019 | Envelope novo faz replay de FAILED criado por HTTP | Criar inbox/disposição DLQ_REQUIRED e concluir transferência, sem efeito financeiro |
| SQS-020 | Redelivery após dlqConfirmedAt persistido, antes de DeleteMessage | Concluir ACK sem exigir nova aplicação financeira ou novo encaminhamento já confirmado |
| SQS-021 | Enviar messageId com 1 e 128 caracteres do alfabeto permitido | Produtor e consumidor aceitam; MessageDeduplicationId preserva exatamente o ID |
| SQS-022 | messageId vazio, com 129 caracteres, espaços ou Unicode não permitido | Produtor recusa antes do envio; envelope recebido por produtor incompatível segue diagnóstico/DLQ sem inbox financeira válida |
| SQS-023 | ACK de pendência, FAILED posterior e crash antes do encaminhamento | Reinício do dispatcher encontra a tarefa SQL e envia o corpo original à DLQ, sem redelivery ou receipt handle |
| SQS-024 | Vários envelopes confirmados para a mesma pendência e recuperação concorrente de FAILED | Uma origem canônica e uma responsabilidade tardia; nenhum efeito financeiro ou tarefa tardia duplicados |
| SQS-025 | Envio tardio aceito pelo SQS; crash antes de dlqConfirmedAt | Retry preserva transferId/corpo; eventual duplicata reconhecível, sem reaplicação financeira |
| SQS-026 | Falha ao salvar origem recuperável antes do ACK ou tarefa tardia no commit de FAILED | Rollback conjunto; não confirmar ACK/terminal deixando responsabilidade sem dados para retomada |
| SQS-027 | Pendência HTTP recebe primeiro envelope SQS antes de falhar | Origem canônica é persistida antes do ACK; posterior FAILED tem encaminhamento tardio recuperável |
| SQS-028 | Dois dispatchers, perda de lease e suspensão/retomada de uma transferência | Confirmação exige claim vigente; corpo/transferId preservados e obrigação não é descartada |
| SQS-029 | Inbox confirmada como PENDING_REFERENCE retorna depois de a transação virar FAILED | Consumidor consulta o estado atual e conclui/reutiliza a obrigação de DLQ antes do ACK; snapshot antigo da inbox não ignora a falha |

## Testes e revisão

Usar PostgreSQL e LocalStack reais para filas, visibility timeout, redrive e DeleteMessage. Injetar falhas após commit com barreira controlada, sem matar processo aleatoriamente e inferir o momento. Cada cenário financeiro termina em reconciliação de ledger e inspeção da inbox/outbox.

SQS-D04 e SQS-D05 registram os ajustes de contrato/recuperação aceitos em 27/10/2026. Os defaults operacionais SQS-D01 a SQS-D03 foram adotados na etapa autorizada de consumo, com tempos ajustáveis nos testes e na configuração. Ajustar tempos em testes por configuração/relógio sem mudar a semântica. Um painel de inspeção de DLQ e redrive automático são opcionais; diagnóstico, comando mínimo de recuperação e dispatcher de transferências pendentes são obrigatórios.

O consumo, o dispatcher tardio e a recuperação classificada estão implementados.
SQS-017 possui prova de redelivery real durante perda de heartbeat; SQS-025 cobre
SIGKILL antes/depois do envio tardio e retomada por outro processo. São provas
específicas; não se afirma cobertura de todas as combinações de falha possíveis.

## Evidências e estado atual

A implementação atual e seus testes estão no [mapa de evidências](../evidence.md).
Os registros das etapas anteriores foram preservados no [histórico](../history/spec-005-stages.md).
Essa separação mantém o contrato atual distinto das limitações que já foram resolvidas.
