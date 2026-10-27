# Histórico da SPEC-007

Este arquivo preserva evidências por etapa; alegações de pendência valem para a data do recorte.
Consulte o [contrato atual](../specs/007-queries-and-reconciliation.md) e o [mapa de evidências](../evidence.md).

## Evidências executadas — revisão 0.3, 27/10/2026

[FinancialQueries](../../src/modules/financial/application/queries/financial-queries.ts)
depende de [portas de leitura/cursor/diagnóstico](../../src/modules/financial/application/ports/financial-read-store.ts).
O [store MikroORM](../../src/modules/financial/infrastructure/queries/mikro-financial-read-store.ts)
usa contexto novo e transação READ ONLY/REPEATABLE READ; o
[cursor HMAC](../../src/modules/financial/infrastructure/queries/hmac-ledger-cursor.ts)
protege payload v1 com walletId/upperVersion/lastVersion e comparação de assinatura
em tempo constante. Não há estado de paginação em memória nem TTL.

HTTP: [controller](../../src/modules/financial/presentation/http/financial.controller.ts),
[filtro de erros](../../src/modules/financial/presentation/http/financial-exception-filter.ts),
[guard de identidade](../../src/modules/financial/presentation/http/provider-identity.guard.ts)
e [composição](../../src/bootstrap/http-application.ts). A implementação local da
porta de identidade permite acesso sem autenticar; bind padrão é loopback.
Limite JSON de 32 KiB e rejeição de query fields desconhecidos são defaults desta
etapa. Erros de query usam INVALID_QUERY_INPUT/INVALID_CURSOR e TRANSACTION_NOT_FOUND;
integridade/inesperados usam 500 INTERNAL_ERROR sem SQL ou stack.

Testes: [HTTP/TCP real](../../tests/integration/financial-http.test.ts),
[snapshots e diagnóstico](../../tests/integration/financial-queries.test.ts) e
[cursor](../../tests/unit/ledger-cursor.test.ts). Bun 1.4.4, MikroORM 7.2.5 e
PostgreSQL 17.11; base 44710c3 com alterações locais. Suíte total: 459 aprovados,
zero falhas, 1.653 asserções (354 unitários + 105 de integração). Instalação congelada,
typecheck e build passaram.

| Cenários | Evidência |
|---|---|
| QRY-001–QRY-004 | Wallet atual, resultado histórico, lookup interno/externo, OPENING sem provider fictício e 200 para estados existentes |
| QRY-005/QRY-006 | Timestamps repetidos ordenados por versão; commit entre páginas não altera o recorte original |
| QRY-007/QRY-008 | Cursor adulterado/cruzado/versão inválida; limites malformados; wallet zero e soma 0.00 |
| QRY-009/QRY-010 | Reconciliação exata; barreira permite commit de outra conexão entre leitura da wallet e soma, preservando a fotografia original |
| QRY-011 | Fixture administrativa isolada gera divergência finita; relatório/log/counter, sem alteração de saldo/versão/data |
| QRY-012/QRY-013 | Movimentos MAX com cancelamentos; total/diferença diagnósticos maiores que MAX preservam strings exatas; NaN em fixture retorna erro de integridade |
| QRY-014 | HTTP 400/404/503/500 distintos; timeout real de leitura e respostas sem dados internos |
| QRY-015 | Outro Nest app/ORM continua o cursor usando a mesma chave; codec recriado não depende de memória local |
| QRY-016 | Repetição da abertura retorna walletId e GET recupera saldo/versão atuais após movimento |

FAILED foi preparado administrativamente apenas para provar consulta, sem alegar
recuperação de falha implementada. Fixtures de corrupção alteram proteções somente
em bancos descartáveis dos testes; a role de aplicação não ganhou permissões.
[Diagnósticos](../../src/modules/financial/infrastructure/observability/query-diagnostics.ts) têm logs JSON
sanitizados e counters locais sem labels por ID; ainda não há endpoint de métricas
nem telemetria completa. Não foi demonstrado restart de processo do servidor;
a prova de continuidade usa instâncias Nest/ORM distintas e chave compartilhada.
Health real, IdP, SQS, publisher e scheduler permanecem fora deste recorte.
