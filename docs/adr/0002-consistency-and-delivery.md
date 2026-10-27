# 0002 — Consistência no PostgreSQL e entrega at-least-once

Estado: aceita em 26/10/2026; implementação pendente.

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

### Proteção do ledger e saldo aceita em 26/10/2026

Q-WAL-04 foi aprovada: PostgreSQL deve recusar commits com saldo sem ledger, ledger sem movimentação válida, inconsistência de moeda/valor/versão ou invalidação do histórico. Regras locais usam constraints; relações financeiras entre registros usam constraint triggers diferidas e verificações por wallet/versão/vizinhos indexados. A estratégia cobre abertura zero/positiva e múltiplas mudanças na mesma unidade SQL sem reler todo o histórico a cada movimento.

Aplicação usa papel sem privilégios para alterar schema, desativar proteções ou editar/excluir/truncar ledger. Funções, permissões, DDL e cobertura de todas as tabelas relevantes serão implementados em migrations e demonstrados por testes reais. A aprovação define a estratégia; não é evidência de correção do SQL ainda inexistente. Mudanças necessárias à estratégia devem passar por revisão explícita.

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
