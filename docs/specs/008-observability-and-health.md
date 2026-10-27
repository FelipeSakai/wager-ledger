# SPEC-008 — Observabilidade, health e operação local

| Campo | Conteúdo |
|---|---|
| ID | SPEC-008 |
| Estado | Rascunho |
| Revisão | 0.1 |
| Requisitos relacionados | F01–F03, A13, O01–O08; suporte a M06, M07, M12 |
| Dependências | Specs financeiras, SQS, outbox e consultas; ADR 0003 |
| Aprovação do conteúdo | Revisão prevista antes da implementação; defaults recomendados |
| Implementação | Não iniciada |

## Objetivo e escopo

Permitir diagnosticar cada operação, reconhecer indisponibilidade e executar o sistema/testes localmente de forma reproduzível. Logs e métricas auxiliam operação; ledger, transações e inbox/outbox permanecem a fonte durável dos fatos financeiros.

Não inclui por padrão tracing distribuído, Grafana, infraestrutura AWS de produção, escalonamento automático, teste de carga, frontend ou serviço de autenticação. Os itens opcionais estão separados no final.

## Logs estruturados — OBS-D01

Produzir JSON com timestamp UTC, level, service/role, instanceId, mensagem/evento operacional e IDs aplicáveis: correlationId, messageId, transactionId, walletId e providerId. Publisher também informa eventId. Abertura interna não inventa providerId; campo pode estar ausente quando não existe no contexto.

Preservar correlação desde HTTP/envelope até transação, pendência e outbox. Campos não podem vazar entre requisições por contexto global compartilhado. Aceitar correlationId válido ou gerar UUID conforme SPEC-003; não usar texto arbitrário recebido como linha de log.

Não registrar tokens, senhas, connection strings, idempotency key completa, receipt handle, corpo completo de mensagem ou payload financeiro completo. Registrar código de falha, tipo de operação, estado e duração quando úteis. Dados operacionais sensíveis ficam no armazenamento restrito apropriado, não no log.

Mensagens técnicas e códigos usam inglês; documentação permanece em português. Redação de erro para cliente não inclui stack, SQL ou detalhes do provedor de infraestrutura. Falha de logging não autoriza perder um commit, reabrir transação ou duplicar lançamento.

## Métricas recomendadas — OBS-D02

Endpoint local recomendado `/metrics` em formato compatível com Prometheus. Sua exposição será interna ao ambiente de operação; não pressupor autorização pública em produção. Health permanece publicamente acessível conforme contrato.

| Métrica sugerida | Tipo / semântica |
|---|---|
| wager_transactions_total | Counter de conclusões/transições financeiras por status/kind; replay não é nova aplicação |
| wager_duplicates_total | Counter por camada business/inbox/event-consumer |
| wager_retries_total | Counter por componente e causa transitória controlada |
| wager_lock_conflicts_total | Counter de deadlock/timeout/conflito de lock identificado |
| wager_lock_wait_seconds | Histogram de espera pelo lock da wallet |
| wager_processing_seconds | Histogram de latência por transporte/resultado |
| outbox_publish_attempts_total | Counter de envios por resultado |
| outbox_suspended_total | Counter de suspensões recuperáveis |
| outbox_lag_seconds | Gauge de idade do evento não publicado mais antigo, incluindo suspensos |
| sqs_dlq_messages | Gauge aproximado de mensagens da DLQ e counter separado para transferências observadas |
| wallet_reconciliation_mismatches_total | Counter de divergências/integridade detectadas |
| dependency_probe_failures_total | Counter por dependência/causa controlada |

Labels têm cardinalidade limitada: estado, kind, transporte, role, fila conhecida e família de erro. Nunca usar walletId, playerId, transactionId, messageId ou texto livre como label. Valores monetários não viram `number` para métricas; esta versão não precisa de métricas de quantias financeiras.

Medir duração com relógio apropriado para intervalo. Incrementar contadores de aplicação depois do commit; uma falha entre commit e emissão pode perder telemetria, mas não fatos financeiros. Métricas não são contabilidade e counters podem reiniciar com o processo.

Probes de filas/outbox podem ser periódicos, com default de 15 segundos e timeout de dois segundos. Se a fonte estiver indisponível, sinalizar erro/desatualização, sem publicar zero como se a fila estivesse vazia ou sem lag.

## Health e lifecycle — OBS-D03

| Endpoint | Sucesso | Falha |
|---|---|---|
| GET /health/live | 200 quando o processo atende; sem consulta a SQL/SQS | Falha do processo/servidor; não usar indisponibilidade externa para disparar liveness falsa |
| GET /health/ready | 200 com PostgreSQL e SQS/filas necessárias alcançáveis, inicialização concluída | 503 na inicialização, shutdown ou indisponibilidade de dependência |

Ambos dispensam autenticação. Readiness consulta banco de forma leve e SQS com operação de leitura que confirme acesso às filas, sem enviar aposta ou evento artificial. Timeout recomendado de dois segundos por probe, dependências verificadas em paralelo quando independentes.

Resposta inclui status e nomes/estados das dependências, sem URLs internas, credenciais ou stack. O atual `GET /` de bootstrap não satisfaz esses endpoints. Filas exigidas variam com o role; o role HTTP verifica também SQS conforme o contrato de readiness do serviço.

No SIGTERM, readiness muda para 503, novas admissões cessam e a aplicação drena trabalho dentro do orçamento comum de 30 segundos. Consumidor e publisher seguem as regras de visibilidade/lease das specs respectivas. O prazo de encerramento do container precisa exceder essa janela. Falha de métrica/probe não permite ACK sem commit.

## Execução local e migrations

Docker Compose deverá disponibilizar PostgreSQL, LocalStack, bootstrap idempotente das filas, aplicação e papéis de worker. Versões de imagens e dependências serão fixadas na implementação. Não usar tags flutuantes como estratégia de reprodutibilidade.

Migrations versionadas e reversíveis são executadas por tarefa dedicada antes da admissão de tráfego, com papel separado do usuário SQL da aplicação. Réplicas não disputam sincronização automática de schema. O bootstrap de filas pode ser repetido sem apagar mensagens existentes.

Configuração fica em ambiente e `.env.example`, sem segredos reais no Git. Cada role valida as variáveis necessárias e falha claramente quando sua configuração é inválida. Catálogo de providers para ambiente local é explícito; não criar saldo inicial ou wallets automaticamente a cada reinício.

O harness deverá executar ao menos três instâncias/processos e dois publishers quando o cenário exigir, usando rede interna ou portas distintas para evitar colisão. Fixtures e falhas controladas pertencem a testes. Não preparar o ambiente removendo volumes/dados do usuário sem autorização específica.

## Evidências e comandos futuros

Os scripts atuais do bootstrap continuam os únicos comandos existentes até a implementação. A etapa correspondente deverá acrescentar comandos documentados para migrations, testes unitários, integração e concorrência, com Bun como runner. Compose e scripts ainda não foram criados por esta spec.

Registrar commit, versões, ambiente, comandos, resultado e limitações. Testes não podem substituir completamente SQL/SQS por mocks. Cenários de concorrência usam processos e barreiras; crash tests documentam o ponto exato de interrupção. Atualizar [requirements](../requirements.md) e [demo](../demo.md) com evidências reais.

## Cenários de aceite

| ID | Condição | Resultado esperado |
|---|---|---|
| OBS-001 | Operação HTTP/SQS e sua publicação de evento | Logs JSON correlacionados entre componentes, sem vazamento entre requisições |
| OBS-002 | Abertura interna e erro em contexto incompleto | Campos presentes quando aplicáveis, sem provider fictício |
| OBS-003 | Payload contém segredo/texto manipulável ou falha com SQL interno | Logs/resposta não vazam conteúdo nem permitem injeção de linhas |
| OBS-004 | Processamento, replay, rejeição, retry e DLQ | Métricas refletem causas e replay não conta novo débito |
| OBS-005 | Evento pendente suspenso envelhece | Lag continua refletindo a pendência e diagnóstico é visível |
| OBS-006 | Muitas wallets/IDs distintos | Labels permanecem limitadas, sem série por cliente/operação |
| OBS-007 | PostgreSQL ou SQS indisponível | Live continua leve; ready retorna 503 com resposta segura |
| OBS-008 | Startup e SIGTERM com operações em andamento | Readiness correta e drenagem coerente com ACK/lease |
| OBS-009 | Chamadas de health sem credenciais | Health acessível e sem efeitos financeiros |
| OBS-010 | Subir ambiente limpo e repetir bootstrap de filas | Setup reproduzível, sem apagar mensagens nem recriar saldo |
| OBS-011 | Aplicar/reverter/reaplicar migrations em banco descartável | Schema previsível e papel da aplicação sem privilégios de manutenção |
| OBS-012 | Harness com três processos e publishers concorrentes | Evidências identificam processos, barreiras e consistência final |
| OBS-013 | Probes/telemetria perdem acesso a dependência | Erro/desatualização reconhecidos, sem métricas falsas de sucesso |

## Opcionais e revisão

Opcionais fora do mínimo: OpenTelemetry/tracing, dashboard Grafana, teste de carga com p50/p95/p99, exportações e infraestrutura de produção. Se teste de carga for aprovado, criar `bun run test:load` com ambiente, metodologia, taxa de erro, conflitos e outbox lag medidos; esse comando ainda não existe.

IdP externo está adiado conforme ADR 0003; manter o ponto de extensão, sem atribuir segurança de produção ao serviço atual. Câmbio, saldo USD e frontend também estão fora da primeira versão e não são requisitos para verificar as garantias financeiras.

OBS-D01 a OBS-D03 são defaults recomendados, com escolha de bibliotecas de logs/métricas a fechar no setup autorizado. Nenhum dashboard ou pacote adicional é instalado nesta fase. Rascunho 0.1 de 26/10/2026; implementação e evidências ainda inexistentes.
