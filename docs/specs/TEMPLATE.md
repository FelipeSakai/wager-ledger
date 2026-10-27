# SPEC-NNN — Nome da funcionalidade

> Modelo de documento. Copiar para uma spec; substituir os campos antes de solicitar aprovação. Este arquivo não define comportamento do produto.

| Campo | Conteúdo |
|---|---|
| ID | SPEC-NNN |
| Estado | Rascunho |
| Revisão | 0.1 |
| Requisitos relacionados | IDs da matriz de requisitos |
| Dependências de definição | Specs e decisões que precisam estar acordadas |
| Dependências de implementação | Componentes necessários para entregar o comportamento |
| Aprovação do conteúdo | Pendente |
| Implementação | Não iniciada |

## Objetivo

Descrever a capacidade entregue, quem a utiliza e o resultado observável.

## Escopo e exclusões

Listar os comportamentos cobertos e os limites. Apontar a spec responsável por temas relacionados. Não usar uma exclusão para remover um requisito obrigatório sem decisão explícita.

## Vocabulário e contexto

Definir os termos relevantes. Referenciar a arquitetura e os ADRs aplicáveis, evitando copiar integralmente decisões estruturais.

## Regras e invariantes

Numerar regras e descrever o que sempre precisa ser verdadeiro. Distinguir regras já acordadas das propostas pendentes de aprovação. Identificar também quais invariantes exigem proteção no schema.

## Contratos

Definir entradas, tipos, formatos, limites, campos obrigatórios/opcionais, saídas e compatibilidade. Incluir exemplos válidos e inválidos. Para dinheiro, usar strings; para HTTP, definir status e envelope; para eventos, definir tipo, versão e IDs.

Nomes e assinaturas novos podem ser propostos no rascunho, mas não devem parecer contratos existentes.

## Fluxos, estados e falhas

Descrever caminho principal, alternativas e transições. Quando aplicável, explicitar unidade transacional, ordem de locks, idempotência, retries, timeout, shutdown e recuperação. Informar quando ACK e publicação podem ocorrer. Se não houver persistência ou concorrência, registrar por que esses tópicos não se aplicam.

## Cenários de aceite

Para cada cenário:

```text
ID: PREFIX-001
Regra/requisito relacionado: ...
Dado: estado inicial e dependências relevantes
Quando: ação ou falha provocada
Então: resultado e efeitos observáveis
Evidência: tipo de teste e asserções necessárias
Dependência de decisão: nenhuma ou ID da pendência
```

Cobrir sucesso, entrada inválida, limites e falhas relevantes. Para operações financeiras, incluir moedas, ledger, saldo e versão. Para concorrência, indicar processos participantes e como sincronizar a disputa.

## Estratégia de testes e conclusão

Definir os níveis de teste, o ambiente e as evidências. Separar o que pode ser isolado em unidade do que exige PostgreSQL/SQS reais. Não inventar comandos ou resultados. Indicar condições para mover o estado para `Verificada`.

## Decisões pendentes

No planejamento autorizado em lote, registrar escolhas de rotina como defaults recomendados, com justificativa e impacto, sem interromper a elaboração por cada item. Destacar opções muito opcionais e decisões materiais que deverão ser revisadas ao implementar. Rascunho com recomendação concreta é preferível a uma lista de perguntas sem proposta.

| ID | Questão | Proposta e justificativa | Impacto | Situação |
|---|---|---|---|---|
| Q-NNN-01 | Questão a decidir | Alternativa sugerida, ainda não aprovada | Contrato, dados ou operação afetados | Pendente |

Se não houver pendências, registrar isso explicitamente. Questões que mudam o contrato ou impedem testes objetivos devem ser resolvidas antes de aprovar a spec.

## Registro de revisão e aprovação

| Revisão | Data | Alteração | Estado |
|---|---|---|---|
| 0.1 | Preencher | Rascunho inicial | Rascunho |

Aprovação do conteúdo: pendente. Autorização de implementação: não concedida por este documento. Evidências executadas: nenhuma até registro real.
