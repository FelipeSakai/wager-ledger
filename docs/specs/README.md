# Especificações funcionais e técnicas

As specs descrevem comportamentos verificáveis do Wager Ledger antes de sua implementação. São organizadas por capacidade do produto, com contratos, invariantes, exemplos e critérios de aceite.

## Documentos e responsabilidades

- [Arquitetura](../../ARCHITECTURE.md): estrutura, direção das dependências e fronteiras transacionais.
- [ADRs](../adr/README.md): justificativas, alternativas e consequências das decisões.
- [Requisitos](../requirements.md): catálogo de necessidades e rastreabilidade das evidências.
- Specs: comportamento detalhado de cada funcionalidade e condições para aceitá-la.
- [AGENTS.md](../../AGENTS.md): instruções para executar o trabalho dentro das decisões e do escopo autorizado.

Uma spec pode detalhar uma decisão arquitetural, mas não alterá-la silenciosamente. Se houver conflito, registrar a divergência, discutir a mudança e atualizar os documentos relacionados após aprovação.

## Índice e sequência de elaboração

As oito specs estão redigidas. SPEC-001 e SPEC-002 estão aprovadas na revisão 1.0; SPEC-003 a SPEC-008 são rascunhos com defaults recomendados para revisão ao aplicar. Nenhuma funcionalidade descrita nas specs foi implementada. A ordem abaixo indica dependências, não autorização automática de código.

| ID | Funcionalidade | Documento | Dependências de definição | Estado |
|---|---|---|---|---|
| SPEC-001 | Money e contratos monetários | [001-money.md](001-money.md) | Arquitetura e ADR 0001 | Aprovada, revisão 1.0; implementação não iniciada |
| SPEC-002 | Wallet, abertura e ledger | [002-wallet-and-ledger.md](002-wallet-and-ledger.md) | SPEC-001 | Aprovada, revisão 1.0; implementação não iniciada |
| SPEC-003 | Processamento e idempotência | [003-wager-processing-and-idempotency.md](003-wager-processing-and-idempotency.md) | SPEC-001, SPEC-002 | Rascunho 0.2; overflow de crédito explicitado |
| SPEC-004 | Reversões e referências pendentes | [004-reversals-and-pending-references.md](004-reversals-and-pending-references.md) | SPEC-002, SPEC-003 | Rascunho 0.2; referência WIN/LOSS separada de reversão |
| SPEC-005 | Consumo SQS e inbox | [005-sqs-and-inbox.md](005-sqs-and-inbox.md) | SPEC-003, SPEC-004 | Rascunho 0.2; retomada durável de DLQ explicitada |
| SPEC-006 | Outbox e eventos de integração | [006-outbox-and-events.md](006-outbox-and-events.md) | SPEC-002, SPEC-003, SPEC-004 | Rascunho 0.1 |
| SPEC-007 | Consultas, paginação e reconciliação | [007-queries-and-reconciliation.md](007-queries-and-reconciliation.md) | SPEC-002, SPEC-003 | Rascunho 0.1 |
| SPEC-008 | Observabilidade e health | [008-observability-and-health.md](008-observability-and-health.md) | SPEC-003, SPEC-005, SPEC-006, SPEC-007 | Rascunho 0.1 |

Dependências de implementação também serão descritas em cada spec. Definir consumo e publicação em documentos separados não permite commits financeiros parciais: inbox, saldo, ledger, transação e outbox continuam na mesma transação quando aplicáveis.

Autenticação externa permanece adiada no [ADR 0003](../adr/0003-scope-and-evidence.md). Migrations, constraints e shutdown serão especificados nas funcionalidades às quais dão suporte; itens transversais não devem desaparecer por falta de um arquivo próprio.

A primeira versão usa BRL nas entradas, saldos, transações, ledger e apresentação de valores. Câmbio, API de cotações e entrada/visualização convertidas não fazem parte desta sequência de specs. Money continua multimoeda e os testes de conflito BRL/USD permanecem previstos. Uma futura capacidade de câmbio dependerá de novo escopo aprovado.

## Modelo e convenções

O responsável autorizou a elaboração dos rascunhos restantes sem interrupção por escolha de rotina. Os defaults abaixo são recomendações explícitas para revisar junto à aplicação das specs, não alegações de aprovação individual. Funcionalidades opcionais permanecem separadas do mínimo; dúvidas de implementação serão tratadas na etapa autorizada de código.

Usar [TEMPLATE.md](TEMPLATE.md) como base. Cada spec deve conter:

1. Identificação, estado, dependências e requisitos relacionados.
2. Objetivo, escopo e exclusões.
3. Vocabulário, regras, invariantes e contratos.
4. Fluxos, resultados, erros e recuperação quando aplicáveis.
5. Cenários de aceite com IDs estáveis e exemplos concretos.
6. Estratégia de testes e evidências necessárias.
7. Decisões pendentes e registro da aprovação.

Documentação e explicações usam português. Identificadores técnicos, contratos e failure codes usam inglês. Nomes de erros propostos devem ser identificados como propostas até a aprovação da taxonomia.

Escrever cenários como condições observáveis, evitando prescrever classes auxiliares ou estruturas internas sem necessidade. Casos financeiros incluem saldo, ledger e versão quando aplicáveis. Infraestrutura inclui falhas antes/depois de commit, ACK e publicação. Quando um tema não se aplica, registrar o motivo.

## Ciclo de vida

| Estado | Significado | Condição de saída |
|---|---|---|
| Rascunho | Texto em discussão; propostas não são decisões finais | Pendências resolvidas e aprovação explícita do conteúdo |
| Aprovada | Contrato acordado; código ainda pode não existir | Autorização específica para implementar a etapa |
| Em implementação | Código em desenvolvimento no escopo autorizado | Critérios atendidos e evidências executadas |
| Verificada | Comportamentos demonstrados no ambiente exigido | Mudança de comportamento exige nova revisão |

`Não iniciada` é uma condição do plano, não um estado de um arquivo inexistente. Aprovar a criação do rascunho não aprova suas opções técnicas; aprovar o conteúdo não autoriza implementar, fazer commit ou publicar sem autorização correspondente.

A revisão/aprovação pode abranger um conjunto de specs ao autorizar uma etapa de implementação. Não exigir perguntas separadas para cada parâmetro ajustável. Contradições com decisões aprovadas e alterações materiais de negócio continuam explícitas.

Mudanças de uma spec aprovada voltam para revisão, com resumo do impacto. Mudança de arquitetura requer também revisão do ADR. Registrar aprovação com data e escopo reais; não preencher um responsável ou aceite por suposição.

## Rastreabilidade e evidência

Cada cenário usa um ID como `MNY-001`. Os testes futuros deverão permitir identificar os cenários que cobrem; um teste pode cobrir vários cenários, desde que a relação seja explícita. Os IDs de requisitos vêm de [requirements.md](../requirements.md), sem renumerá-los a cada edição.

Somente apontar arquivos e comandos de teste como existentes quando estiverem no repositório. A spec descreve a evidência esperada; a matriz registra o resultado real. Rascunho, aprovação documental e exemplos não contam como teste executado.

## Defaults a revisar ao aplicar

A revisão independente das specs identificou três ajustes documentais, aplicados em 26/10/2026 nas revisões 0.2 de SPEC-003/004/005: classificação auditável de overflow do saldo após crédito válido; igualdade de valor restrita às reversões; obrigação de transferência à DLQ preservada no replay de FAILED. Foram acrescentados cenários específicos. Isso não transforma os rascunhos em código implementado ou contratos integralmente aprovados.

| Tema | Recomendação documentada | Onde |
|---|---|---|
| Valores e referências por tipo | BET/WIN positivos, LOSS zero; referência opcional de WIN/LOSS é validada quando fornecida | SPEC-003, PROC-D02 |
| Hash e conflitos | JSON canônico de campos de negócio; key global e identidade externa imutáveis | SPEC-003, PROC-D01 |
| Reversões de tipos diferentes | Proposta de uma reversão efetivada por referência, impedindo REFUND + ROLLBACK cumulativos sobre a mesma BET | SPEC-004, REV-D01; decisão de negócio importante |
| Referências fora de ordem | Prazo de 24h, backoff persistido e limite defensivo de 1.000 verificações | SPEC-004, REV-D02 |
| SQS e shutdown | Polling, visibilidade renovável, redrive/DLQ e janela de drenagem | SPEC-005, SQS-D01 a SQS-D03 |
| Outbox | Claim/lease com fencing; dez falhas suspendem automação sem descartar o fato | SPEC-006, EVT-D01 a EVT-D03 |
| Consultas | Cursor assinado com recorte por versão; reconciliação em fotografia consistente | SPEC-007, QRY-D01 e QRY-D02 |
| Operação | Logs JSON, métricas de cardinalidade limitada e health separados | SPEC-008, OBS-D01 a OBS-D03 |

Tempos e limites operacionais serão configuráveis e testados; não são funcionalidades opcionais. A proposta de unicidade adicional de reversão é mais restritiva que a garantia mínima por referência/tipo e não altera silenciosamente a arquitetura aceita.

## Opcionais fora da primeira entrega

- OpenTelemetry/tracing e dashboards.
- Teste de carga com metodologia e percentis medidos.
- Exportações e projeções de relatórios.
- Ordenação estrita adicional de publicação por wallet.
- Interface administrativa de DLQ, redrive automático e limpeza automática de registros operacionais.
- Detecção antecipada de ciclos complexos entre referências.

Os diagnósticos e meios mínimos de recuperação continuam obrigatórios mesmo sem interface gráfica. IdP externo está adiado; câmbio, saldo estrangeiro e frontend estão fora do escopo atual. Nenhum desses itens deve ser instalado/implementado só por estar mencionado.

## Próxima etapa

O planejamento documental das oito specs está disponível. A etapa de implementação deverá escolher um recorte verificável, revisar seus defaults e dependências e obter autorização para código. A sequência recomendada começa por Money e domínio de Wallet/ledger, seguida de schema e fluxo financeiro integrado. Não entregar um fluxo como completo antes de implementar sua atomicidade com inbox/outbox quando aplicáveis.
