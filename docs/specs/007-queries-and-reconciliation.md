# SPEC-007 — Consultas, paginação e reconciliação

| Campo | Conteúdo |
|---|---|
| ID | SPEC-007 |
| Estado | HTTP/SQL, telemetria local e documentação OpenAPI implementados e verificados; IdP adiado |
| Revisão | 0.4 |
| Requisitos relacionados | A03, A08, A09, A10, A12, D03, D04, D07, O01, O02, O04, O09 |
| Dependências | SPEC-001 e SPEC-002 aprovadas; resultados da SPEC-003 |
| Aprovação do conteúdo | Etapa de API HTTP/consultas autorizada em 27/10/2026; QRY-D01/D02 adotados, mantendo autenticação adiada |
| Implementação | FinancialQueries, store de leitura, cursor HMAC, controllers e reconciliação executados em PostgreSQL real |

## Objetivo e escopo

Consultar saldo, histórico e transações sem alterar o estado financeiro. Reconstruir o saldo pelo ledger numa fotografia consistente e sinalizar divergências, sem repará-las silenciosamente.

Não inclui dashboard, exportação CSV/PDF, relatórios agregados, réplicas de leitura, projeções assíncronas ou ajuste automático de saldo. A primeira versão consulta o PostgreSQL principal; todas as respostas monetárias operacionais permanecem em BRL.

## Endpoints e respostas

| Endpoint | Contrato |
|---|---|
| GET /wallets/:walletId | id, playerId, balance, version, createdAt e updatedAt |
| GET /wallets/:walletId/ledger?cursor=...&limit=50 | items e nextCursor opcional, com lançamentos imutáveis e walletVersion |
| GET /wagering/transactions/:transactionId | Estado atual, identidade, origem, dados de negócio, referência resolvida, failureCode e datas aplicáveis |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | Mesma transação externa localizada pela identidade de provider |
| POST /wallets/:walletId/reconciliation | Relatório consistente de saldo armazenado e reconstruído |

Consulta de recurso existente usa 200, inclusive transações REJECTED/FAILED. Recurso ausente usa 404. IDs/limites/cursor malformados usam 400; falha transitória usa 503; integridade persistida inválida usa 500 seguro. Envelope geral da SPEC-003. Não mudar o status de uma transação porque ela foi consultada.

A resposta de consulta de wallet contém o saldo atual. Uma transação apresenta separadamente o saldo observado do seu resultado, que não deve ser substituído pelo saldo atual. Expor campos pertinentes, sem payloadHash, idempotency key completa, credenciais, claims de outbox ou metadados técnicos desnecessários.

Se a resposta de POST /wallets se perder após commit, o cliente repete a criação com o mesmo playerId/currency. O 409 WALLET_ALREADY_EXISTS traz `error.details.walletId`, conforme SPEC-002, permitindo a consulta pelo endpoint existente. GET retorna o saldo/versão atuais, inclusive se houve movimentos desde a abertura; não reconstrói uma resposta histórica de criação nem exige um endpoint de busca adicional.

OPENING é acessível por seu transactionId interno; não fabricar provider/externalTransactionId para fazê-la caber na consulta por provedor. Consultas de transações não atribuem idempotentReplay por si só; esse indicador pertence à submissão/replay.

Os endpoints de negócio usam ProviderIdentityPort e guard HTTP implementados, com
composição local sem autenticação. O IdP externo permanece adiado conforme o
[ADR 0003](../adr/0003-scope-and-evidence.md); essa configuração não comprova
autorização para exposição pública.

## Documentação OpenAPI — melhoria autorizada

GET /docs apresenta Swagger UI e GET /docs-json exporta OpenAPI 3.0.3. Cobrir as
sete operações financeiras, identificação, health e métricas. Parâmetros de rota,
limit/cursor, Idempotency-Key e correlação devem refletir os contratos existentes.
Schemas de dinheiro usam strings; separar a resposta de abertura da consulta de
wallet e os resultados de submissão PROCESSED/PENDING_REFERENCE/REJECTED/FAILED.

Try it out utiliza a mesma origem e exige os mesmos campos/headers da API real.
Exemplos de BET/WIN/LOSS/REFUND/ROLLBACK não podem enviar campos internos nem
fabricar uma wallet existente. O operador copia walletId/playerId, muda identidades
para operações novas e preserva corpo/key para replay. GET da documentação não
cria recursos financeiros. Assets são locais; não usar validador externo ou esquema
de autenticação sem implementação. A validação de negócio permanece nos casos de uso.

## Paginação estável do ledger — QRY-D01

Ordem adotada: decrescente por walletVersion, do lançamento mais recente ao mais antigo. A unicidade por wallet/versão da SPEC-002 fornece ordem total. Não usar apenas createdAt, offset numérico ou ID aleatório para simular ordem financeira.

Primeira página captura a versão máxima visível da wallet e retorna até limit lançamentos com walletVersion menor ou igual a esse limite. Páginas seguintes usam a mesma versão superior e versões estritamente menores que a última retornada. Novas movimentações depois da primeira página não entram no percurso; uma nova consulta sem cursor as encontra.

Default de limit é 50 e máximo 100; rejeitar zero, negativos, frações, valores acima do máximo e cursores maiores que 2 KiB. Uma wallet de abertura zero pode ter versão 1 e ledger vazio; responder items vazio sem nextCursor.

Cursor opaco: payload versionado com walletId, upperVersion e lastVersion, codificado em base64url e assinado com HMAC. A chave de assinatura vem de configuração secreta estável entre instâncias, fora do Git. Base64 sozinho não fornece integridade. Validar assinatura, versão e vínculo à wallet; não confiar em valores decodificados do cliente.

Não há TTL de cursor na primeira versão: o ledger é imutável e a versão superior define o recorte. Rotação de chaves pode invalidar cursores antigos com erro claro. Não devolver contagem total cara a cada página. Índices devem atender wallet/versão, aproveitando a unicidade existente quando possível.

## Reconciliação — QRY-D02

Abrir transação READ ONLY em REPEATABLE READ no PostgreSQL principal. Ler wallet e somar ledger dentro da mesma fotografia, mesmo que outra conexão confirme novas movimentações durante a operação. Não bloquear a wallet só para produzir o relatório nem comparar consultas READ COMMITTED independentes.

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "75.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "75.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

Fórmulas: calculatedBalance é a soma de CREDIT menos DEBIT, começando em zero; difference = storedBalance − calculatedBalance. Ledger vazio soma zero. O crédito OPENING já integra a soma; não acrescentar initialBalance de novo.

A acumulação usa aritmética exata do PostgreSQL com resultado NUMERIC sem typmod de coluna. Não acumular um histórico ilimitado em Money de faixa limitada nem em precisão decimal fixa sem demonstrar capacidade. Cancelamentos intermediários não podem gerar overflow artificial de um relatório cujo resultado final é representável.

Os campos calculados são valores de diagnóstico serializados como strings decimais de duas casas, com moeda; não precisam ser instâncias de Money. Um total finito ou diferença que exponha corrupção pode exceder a faixa operacional de Money. Preservar o valor exato no diagnóstico e marcar consistent false com issue de intervalo; não truncar nem ampliar a faixa aprovada do objeto de domínio. Essas saídas diagnósticas não são entradas financeiras válidas.

Dados não finitos, direction/moeda inválidas ou referência estrutural impossível produzem erro de integridade seguro, log e métrica; não devolver NaN/Infinity como amount válido. Para divergência finita, responder 200 com consistent false, valores observados e issues opcionais. Não corrigir saldo, inserir ajustes, alterar versão/updatedAt ou produzir WalletBalanceChanged.

Registrar um log sanitizado de divergência com IDs e causa, sem payload financeiro completo, e incrementar a métrica. O relatório não substitui as proteções de schema: serve à auditoria e diagnóstico de falhas/migrações ou intervenções administrativas indevidas.

Referência técnica: [isolamento de transações do PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html).

## Concorrência e recuperação

Cada requisição usa contexto de leitura próprio. A paginação conserva seu recorte por versão; reconciliação conserva a fotografia SQL. Não compartilhar Identity Map entre requisições nem montar o relatório com saldo de cache e ledger do banco.

Interrupção da consulta não cria estado financeiro parcial, pois o fluxo é somente leitura. Retry de reconciliação pode observar uma fotografia nova, que deve ser internamente consistente. Distinguir mudança legítima entre relatórios de divergência dentro do mesmo relatório.

## Cenários de aceite

| ID | Condição | Resultado esperado |
|---|---|---|
| QRY-001 | Consultar wallet após movimentos | Saldo/versão atuais e MoneyProps canônico |
| QRY-002 | Consultar uma transação depois de outras alterarem saldo | Resultado histórico da transação preservado, sem substituir pelo saldo atual |
| QRY-003 | Consultar por ID interno e identidade externa | Mesma operação externa; OPENING sem identidade fictícia de provider |
| QRY-004 | Consultar transação rejeitada, falha ou pendente | 200 com estado atual e campos pertinentes |
| QRY-005 | Paginar ledger com timestamps repetidos | Ordem determinística por walletVersion, sem perda/duplicação |
| QRY-006 | Novos lançamentos entre páginas | Recorte original estável; novos só aparecem em nova paginação |
| QRY-007 | Cursor alterado, de outra wallet ou versão desconhecida | 400 sem aceitar limites manipulados |
| QRY-008 | Wallet zero, ledger vazio e limites de página | items vazio, soma zero; limites inválidos rejeitados |
| QRY-009 | Reconciliação após abertura e movimentações | Saldo igual ao ledger e checkedEntries correto |
| QRY-010 | Outra conexão movimenta entre a leitura da wallet e a soma | Relatório usa a mesma fotografia, sem falso positivo |
| QRY-011 | Fixture administrativa isolada contém divergência finita | consistent false, diagnóstico exato, log e métrica; nenhum ajuste |
| QRY-012 | Soma intermediária grande com cancelamentos | Cálculo exato, sem overflow artificial da faixa de Money |
| QRY-013 | Corrupção produz total finito fora da faixa operacional ou dado não finito | Diagnóstico de intervalo ou erro de integridade conforme contrato, sem arredondamento |
| QRY-014 | Recurso ausente, banco indisponível ou ID inválido | 404/503/400 distintos e resposta segura |
| QRY-015 | Reinício/instância diferente atende próximo cursor | Mesma política de assinatura e recorte; sem dependência de memória local |
| QRY-016 | Resposta da criação se perde; repetir POST retorna walletId no conflito; consultar esse ID após movimentos | Recuperar a mesma wallet com saldo/versão atuais, sem nova abertura, carga inicial ou resposta histórica inventada |
| QRY-017 | Abrir Swagger/OpenAPI e executar exemplos como cliente | Documento resolvível, assets locais, headers corretos, dinheiro em strings, chamadas reais e saldo reconciliado |

## Testes e revisão

Testes unitários de cursor/validação e integração em PostgreSQL real para fotografia, paginação e soma. Coordenar duas conexões por barreiras para inserir uma movimentação no instante relevante. Fixtures de corrupção usam ambiente descartável e papel administrativo de preparação, nunca uma permissão de escrita extra na aplicação.

QRY-D01 e QRY-D02 foram aplicados na etapa autorizada: HMAC-SHA256 com chave estável, recorte por versão, READ ONLY/REPEATABLE READ e diagnóstico NUMERIC exato. Exportações, dashboard, projeção assíncrona e réplica de leitura são opcionais; as consultas e reconciliação descritas são parte do núcleo.

O ajuste de recuperação da criação da revisão 0.2 foi implementado conforme a
SPEC-002 revisão 1.1. Os defaults QRY-D01/QRY-D02 estão aplicados; as discussões e
limitações das etapas anteriores estão no [histórico](../history/spec-007-stages.md).

A reavaliação de 27/10/2026 cobre também moeda inconsistente no saldo histórico de
PROCESSED, REJECTED e PENDING_REFERENCE. GET por ID/identidade externa e replay
recusam o snapshot com erro seguro, preservando registros, saldo e ledger.

## Evidências e estado atual

A implementação atual e seus testes estão no [mapa de evidências](../evidence.md).
Os registros das etapas anteriores foram preservados no [histórico](../history/spec-007-stages.md).
Essa separação mantém o contrato atual distinto das limitações que já foram resolvidas.
