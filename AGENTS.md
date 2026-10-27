# Instruções de trabalho — Wager Ledger

## Objetivo e leitura inicial

Desenvolver o Wager Ledger, um processador distribuído de transações de apostas, preservando correção financeira com múltiplas instâncias, duplicatas e falhas. Os requisitos do produto estão em `docs/requirements.md`.

Antes de alterar o projeto, leia:

1. `README.md`: estado real e comandos disponíveis.
2. `ARCHITECTURE.md`: limites, fluxos e invariantes.
3. `docs/adr/README.md` e os ADRs relacionados à tarefa.
4. `docs/requirements.md`: requisitos e evidências esperadas.
5. `docs/specs/README.md` e as specs relacionadas: contratos, critérios de aceite e pendências da funcionalidade.

As decisões dos documentos descrevem o destino aprovado. Não trate um recurso planejado como implementado. Havendo conflito entre documentos, requisitos do produto ou código, exponha a divergência antes de mudar a arquitetura.

## Aprovação e escopo

- O responsável quer aprovar cada etapa antes da execução. Apresente escopo, arquivos afetados, decisões e forma de validação; aguarde aprovação.
- Autorização vigente para planejamento: elaborar e revisar as specs restantes do escopo sem pedir aprovação por arquivo ou escolha de rotina. Documente defaults recomendados e destaque funcionalidades muito opcionais; dúvidas de aplicação serão tratadas na etapa de implementação. Essa autorização não inclui código, dependências, commit ou publicação.
- Uma aprovação cobre a etapa descrita, incluindo ajustes necessários à sua validação. Não peça novamente pela mesma ação já autorizada.
- Não avance para a próxima etapa, acrescente dependências, integre serviços ou implemente recursos fora do escopo aprovado.
- Confirme a autorização para commit, push e criação de PR quando essas ações não estiverem incluídas na etapa aprovada. Nunca faça force push, descarte alterações ou reescreva histórico sem autorização explícita.
- Mantenha mudanças pequenas e revisáveis. Não use subagentes sem solicitação explícita.
- Antes de implementar uma funcionalidade, confira o estado da spec e alinhe os defaults que alterem regras de negócio ou contratos. A aprovação pode abranger um conjunto de specs junto à autorização da etapa, sem exigir uma rodada por detalhe técnico. Rascunho não é contrato aprovado; aprovação documental não autoriza automaticamente código, commit ou publicação.
- Comunique-se e documente decisões em português. Código, nomes de arquivos de código, identificadores, eventos, mensagens de commit e códigos de falha usam inglês.

## Arquitetura obrigatória

- Monólito modular com núcleo financeiro coeso; API e workers compartilham domínio e casos de uso, podendo executar em processos separados.
- Organização alvo: `src/modules/financial/{domain,application,infrastructure,presentation}`, `src/platform/` e `src/bootstrap/`.
- `domain` não importa NestJS, MikroORM, SDK AWS, HTTP, configuração de ambiente ou implementações de infraestrutura.
- `application` depende do domínio e de portas; não importa adaptadores concretos. A fronteira transacional é uma porta da aplicação.
- `infrastructure` implementa portas e faz o mapeamento explícito entre modelos de persistência e domínio.
- `presentation` traduz contratos HTTP/SQS, valida transporte e chama casos de uso. Não contém regras financeiras nem acesso direto ao banco.
- `bootstrap` compõe dependências. `platform` contém recursos técnicos compartilhados, sem regras de negócio.
- Wallet, transação, ledger, inbox e outbox usam o mesmo contexto transacional. Não separe esses componentes em serviços com commits independentes.
- Não crie diretórios vazios, abstrações genéricas, barramentos ou repositórios base sem necessidade demonstrada. Evolua a estrutura ao implementar cada comportamento aprovado.

## Garantias financeiras invioláveis

- Dinheiro usa `Money` imutável, decimal exato e moeda explícita. Nunca converta valores monetários para `number`, `float` ou `double`, inclusive em mappers, logs, testes e métricas.
- Money usa Decimal.js 10.6.0, fixada em package.json/bun.lock, com construtor exclusivo, defaults isolados e precisão de trabalho 40. A faixa acompanha NUMERIC(20, 2); overflow gera erro, sem arredondamento. Não alterar a dependência fora de etapa autorizada.
- Contratos monetários exigem strings com exatamente duas casas. Rejeite números, `"25"` e `"25.0"`, sem normalização silenciosa ou arredondamento.
- A SPEC-001 revisão 1.0 está implementada e verificada no domínio com 128 testes em 27/10/2026. Siga seu catálogo local BRL/USD, gramática canônica, separação from/rehydrate, erro de moeda inclusive em equals e códigos estáveis. Não reabra essas escolhas sem revisão explícita de contrato; round-trip monetário via ORM foi comprovado na etapa de persistência; HTTP foi integrado na etapa seguinte; SQS/inbox estão implementados no recorte da SPEC-005; publisher e agendador estão implementados; recuperação de FAILED é restrita a INVALID_REFERENCE_STATE após rollback confirmado.
- Money representa moedas distintas; use BRL e USD nos testes de conflito. A primeira versão da aplicação usa somente BRL nas entradas, saldos, transações, ledger e apresentação de valores. Não coloque essa restrição comercial dentro do objeto de valor.
- Cotações externas, entrada/visualização convertida e conversão entre carteiras ficam fora da primeira versão. Não adicione API, biblioteca ou módulo de câmbio sem uma nova etapa explicitamente aprovada.
- Classes de domínio têm estado encapsulado, construtores privados/protegidos e factories. `rehydrate` reconstrói estado persistido sem reaplicar transições de negócio.
- Toda mudança de saldo e seu ledger correspondente são atômicos. Saldo negativo e ledger mutável são proibidos também pelo schema.
- Conforme Q-WAL-01 aprovada, debit, credit e criação de ledger exigem magnitude estritamente positiva. Zero é permitido como saldo e abertura, sem movimento artificial. Não confunda essa regra com a política futura de aceitação de cada tipo de transação externa.
- Conforme Q-WAL-02 aprovada, cada ledger registra walletVersion, com unicidade por wallet/versão. A abertura positiva usa versão 1; a primeira movimentação após abertura zero usa versão 2. Não substitua a ordem financeira por timestamps.
- Conforme Q-WAL-03 aprovada, OPENING usa origem INTERNAL e identidade estável por wallet, sem provider/game/round fictícios. Abertura positiva confirma crédito e eventos de processamento/saldo na outbox junto com a wallet; abertura zero não produz esses registros. Origem interna não pode ser escolhida por uma entrada externa.
- Conforme Q-WAL-04 aprovada, proteger o banco com constraints locais e validações diferidas incrementais no commit para correspondência de saldo, ledger, versão e contexto financeiro. Cobrir abertura e múltiplas mudanças sem somar todo o histórico por operação. O SQL deve ser comprovado em testes reais; não tratar a aprovação documental como garantia já implementada.
- A SPEC-002 revisão 1.1 está aprovada, incluindo os ajustes de 27/10/2026. Preserve UUIDs internos gerados pelo backend, playerId UUID válido, timestamps UTC, identidade/createdAt imutáveis e ausência de mutação parcial em falhas de domínio. WALLET_ALREADY_EXISTS retorna 409 com error.details.walletId para recuperar a criação. Use os códigos aprovados de Wallet/ledger e preserve os de Money; corrupção persistida não é erro de entrada do cliente nem saldo insuficiente.
- Wallet/WalletLedgerEntry estão implementadas no domínio, com 149 testes próprios em 27/10/2026. debit/credit retornam o lançamento validado antes de alterar o estado; datas usam cópias defensivas. A SPEC-002 segue parcial: schema, aplicação e concorrência persistente têm 177 testes reais; OpenWallet/ProcessTransaction/ResumePendingTransaction estão implementados e verificados; HTTP e consultas estão integrados e verificados; SQS/inbox estão implementados no recorte da SPEC-005; publisher e agendador estão implementados; recuperação de FAILED é restrita a INVALID_REFERENCE_STATE após rollback confirmado.
- Múltiplos movimentos na mesma unidade SQL precisam de UPDATEs distintos, preservando snapshots e versões intermediárias no adaptador MikroORM, com um único commit externo. Comprovar cedo WAL-038–WAL-040; flush não é autorização de ACK/publicação.
- Use lock de linha da wallet no PostgreSQL. Todos os caminhos financeiros seguem a mesma ordem de locks. Nunca use lock global, mutex local ou FIFO como garantia final.
- Na etapa autorizada de aplicação em 27/10/2026, PROC-D01/D02/D03 e os limites do comando foram adotados: SHA-256/JSON-v1; BET/WIN/reversões positivos e LOSS zero; retry limitado e políticas injetáveis. Referências pendentes têm prazo/backoff persistidos e retomada por caso de uso/worker; defaults e provas do scheduler estão nas SPEC-003/004/005 revisão 0.5. Preserve os defaults e as evidências nas SPEC-003/004/006.
- Na etapa autorizada de HTTP/consultas em 27/10/2026, QRY-D01/D02 foram aplicados: cursor HMAC-SHA256 com chave estável de pelo menos 32 bytes, limit 50/máximo 100 e recorte por walletVersion; reconciliação exata NUMERIC em fotografia READ ONLY/REPEATABLE READ, sem reparo. Diagnóstico de total finito fora de Money preserva strings. JSON HTTP tem limite de 32 KiB, correlação UUID e erros seguros; HTTP/SQS não podem redefinir regras do caso de uso.
- Idempotência é persistente: chave e identidade externa únicas, hash de payload canônico e resultado original armazenado. Conteúdo divergente é conflito.
- Estados terminais não são reabertos. Ledger nunca recebe `UPDATE`/`DELETE` pela aplicação; correções financeiras usam novas transações permitidas pelo domínio.
- `OPENING` é interno. `LOSS` e rejeições não geram ledger. A versão da wallet inicia em 1 e só incrementa quando o saldo muda.
- Referências de reversão são verificadas por provider, player, wallet, moeda, rodada, tipo, estado e valor. Referências ausentes permanecem duráveis para retry limitado.
- REV-D01 foi aceita em 27/10/2026: uma única reversão PROCESSED por referência entre REFUND e ROLLBACK, sem kind na chave de unicidade. Reverter uma REFUND não libera a reserva da BET original.
- SDK SQS 3.1157.0 está fixado; LocalStack 4.0.3 tem digest no Compose e volume próprio. CLI/worker desta etapa são locais e usam credenciais de teste. Corpo/origem recuperável nunca vai para logs ou consultas HTTP; inspeção de DLQ retorna apenas metadados.
- Inbox, operação financeira, ledger e outbox são confirmados na mesma transação SQL. ACK e publicação externa só acontecem após commit.
- Antes do ACK de pendências SQS, preservar origem recuperável. FAILED posterior confirma tarefa tardia de DLQ na mesma recuperação SQL; o dispatcher retoma pelo banco, sem exigir redelivery. SQS-D04 limita messageId a 1–128 caracteres ASCII de letras, dígitos, hífen e underscore.
- Na etapa autorizada de publisher em 27/10/2026, EVT-D03 foi aplicado: lote/concorrência até 10, lease 30 s e heartbeat 10 s, backoff 1–300 s, dez falhas suspendem sem descartar. Confirmação usa token/lease e publicado não reabre; retomada é auditada. Envelopes inválidos suspendem sem reescrita. A inbox/projeção consumidora de eventos criada nesta etapa existe somente nos testes.
- Entrega de eventos é at-least-once. Nunca prometa exactly-once entre PostgreSQL e SQS.
- Autenticação externa está adiada. ProviderIdentityPort e guard HTTP existem, com implementação local que permite acesso sem autenticar e bind padrão loopback. Mantenha o ponto de extensão explícito e documente a limitação; não implemente senhas locais nem declare a API segura para produção.

- Na etapa autorizada de agendador em 27/10/2026, adotar polling 1 s após lote, até 50 IDs e cinco operações concorrentes. Seleção não adquire lock financeiro; reler cronograma sob lock da wallet. Cursor local não substitui cronograma durável. Usar helper transacional callback do driver via adaptador MikroORM: rollback deve propagar falha e liberar conexão; não certificar por helper que suprima erro de rollback. Migration 005 mantém diagnóstico imutável e routing tardio no mesmo commit; HTTP-only não ganha envelope fictício. Não reabrir FAILED.

- Na etapa autorizada de health/observabilidade em 27/10/2026, adotar OBS-D01–D03 no recorte local: porta FinancialTelemetry sem dependência técnica na aplicação, catálogo fixo de campos/labels, transições após commit e replay separado. Falha do sink não altera resultados/ACK/publicação. Live sem dependências; ready consulta SQL/schema e filas do papel em paralelo, timeout 2 s; backlog a cada 15 s preserva último valor e sinaliza falha/desatualização. API e workers exportam /metrics por processo em loopback (workers 3101/3102/3103). Não somar gauges SQL repetidos entre papéis. SIGTERM drena; capturar socket antes de finish evita keep-alive preso. Não inventar prova de Prometheus/Grafana, containers de aplicação, tracing ou produção AWS.

## Implementação e banco

- Bun 1.x para runtime, dependências e testes; TypeScript estrito; NestJS; MikroORM; PostgreSQL; SQS via LocalStack; Docker Compose.
- Use `bun.lock`; não introduza lockfiles de outros gerenciadores. Dependências e versões novas exigem justificativa dentro da etapa aprovada.
- Migrações versionadas e reversíveis. Não use sincronização automática de schema como estratégia de entrega.
- Constraints, índices, triggers e privilégios necessários devem estar em migrations e ser testados no PostgreSQL real.
- Um EntityManager/contexto por unidade de trabalho; não compartilhe Identity Map entre requisições ou mensagens.
- Erros de negócio, conflitos, erros transitórios e erros permanentes têm tratamento e códigos explícitos. Não capture qualquer erro como rejeição financeira.
- Não registre segredos, credenciais ou payloads financeiros completos. Use IDs de correlação e logs estruturados.

## Validação e conclusão

- Comandos atualmente disponíveis: `bun install --frozen-lockfile`, `bun run setup:env`, `bun run sqs:up`, `bun run sqs:setup`, `bun run sqs:send`, `bun run worker:sqs`, `bun run worker:outbox`, `bun run worker:references`, `bun run references:failures`, `bun run outbox:inspect`, `bun run outbox:resume`, `bun run dlq:inspect`, `bun run dlq:resume`, `bun run test`, `bun run test:unit`, `bun run test:integration`, `bun run db:up`, `bun run db:stop`, `bun run migration:up`, `bun run migration:down`, `bun run migration:list`, `bun run typecheck`, `bun run build`, `bun run start`, `bun run dev`, `bun run start:prod`.
- Resultados atuais da suíte e ambientes estão em docs/evidence.md e docs/delivery.md; esses documentos concentram os totais de validação. Compose, migrations up/down/up, roles separadas e corrida com três processos estão comprovados. Integração exige o banco real; OpenWallet, ProcessTransaction, ResumePendingTransaction, hash/replay e quatro classes de eventos estão verificados. API HTTP, consultas, cursor HMAC e reconciliação READ ONLY/REPEATABLE READ estão verificados. LocalStack 4.0.3, inbox/origem, consumidor, heartbeat/redrive e dispatcher de DLQ estão verificados. Publisher de eventos financeiros, fencing, heartbeat, suspensão/retomada auditada e deduplicação persistente de teste estão verificados. Scheduler e recuperação restrita de FAILED estão verificados. INVALID_REFERENCE_STATE exige rollback confirmado, nova unidade/lock, mesma pendência/agendamento, ausência de efeito e referência ainda inválida. Não classificar exceções genéricas, corrupção da própria pendência/wallet ou commit incerto. ACK após commit e encaminhamento de DLQ têm testes reais; publicação financeira foi comprovada no LocalStack com processos independentes. Health, métricas e logs foram verificados com PostgreSQL/LocalStack e SIGTERM em processo HTTP separado. Não ampliar a prova de FAILED para qualquer erro nem alegar deploy AWS. A prova atual inclui FAILED automático no caso de uso após corrupção de referência preparada somente em banco UUID descartável, com diagnóstico e tarefa tardia atômicos.
- Mudanças de código exigem os checks existentes pertinentes e testes de comportamento do recurso. Domínio: Bun test. Integração: PostgreSQL e LocalStack reais. Concorrência: processos independentes e barreiras de sincronização, sem simulação sequencial.
- Mudanças só em Markdown exigem revisão de links relativos, coerência entre documentos e ausência de alegações de implementação não comprovadas. Não crie testes que apenas repitam texto ou implementação.
- Testes financeiros terminam verificando saldo persistido igual ao saldo reconstruído pelo ledger. Inclua duplicatas, concorrência e falhas nos limites de commit/ACK/publicação.
- Atualize `docs/requirements.md` com caminhos e evidências reais quando o comportamento existir. Atualize ADRs se uma decisão mudar; não altere silenciosamente uma decisão aceita.
- Ao entregar, informe arquivos alterados, validações executadas, limitações e pendências. Pare no limite da etapa aprovada.

## Revisão de entrega — 27/10/2026

A revisão final ensaiou instalação congelada em cópia sem .env/node_modules/dist,
configuração com nova chave local, typecheck/build e 590 testes (0 falhas; 2.224
asserções). getHttpServer não aceita parâmetro genérico na interface instalada:
tipar o retorno local como Server. O teste de SIGTERM existente passou.
README, arquitetura, ADRs, índice de specs e requisitos distinguem estado atual
do histórico; docs/demo.md contém o roteiro e docs/delivery.md registra evidências
e limites. Containers existentes foram reutilizados, sem apagar volumes.
Não há commit/push autorizado nesta etapa; não promover opcionais a requisitos.

## Organização de pastas e contratos — etapa de 27/10/2026

Refatoração autorizada e verificada no ADR 0004 e no guia src/modules/financial/README.md.
Agrupar domínio por money/wallet/wagering/validation; manter testes junto ao domínio.
Eventos de integração pertencem à aplicação. Funções compartilhadas de aplicação
ficam em application/transactions, sem importar helpers de outro caso de uso.
Contratos de escrita e eventos não pertencem ao arquivo da UoW; inbox, DLQ e
transporte têm portas separadas. A UoW conserva um único contexto financeiro.

Platform não importa modules. Registro de schemas/migrations fica no bootstrap;
SQL, probes e telemetria financeiros pertencem a infrastructure do módulo.
WagerResult não contém HTTP. Status é traduzido em presentation/http.
O decoder de persistência valida/remove httpStatus legado na leitura; não
reescrever terminais históricos nem afrouxar a detecção de corrupção legada.

Executar bun run check:architecture (também integrado ao typecheck). O check usa
AST TypeScript e rejeita ciclos/imports invertidos de valor ou tipo. Não criar
barrels globais ou import dinâmico não verificável para contornar fronteiras.
610 testes aprovados, 2.276 asserções (432 unitários + 178 integrações); build e
typecheck passaram. Nenhuma dependência, migration nova ou publicação foi necessária.

## Melhorias após avaliação técnica — 27/10/2026

A etapa autorizada implementa deadline completo, provas SQS-017/025, CI Linux,
correlação técnica, estilo e documentação corrente separada do histórico (ADR 0005).
ProcessShutdown mantém timer referenciado até limpeza concluída com sucesso;
limpeza que falha não cancela a proteção de prazo. Sinais repetidos não prorrogam.
closeResources tenta recursos posteriores mesmo após erro anterior. Nenhum ACK
especulativo ou FAILED por timeout de encerramento.

Contexto de telemetria é local à operação/entrega, enriquecido explicitamente com
IDs disponíveis; não usar estado global. Passar contexto por UoW/retry e SQS até
ACK. Não ampliar campos sensíveis nem labels. Sink continua best effort.

Prettier 3.9.10 foi adicionado apenas como devDependency fixa para format/check.
Migrations históricas ficam fora da reformatação. Comandos novos: setup, format
e format:check. O README contém início rápido; docs/operations.md tem detalhes,
docs/evidence.md mapeia critérios e docs/history preserva resultados anteriores.

Validar estilo, arquitetura, typecheck, build e testes reais. O workflow Ubuntu é
definição de CI; não declarar sucesso hospedado sem execução real. O ensaio Linux
local usa dependências existentes com bancos/filas UUID, sem apagar volumes.
Testes de lifecycle usam preload do harness e entrypoints reais; produção não
interpreta flags de injeção de falha. Sem commit/push autorizado nesta etapa.

Validação final desta etapa: 626 aprovados, 0 falhas, 2.364 asserções em macOS arm64
e Linux aarch64, 23 arquivos; 435 unitários + 191 integrações. Check de estilo,
arquitetura (84 fontes), typecheck e build passaram. Setup único foi executado e
preservou ambiente/volumes. CI hospedada continua sem execução até publicação.

## Reavaliação: snapshot e COMMIT incerto — 27/10/2026

Escopo autorizado: corrigir moeda histórica e comprovar a falha de transporte real.
WagerTransaction valida a moeda do resultado em contexto compatível. Rejeição
CURRENCY_MISMATCH exige moedas distintas; WALLET_PLAYER_MISMATCH precede essa
verificação e preserva o saldo da wallet consultada. Não invalidar esses históricos
legítimos nem restringir Money a BRL. Consultas/replay recusam corrupção sem reescrita.

isPostgresUnavailable é técnico e compartilhado por escrita/leitura. Códigos SQL
desconhecidos prevalecem sobre texto; fallback aceita somente mensagens exatas de
node-postgres sem código. Não usar classificação ampla por regex da mensagem.
Indisponibilidade de COMMIT não certifica rollback e não autoriza FAILED.

financial-commit-loss.test.ts usa proxy TCP exclusivo de teste, observa resposta
COMMIT real do servidor e reseta antes de entregá-la. Com/sem inbox, outra conexão
confirma efeito único e replay no mesmo pool preserva snapshot após outro movimento.
Não afirmar que esse teste entrega SQS; provas reais de ACK ficam na suíte SQS.
Sem migration/dependência nova ou alteração de hash/política financeira.

Validação final da reavaliação: 639 aprovados, 0 falhas, 2.452 asserções em 25
arquivos (443 unitários + 196 integrações). macOS arm64: 58,48 s; Ubuntu 24.04
AMD64 emulado: 99,96 s, instalação limpa. Formato, arquitetura (85 fontes),
typecheck e build aprovados. API/três workers reiniciados; live/ready/metrics
200 nas quatro portas. Migrations históricas preservadas. CI hospedada pendente
de publicação; nenhum commit/push realizado nesta etapa.

## Organização dos commits — 27/10/2026

O responsável autorizou organizar e criar commits locais de toda a implementação,
com autoria FelipeSakai e e-mail felipesakaiipolito@gmail.com. Essa autorização
inclui a separação por configuração, domínio, aplicação, persistência, mensageria,
HTTP, provas de falha, CI e documentação. Autor e committer usam essa identidade;
não alterar a configuração global de outros projetos. Push e PR seguem dependendo
de autorização própria. As menções anteriores a etapas sem commit descrevem o
histórico dessas etapas e não revogam esta autorização atual.

Preservar os arquivos finais e validar snapshots intermediários ao organizar os
commits. Scripts do package.json entram junto com os arquivos de implementação
que executam. .env, dependências instaladas, builds, logs e arquivos temporários
ficam fora do histórico. A definição de CI não comprova execução hospedada.

## Swagger/OpenAPI — etapa autorizada em 27/10/2026

O responsável solicitou Swagger funcional para testar rotas pela interface. Usar
@nestjs/swagger 12.0.5 fixa, compatível com NestJS 12; UI /docs e JSON /docs-json.
Metadados e schemas ficam na apresentação HTTP e a composição no bootstrap.
Preservar inputs unknown, validadores, contratos monetários e fronteira SQL.
Documentação usa strings para dinheiro, exemplos explícitos e Idempotency-Key
obrigatória. Abertura de wallet e consulta têm formatos de resposta distintos.
Não anunciar auth Bearer inexistente nem enviar o documento a validador externo.
Testar documento/refs/assets e os exemplos contra HTTP/PostgreSQL reais, além de
Try it out no navegador. Essa etapa não inclui novo commit/push automático.

A regressão da etapa Swagger revelou commit entre as duas leituras de identidade
sob READ COMMITTED. ProcessTransaction deve reconhecer o mesmo vencedor por key
ou identidade externa e validar key/hash antes de decidir replay/conflito.
financial-use-cases.test.ts cobre os três cenários com commit real entre leituras;
não afrouxar o teste HTTP concorrente nem aumentar retries para ocultar esse caso.

## Publicação do Swagger — autorização em 27/10/2026

O responsável solicitou testar novamente e publicar as mudanças. Esta autorização
inclui os commits da correção de identidade, Swagger e documentação, com autor e
committer FelipeSakai <felipesakaiipolito@gmail.com>, e push normal para origin/main.
Ela substitui a restrição anterior de não publicar automaticamente esta etapa.
Validar a suíte completa antes dos commits e conferir a nova execução da CI após
push. Preservar configuração global, dados locais e histórico existente.
