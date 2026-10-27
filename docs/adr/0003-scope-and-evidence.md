# 0003 — Escopo incremental, autenticação e critérios de entrega

Estado: aceita em 26/10/2026; ponto de extensão de identidade e observabilidade local implementados; IdP adiado.

As evidências datadas preservam o estado de cada etapa. O estado atual consolidado está na [revisão de entrega](../delivery.md).

## Contexto

Correção financeira, concorrência, idempotência e recuperação de falhas são as prioridades do núcleo financeiro. A integração de autenticação externa será tratada em uma etapa própria, antes da exposição pública em produção. O desenvolvimento será incremental, com aprovação do responsável e registro das decisões que afetam a operação e a manutenção do sistema.

## Decisão

Priorizar garantias obrigatórias e sua comprovação. Adiar integração com IdP externo, mantendo `ProviderIdentityPort` como ponto de extensão explícito quando a apresentação HTTP for implementada. Não criar usuários/senhas locais. Validar provider no domínio mesmo para mensagens internas. Health permanece aberto.

Definição de escopo monetário confirmada em 26/10/2026: usar BRL nas entradas, saldos, transações, ledger e apresentação de valores da primeira versão. Money permanece multimoeda, com testes de conflito BRL/USD. Conversão cambial, entrada em moeda estrangeira com débito convertido, visualização em moeda alternativa e integração com API de cotações ficam para uma evolução futura, sem compromisso de implementação nesta entrega.

Documentação em português; código, contratos, eventos e failure codes em inglês. `AGENTS.md` concentra regras práticas e referências; `ARCHITECTURE.md` explica o sistema; requisitos mapeiam evidências; roteiro de demo descreve cenários reproduzíveis. Não marcar recurso como concluído com base só no desenho.

Cada etapa terá escopo apresentado e aprovado antes de alterações. Publicação/commit deve estar autorizada no escopo correspondente. A aprovação da documentação não autoriza implementar banco, domínio ou workers.

Orientação de planejamento atualizada em 26/10/2026: o responsável autorizou redigir as specs restantes sem solicitar aprovação por arquivo ou escolha de rotina. Defaults recomendados e decisões materiais ficam documentados para revisão ao aplicar; itens muito opcionais são destacados. SPEC-001/002 permanecem aprovadas, e os novos rascunhos não são promovidos automaticamente a contratos aprovados. Código, dependências e publicação seguem sujeitos à autorização da etapa correspondente.

Revisão documental autorizada em 27/10/2026: aplicar as correções de recuperação da criação, persistência de múltiplas movimentações, encaminhamento de FAILED após ACK e formato de messageId, além da recomendação REV-D01 de uma reversão efetivada por referência. Esses ajustes estão registrados nos ADRs 0001/0002 e nas specs relacionadas. O aceite é limitado a essas decisões; os demais defaults das specs 003–008 continuam em revisão e nenhuma implementação ou evidência de execução é declarada.

Testes usam Bun. Integração e concorrência usam serviços reais em containers e processos independentes. Mocks podem isolar testes unitários, mas não substituir PostgreSQL/SQS nos cenários que avaliam suas garantias.

## Alternativas consideradas

- Integrar Keycloak/Zitadel desde o começo: adiciona operação e configuração antes de validar as garantias de consistência que sustentam o núcleo financeiro.
- Adicionar dashboards, tracing e teste de carga primeiro: são extensões úteis após o mínimo obrigatório, mas não substituem testes de correção.
- Documentar apenas ao final: favorece desvio entre requisitos, decisões e implementação e dificulta discussão das etapas.
- Exibir e aceitar valores estrangeiros convertidos para uma carteira BRL: demanda políticas de cotação, validade, arredondamento, confirmação e auditoria. Fica adiado para manter o foco nas garantias do processamento financeiro.
- Manter saldos reais em várias moedas: exigiria habilitação de moedas na aplicação e, para conversão entre saldos, um fluxo financeiro adicional. A primeira versão não precisa dessa capacidade operacional.

## Consequências e limitações

Sem IdP não é possível garantir a identidade do chamador HTTP. A solução não deve ser exposta como serviço de produção. ProviderIdentityPort e guard estão ligados ao bootstrap com implementação local sem autenticação. Integração OIDC, autorização e vínculo de claims ao provider exigirão uma etapa própria.

Documentos devem ser atualizados junto ao comportamento, sem alegações de performance, cobertura ou segurança sem evidência. O roteiro só vira demonstração executável depois de existirem scripts e dados correspondentes.

A aplicação não depende de provedores de câmbio para processar ou apresentar valores. O usuário opera em BRL; representação de USD no domínio serve aos testes de conflito e não oferece saldo, entrada ou exibição em USD. Qualquer evolução cambial exige spec própria e revisão explícita das fronteiras e contratos.

## Como validar

Conferir rastreabilidade de cada requisito, comandos documentados realmente existentes e limitações explícitas. Ensaiar a demonstração a partir de ambiente limpo, registrando versões, comandos, resultados e evidências. Revisar que a autenticação adiada não desliga as validações de domínio.

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


## Health e observabilidade local verificados — 27/10/2026

Etapa autorizada adotou OBS-D01–D03 com porta de aplicação, logs por catálogo e
registro Prometheus por processo, sem dependência nova. Biblioteca adicional e
AsyncLocalStorage foram dispensados: contexto é explícito, isolado por operação;
IDs não viram labels. Transição financeira só após commit; replay é separado;
medições de tentativas técnicas não representam lançamentos contábeis. Falha de sink
não muda resultados/ACK nem desfaz uma confirmação de publicação.

Health público verifica SQL/schema e filas por papel, em paralelo com deadline 2 s.
Live é independente. Backlog inclui suspensos, é coletado a cada 15 s e mantém última
medição/horário na falha; gauge de sucesso sinaliza erro. Métricas são locais em
loopback e cada processo tem endpoint próprio. Não instalar TSDB/dashboard/tracing
foi uma escolha para manter a etapa no recorte local, sem assumir deploy de produção.
Compose continua com dependências; aplicação e workers permanecem processos Bun.
Containerização da aplicação não foi implementada nem ensaiada.

SIGTERM recusa novas admissões e drena com limite de 30 s. No HTTP, capturar o socket
antes de finish e fechar a conexão depois de responder evita manter o processo preso
em keep-alive. Não destruir requisição financeira admitida para agilizar encerramento.
A prova usa um PID separado e espera de lock observada no PostgreSQL.

590 testes/zero falhas/2.224 asserções (413 unitários + 177 integrações); instalação
congelada/typecheck/build passaram. Inclui SQL/SQS indisponíveis só nas fixtures,
correlação concorrente/publicação, replay/DLQ, sink que falha, backlog suspenso e
falha real de coleta. API e três workers locais respondem live/ready/metrics 200.
IdP externo, Grafana/tracing/carga e AWS continuam fora do escopo executado. Sem commit/push.
