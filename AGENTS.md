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
- A biblioteca selecionada é Decimal.js, com construtor exclusivo e precisão de trabalho 40. A faixa de Money acompanha a persistência NUMERIC(20, 2); overflow gera erro, sem arredondamento. Fixar a versão e instalar a dependência somente na etapa de implementação autorizada.
- Contratos monetários exigem strings com exatamente duas casas. Rejeite números, `"25"` e `"25.0"`, sem normalização silenciosa ou arredondamento.
- A SPEC-001 revisão 1.0 está aprovada. Siga seu catálogo local BRL/USD, gramática canônica, separação from/rehydrate, erro de moeda inclusive em equals e códigos de erro estáveis. Não reabra essas escolhas sem uma revisão explícita de contrato.
- Money representa moedas distintas; use BRL e USD nos testes de conflito. A primeira versão da aplicação usa somente BRL nas entradas, saldos, transações, ledger e apresentação de valores. Não coloque essa restrição comercial dentro do objeto de valor.
- Cotações externas, entrada/visualização convertida e conversão entre carteiras ficam fora da primeira versão. Não adicione API, biblioteca ou módulo de câmbio sem uma nova etapa explicitamente aprovada.
- Classes de domínio têm estado encapsulado, construtores privados/protegidos e factories. `rehydrate` reconstrói estado persistido sem reaplicar transições de negócio.
- Toda mudança de saldo e seu ledger correspondente são atômicos. Saldo negativo e ledger mutável são proibidos também pelo schema.
- Conforme Q-WAL-01 aprovada, debit, credit e criação de ledger exigem magnitude estritamente positiva. Zero é permitido como saldo e abertura, sem movimento artificial. Não confunda essa regra com a política futura de aceitação de cada tipo de transação externa.
- Conforme Q-WAL-02 aprovada, cada ledger registra walletVersion, com unicidade por wallet/versão. A abertura positiva usa versão 1; a primeira movimentação após abertura zero usa versão 2. Não substitua a ordem financeira por timestamps.
- Conforme Q-WAL-03 aprovada, OPENING usa origem INTERNAL e identidade estável por wallet, sem provider/game/round fictícios. Abertura positiva confirma crédito e eventos de processamento/saldo na outbox junto com a wallet; abertura zero não produz esses registros. Origem interna não pode ser escolhida por uma entrada externa.
- Conforme Q-WAL-04 aprovada, proteger o banco com constraints locais e validações diferidas incrementais no commit para correspondência de saldo, ledger, versão e contexto financeiro. Cobrir abertura e múltiplas mudanças sem somar todo o histórico por operação. O SQL deve ser comprovado em testes reais; não tratar a aprovação documental como garantia já implementada.
- A SPEC-002 revisão 1.0 está aprovada integralmente. Preserve UUIDs internos gerados pelo backend, playerId UUID válido, timestamps UTC, identidade/createdAt imutáveis e ausência de mutação parcial em falhas de domínio. Use os códigos aprovados de Wallet/ledger e preserve os de Money; corrupção persistida não é erro de entrada do cliente nem saldo insuficiente.
- Use lock de linha da wallet no PostgreSQL. Todos os caminhos financeiros seguem a mesma ordem de locks. Nunca use lock global, mutex local ou FIFO como garantia final.
- Idempotência é persistente: chave e identidade externa únicas, hash de payload canônico e resultado original armazenado. Conteúdo divergente é conflito.
- Estados terminais não são reabertos. Ledger nunca recebe `UPDATE`/`DELETE` pela aplicação; correções financeiras usam novas transações permitidas pelo domínio.
- `OPENING` é interno. `LOSS` e rejeições não geram ledger. A versão da wallet inicia em 1 e só incrementa quando o saldo muda.
- Referências de reversão são verificadas por provider, player, wallet, moeda, rodada, tipo, estado e valor. Referências ausentes permanecem duráveis para retry limitado.
- Inbox, operação financeira, ledger e outbox são confirmados na mesma transação SQL. ACK e publicação externa só acontecem após commit.
- Entrega de eventos é at-least-once. Nunca prometa exactly-once entre PostgreSQL e SQS.
- Autenticação externa está adiada. Mantenha o ponto de extensão explícito e documente a limitação; não implemente senhas locais nem declare a API segura para produção.

## Implementação e banco

- Bun 1.x para runtime, dependências e testes; TypeScript estrito; NestJS; MikroORM; PostgreSQL; SQS via LocalStack; Docker Compose.
- Use `bun.lock`; não introduza lockfiles de outros gerenciadores. Dependências e versões novas exigem justificativa dentro da etapa aprovada.
- Migrações versionadas e reversíveis. Não use sincronização automática de schema como estratégia de entrega.
- Constraints, índices, triggers e privilégios necessários devem estar em migrations e ser testados no PostgreSQL real.
- Um EntityManager/contexto por unidade de trabalho; não compartilhe Identity Map entre requisições ou mensagens.
- Erros de negócio, conflitos, erros transitórios e erros permanentes têm tratamento e códigos explícitos. Não capture qualquer erro como rejeição financeira.
- Não registre segredos, credenciais ou payloads financeiros completos. Use IDs de correlação e logs estruturados.

## Validação e conclusão

- Comandos atualmente disponíveis: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`, `bun run start`, `bun run dev`, `bun run start:prod`.
- Ainda não existem scripts de testes, Docker Compose ou migrations. Não invente resultados nem execute comandos de roteiro futuro como se estivessem disponíveis.
- Mudanças de código exigem os checks existentes pertinentes e testes de comportamento do recurso. Domínio: Bun test. Integração: PostgreSQL e LocalStack reais. Concorrência: processos independentes e barreiras de sincronização, sem simulação sequencial.
- Mudanças só em Markdown exigem revisão de links relativos, coerência entre documentos e ausência de alegações de implementação não comprovadas. Não crie testes que apenas repitam texto ou implementação.
- Testes financeiros terminam verificando saldo persistido igual ao saldo reconstruído pelo ledger. Inclua duplicatas, concorrência e falhas nos limites de commit/ACK/publicação.
- Atualize `docs/requirements.md` com caminhos e evidências reais quando o comportamento existir. Atualize ADRs se uma decisão mudar; não altere silenciosamente uma decisão aceita.
- Ao entregar, informe arquivos alterados, validações executadas, limitações e pendências. Pare no limite da etapa aprovada.
