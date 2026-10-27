# Rastreabilidade dos requisitos

Esta matriz define os requisitos funcionais, técnicos e operacionais do Wager Ledger. Alterações de escopo devem ser refletidas na arquitetura, nos ADRs e nos critérios de aceite antes da implementação correspondente.

Esta matriz distingue implementação de intenção. **Bootstrap** significa que há código inicial verificável. **Planejado** significa que ainda faltam implementação e testes. **Adiado** identifica uma capacidade reservada para uma fase posterior. Caminhos futuros abaixo são destinos propostos, não arquivos existentes.

Arquitetura: [ARCHITECTURE.md](../ARCHITECTURE.md). Decisões: [ADRs](adr/README.md). Demonstração: [demo.md](demo.md).

## Relação com as specs

O [índice de specs](specs/README.md) organiza a definição de cada funcionalidade. Os estados documentais não substituem os estados de implementação desta matriz.

| Spec existente | Requisitos detalhados | Situação |
|---|---|---|
| [SPEC-001 — Money](specs/001-money.md) | F04–F08 no contexto do objeto Money; suporte a D02, D03 e D07 | Aprovada, revisão 1.0; sem implementação ou evidência executada |
| [SPEC-002 — Wallet, abertura e ledger](specs/002-wallet-and-ledger.md) | F03, F04, F09, D01–D08; suporte a A05, A06, A08, A12, M04, M10 e M11 | Aprovada, revisão 1.0; sem implementação ou evidência executada |
| [SPEC-003 — Processamento e idempotência](specs/003-wager-processing-and-idempotency.md) | F04, F09, D04, D05, D08, D09, D12, D15, A01–A07, A10, A11, M02, M04, M10, M11, O03, O04 | Rascunho 0.2; overflow de crédito auditável especificado; sem implementação |
| [SPEC-004 — Reversões e pendências](specs/004-reversals-and-pending-references.md) | D05, D10–D15, A01, A03, A05, M04, M10, M12, O03, O04 | Rascunho 0.2; WIN/LOSS separadas da igualdade de reversão; REV-D01 segue proposta |
| [SPEC-005 — SQS e inbox](specs/005-sqs-and-inbox.md) | F02, M01–M07, M12, A07, D05, O01–O04 | Rascunho 0.2; disposição e confirmação duráveis de transferência à DLQ |
| [SPEC-006 — Outbox e eventos](specs/006-outbox-and-events.md) | M04, M08–M12, D06, D08, O01–O04 | Rascunho 0.1; claims, eventos e recuperação especificados |
| [SPEC-007 — Consultas e reconciliação](specs/007-queries-and-reconciliation.md) | A03, A09, A10, A12, D03, D04, D07, O01, O02, O04 | Rascunho 0.1; paginação e fotografia consistente recomendadas |
| [SPEC-008 — Observabilidade e operação](specs/008-observability-and-health.md) | F01–F03, A13, O01–O08, M06, M07, M12 | Rascunho 0.1; opcionais separados do mínimo |

Os requisitos F04–F08 também abrangem componentes futuros; verificar a SPEC-001 isoladamente não encerra todo esse conjunto. As garantias de Wallet, ledger e banco continuam pendentes nas funcionalidades responsáveis.

Todo requisito possui ao menos uma spec responsável ou de suporte na tabela. Isso é cobertura documental, não cobertura de código/testes. Os defaults dos novos rascunhos serão revisados ao implementar; os estados abaixo continuam refletindo a ausência de implementação financeira.

## Fundação, stack e modelagem

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| F01 | Bun 1.x, TypeScript estrito e NestJS | `package.json`, `bun.lock`, `tsconfig.json`, `src/main.ts` | Instalação congelada, typecheck, build e HTTP do bootstrap | Bootstrap |
| F02 | PostgreSQL, SQS e Compose | `src/platform/`, Compose futuro | Serviços acessíveis e instalação reproduzível do zero | Planejado |
| F03 | MikroORM e migrations reversíveis | `src/platform/database/` | Migration up/down em banco real e mappers exatos | Planejado |
| F04 | Construtores privados/protegidos, factories e rehydrate | `financial/domain/` | Testes de criação e reidratação sem reaplicar transições | Planejado |
| F05 | Money imutável com Decimal.js e precisão de trabalho 40; faixa NUMERIC(20, 2) e escala dois | `financial/domain/` e mappers futuros | Soma, subtração, inversão, comparações, serialização, limites de magnitude, overflow e isolamento da configuração | Planejado |
| F06 | Nenhum number/float/double para dinheiro | Domínio, mappers e schema | Valores grandes preservados na ida/volta; revisão de conversões | Planejado |
| F07 | Rejeitar entradas inválidas, negativas e moeda conflitante; exigir forma decimal canônica com duas casas, sem normalizar | Money e contratos de entrada | Entradas inválidas, espaços, sinais, zeros excedentes, formato regional e códigos de erro; MNY-005, MNY-008, MNY-009, MNY-015 | Planejado |
| F08 | Domínio independente do framework/ORM, com catálogo local BRL/USD; aplicação inicialmente BRL | Domínio, mappers e fronteira da aplicação | Construção BRL/USD, conflitos inclusive em equals, rejeição de USD na aplicação e verificação de imports; MNY-008, MNY-009, MNY-021 | Planejado |
| F09 | Entradas, saldos, transações, ledger e apresentação exclusivamente BRL na primeira versão; câmbio fora do escopo | Contratos de aplicação, consultas e presenters futuros | Rejeitar entrada não BRL em HTTP/SQS; respostas monetárias em BRL; processamento e consultas sem dependência de cotação externa | Planejado |

## Wallet, transações e ledger

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| D01 | Wallet única por player + moeda | Domínio, repository e migration | Duas criações concorrentes: uma criação e um conflito | Planejado |
| D02 | Saldo nunca negativo, inclusive por escrita direta | Domínio e schema | Teste de negócio e tentativa SQL com papel da aplicação | Planejado |
| D03 | Saldo e ledger correspondentes e atômicos, protegidos por constraints e validações diferidas incrementais no commit | Unidade de trabalho, migrations e funções SQL futuras | Rollback e tentativas SQL de saldo sem ledger/ledger sem efeito válido; múltiplas mudanças e cadeia incoerente recusadas; WAL-021, WAL-022, WAL-031 e WAL-032 | Planejado |
| D04 | Sem lost update; mesma moeda; versão inicia 1 e muda só com saldo | Wallet e persistência | Corridas reais; LOSS/replay/rejeição sem incremento | Planejado |
| D05 | Tipos e transições explícitos; estados terminais imutáveis | WagerTransaction e schema | Matriz de transições e tentativa de reabrir terminal | Planejado |
| D06 | OPENING de origem INTERNAL e identidade estável por wallet; crédito e eventos de abertura na mesma transação | Caso de uso de abertura, transação interna, ledger e outbox | Saldo positivo com um crédito e dois eventos de outbox; zero sem crédito/eventos; OPENING externa e duplicação recusadas; WAL-033–WAL-036 | Planejado |
| D07 | Ledger append-only, magnitude positiva, aritmética válida e unicidades por wallet/transação e wallet/versão | Entidade e migration | Zero/negativo, UPDATE/DELETE e duplicação barrados; before ± amount = after; walletVersion ordena os lançamentos | Planejado |
| D08 | LOSS e rejeições não criam ledger | Domínio e processamento | Contagem de entradas e saldo/versão antes e depois | Planejado |
| D09 | BET debita e rejeita saldo insuficiente; WIN credita dentro da faixa de saldo | Casos de uso e domínio | Regras unitárias e persistência real; overflow do saldo gera rejeição auditável e replay estável, PROC-021–PROC-023 | Planejado |
| D10 | REFUND reverte integralmente BET processada | Domínio e índice de reversão | Tipo/estado/valor corretos, duplicata e disputa concorrente | Planejado |
| D11 | ROLLBACK inverte BET, WIN ou REFUND processada | Domínio e persistência | Cada direção e rollback que causaria saldo negativo | Planejado |
| D12 | Referência no mesmo provider, player, wallet, moeda e rodada; igualdade de valor somente nas reversões | Política de referência | Conflito por campo/tipo/estado; WIN com valor diferente e LOSS zero referenciadas são válidas, REV-018/REV-019 | Planejado |
| D13 | Reversão uma vez por referência/tipo, mesmo em corrida | Índice único e processamento | Dois processos revertendo a mesma referência | Planejado |
| D14 | Referência ausente durável com backoff e limite/TTL | Worker e campos de agendamento | Fora de ordem, reinício, prazo esgotado com rejeição e evento | Planejado |
| D15 | Failure codes estáveis e distintos por causa | Taxonomia e presenters | Saldo insuficiente de BET distinto do de reversão; contrato consistente | Planejado |

## Idempotência, concorrência e HTTP

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| A01 | Chave obrigatória, persistente e payload divergente em conflito | Processamento e unique constraints | Ausência do header, replay, mesmo header com mudança de negócio | Planejado |
| A02 | Hash canônico só de campos de negócio | Canonicalizador e contrato | Ordem de chaves não altera hash; metadados de transporte não entram | Planejado |
| A03 | Replay mantém resultado e saldo original após outras operações | Resultado persistido | Processar, alterar saldo com outra operação e reenviar a primeira | Planejado |
| A04 | Identidade externa por provider sem contornar deduplicação | Schema e caso de uso | Mesma identidade com keys distintas e providers distintos | Planejado |
| A05 | Lock por wallet, sem lock global; outras wallets avançam | Adaptador transacional | Wallets distintas em paralelo e disputa na mesma wallet | Planejado |
| A06 | Duas BET de 80.00 em saldo 100.00 | Processamento multiprocesso | Uma PROCESSED, outra REJECTED; saldo 20.00 e um débito | Planejado |
| A07 | Mesma BET 50 vezes e pelo menos três instâncias reais | Harness de concorrência | Um efeito financeiro; todos os replays coerentes | Planejado |
| A08 | POST wallet e conflito de duplicata | Controller e abertura | 201, resposta monetária string, 409 na duplicata | Planejado |
| A09 | Consulta wallet e ledger com cursor opaco estável | Query ports e presenters | Ordenação determinística com desempate, sem perdas/duplicatas entre páginas | Planejado |
| A10 | Consulta de transação interna e por provider/ID externo | Query ports e controllers | Mesmo recurso pelos dois acessos e 404 para ausente | Planejado |
| A11 | Submissão distingue inválido, conflito, rejeição, pendência e falha transitória | Presenter HTTP | Contratos 400/409/422/202/503; replay terminal preserva resultado | Planejado |
| A12 | Reconciliação consistente, sem correção silenciosa | Caso de uso e leitura transacional | Saldo igual à soma; divergência controlada sinalizada, logada e medida | Planejado |
| A13 | Health live e ready públicos; ready verifica PostgreSQL/SQS | Bootstrap e health adapters | Dependências indisponíveis afetam ready; live responde | Planejado |

## Mensageria e recuperação

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| M01 | Fila FIFO e DLQ exigidas; envelope validado | Compose/bootstrap SQS | Filas reais com redrive configurado e mensagem válida consumida | Planejado |
| M02 | Mesmo caso de uso para HTTP e SQS | Application e presentation | Entradas equivalentes com resultados financeiros equivalentes | Planejado |
| M03 | Inbox persistente por consumer/message ID, com hash | Inbox repository e migration | Redelivery não repete efeitos; mesmo ID com conteúdo distinto é detectado | Planejado |
| M04 | Inbox, transação, wallet, ledger e outbox no mesmo commit | Unidade de trabalho | Injeção de falha em cada gravação sem estado parcial | Planejado |
| M05 | ACK após commit e conclusão do encaminhamento obrigatório; redelivery seguro | Consumer lifecycle, inbox/disposição e transferência à DLQ | Crash após commit; FAILED com envio DLQ falho retoma antes do ACK; confirmação perdida e replay, SQS-017–SQS-020 | Planejado |
| M06 | Negócio terminal, transiente com retry, permanente com DLQ | Classificação de erros e polling | Falha de PostgreSQL/SQS, payload inválido e contagem de tentativas | Planejado |
| M07 | SIGTERM conclui ou devolve visibilidade | Bootstrap e consumer | Encerramento com mensagem em andamento, sem perda/duplicação | Planejado |
| M08 | Nenhuma publicação antes do commit financeiro | Outbox e publisher | Rollback não publica; commit seguido de crash permite retomada | Planejado |
| M09 | Dois publishers, claims recuperáveis e duplicata segura | Outbox repository e worker | Concorrência real, lease expirado e crash após envio | Planejado |
| M10 | Quatro eventos mínimos e envelope concreto versionado | Classes de eventos | Tipo, versão, IDs, ocorrência e MoneyProps serializados | Planejado |
| M11 | WalletBalanceChanged só quando saldo muda; Processed inclui LOSS | Produção de eventos | LOSS sem evento de saldo; mudanças com evento correspondente | Planejado |
| M12 | Reinício retoma pendências sem perder eventos confirmados | Workers e armazenamento durável | Restart com outbox/ref pendentes e consistência final | Planejado |

## Observabilidade, documentação e escopo

| ID | Requisito | Implementação / destino | Evidência de aceite | Estado |
|---|---|---|---|---|
| O01 | Logs JSON com IDs exigidos, sem dados sensíveis/payload completo | Observability e context propagation | Captura de logs dos fluxos e das falhas com inspeção de conteúdo | Planejado |
| O02 | Métricas por estado, duplicatas, retry, DLQ, locks, lag e latência | Métricas e pontos de emissão | Cenários acionam métricas; IDs individuais fora de labels | Planejado |
| O03 | Unidade, integração e concorrência reais com Bun | Domínio e suites futuras | Comandos reproduzíveis e resultados registrados | Planejado |
| O04 | Invariante final saldo = reconstrução pelo ledger | Asserção financeira compartilhada dos testes | Todos os cenários financeiros encerram com reconciliação | Planejado |
| O05 | README com setup e comandos reais | README atual e futuras atualizações | Bootstrap documentado; setup completo ainda pendente | Bootstrap |
| O06 | Arquitetura, decisões, trade-offs e limitações documentados | ARCHITECTURE e ADRs | Revisão documental; revisar novamente junto à implementação | Documentado; código pendente |
| O07 | Autenticação externa omitida com decisão e ponto de extensão | ADR 0003; ProviderIdentityPort futura | Decisão documentada; porta explícita na implementação HTTP | Adiado; porta pendente |
| O08 | Carga opcional com ambiente e p50/p95/p99 | Fora do mínimo inicial | Se aprovado: script, metodologia e números medidos | Opcional; não iniciado |

## Critério para mudar o estado de um requisito

Substituir destino por caminhos reais e registrar teste/comando, ambiente e resultado. **Implementado** pode indicar código ainda sem comprovação completa; **Verificado** exige a evidência executada. Não usar porcentagens de conclusão baseadas apenas em número de arquivos.

Se um teste depende de Docker ou de uma conexão indisponível, registrar a limitação e manter a evidência pendente. Não substituir o teste real por mock para marcar o requisito como verificado.

São bloqueadores de uma entrega financeira: ponto flutuante monetário, saldo negativo por corrida, efeito duplicado, deduplicação só em memória, correção só com uma instância, publicação antes de commit, ledger ausente ou integração inteiramente simulada.
