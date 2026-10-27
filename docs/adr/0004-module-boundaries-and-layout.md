# 0004 — Organização por responsabilidade e fronteiras verificáveis

Estado: aceita na etapa de refatoração autorizada em 27/10/2026; implementada e validada.

## Contexto

A estrutura por camadas preservava a direção principal dos imports, mas o domínio
plano dificultava localizar conceitos. O resultado financeiro carregava httpStatus,
funções compartilhadas pertenciam ao arquivo de um caso de uso, e platform continha
adaptadores com conhecimento específico do módulo financeiro.

## Decisão

Agrupar domínio por money, wallet, wagering e validation. Erros de transação e
contratos de estado têm arquivos próprios; tipos de transação têm uma origem única.
Testes do domínio continuam junto às classes.

Eventos existentes são contratos de integração, mantidos em application/events.
A coordenação compartilhada por ProcessTransaction e ResumePendingTransaction fica
em application/transactions; nenhum dos dois importa detalhes internos do outro.
Contratos de inbox, recuperação de DLQ, transporte, escrita financeira e outbox são
separados por responsabilidade. FinancialUnitOfWork conserva o mesmo callback e
contexto transacional de todas as gravações.

Domínio e aplicação produzem resultados financeiros sem httpStatus. A apresentação
HTTP mapeia estado para o status de submissão. O adaptador de persistência valida
campos HTTP do formato antigo e entrega ao domínio somente o resultado financeiro.
Resultados antigos não são reescritos; resultados novos não incluem o campo.
O contrato HTTP, a identidade, o hash e os saldos históricos permanecem compatíveis.

Adaptadores SQS, telemetria financeira, probes SQL/backlog e diagnósticos pertencem
a infrastructure do módulo. O consumidor de comandos pertence a presentation/sqs.
Platform mantém a fábrica técnica de ORM/client SQS e o lifecycle operacional,
recebendo modelos, migrations e métricas por configuração ou contrato. Bootstrap
compõe as implementações e registra o schema financeiro.

Migrations foram movidas para infrastructure/persistence/migrations. Nomes, ordem,
DDL e política de execução foram preservados. A reorganização não cria migration
nem altera o histórico financeiro.

Um check com a AST do TypeScript verifica imports de valor e tipo, resolução local,
ciclos, fronteiras de camadas, independência de platform e ausência de httpStatus
no domínio/aplicação. Ele executa como parte de typecheck e também por comando próprio.

## Alternativas consideradas

- Apenas mover arquivos: melhora navegação, mas conserva acoplamentos semânticos.
- Separar wallet, ledger e transações em serviços: rompe a simplicidade do commit
  financeiro comum sem requisito que justifique esse custo.
- Criar repositories/base classes genéricas ou barrels globais: aumenta a superfície
  compartilhada e pode esconder dependências; imports continuam explícitos.
- Atualizar todos os resultados históricos: desnecessário para a leitura compatível
  e contrário à imutabilidade de terminais. O decoder fica na fronteira de storage.

## Consequências e validação

Há mais arquivos pequenos para contratos com responsabilidades distintas. O guia
[do módulo](../../src/modules/financial/README.md) descreve onde colocar mudanças.
Os entrypoints e scripts públicos de API/workers preservam seus caminhos.

610 testes aprovados, zero falhas, 2.276 asserções: 432 unitários e 178 integrações.
Typecheck/check de arquitetura/build passaram. A suíte inclui replay real de
resultados legados PROCESSED/REJECTED/PENDING_REFERENCE sem reescrita; corrupção do
campo legado continua recusada. HTTP mantém status e conteúdo públicos. Concorrência,
rollback, ACK, outbox, FAILED classificado e SIGTERM continuam cobertos pelas suítes.

O check de imports não é uma prova formal de independência semântica ou correção
financeira. Sem novas dependências, commit, push ou alteração das regras monetárias.
