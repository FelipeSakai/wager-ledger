# Registro de decisões arquiteturais

ADRs registram contexto, decisão, alternativas e consequências. Uma decisão aceita pode ainda não estar implementada. Mudanças futuras devem registrar por que a escolha mudou, preservando o histórico no Git.

| ADR | Decisão | Estado |
|---|---|---|
| [0001](0001-financial-core.md) | Monólito modular, domínio isolado e fronteira financeira única | Aceita; implementação pendente |
| [0002](0002-consistency-and-delivery.md) | PostgreSQL, MikroORM, locks por wallet, inbox/outbox e LocalStack | Aceita; implementação pendente |
| [0003](0003-scope-and-evidence.md) | Autenticação adiada, evidências reais e evolução por etapas aprovadas | Aceita; implementação pendente |

Data das decisões: 26/10/2026. Detalhes explicitamente abertos em `ARCHITECTURE.md` devem ser resolvidos antes do código correspondente.

Formato para novos registros:

```text
# NNNN — Título
Estado e data
Contexto
Decisão
Alternativas consideradas
Consequências e limitações
Como validar
Pendências, quando existirem
```
