# Registro de decisões arquiteturais

ADRs registram contexto, decisão, alternativas e consequências. Uma decisão aceita pode ainda não estar implementada. Mudanças futuras devem registrar por que a escolha mudou, preservando o histórico no Git.

| ADR | Decisão | Estado |
|---|---|---|
| [0001](0001-financial-core.md) | Monólito modular, domínio isolado e fronteira financeira única | Aceita; Money/Wallet/ledger verificados no domínio; domínio/aplicação/persistência comprovados; HTTP/consultas comprovados; consumo SQS/inbox/DLQ comprovados; publisher verificado no recorte local |
| [0002](0002-consistency-and-delivery.md) | PostgreSQL, MikroORM, locks por wallet, inbox/outbox e LocalStack | Aceita; SQL/HTTP/SQS/inbox/DLQ comprovados no recorte; publisher, agendador e recuperação restrita de FAILED verificados |
| [0003](0003-scope-and-evidence.md) | Autenticação adiada, evidências reais e evolução por etapas aprovadas | Aceita; porta de identidade HTTP explícita; health/logs/métricas locais verificados; IdP e operação de produção pendentes |
| [0004](0004-module-boundaries-and-layout.md) | Pastas por conceito, resultados sem HTTP e adaptadores com proprietário explícito | Aceita; implementada e verificada com 610 testes e check de arquitetura |
| [0005](0005-shutdown-failure-evidence-and-validation.md) | Deadline completo, contexto de correlação, provas de falha, estilo e CI Linux | Aceita; implementada e validada localmente; execução hospedada pendente |

Decisões iniciais: 26/10/2026. Complementos aceitos na revisão de 27/10/2026 estão datados nos ADRs: recuperação da criação, persistência por movimento, reversão única entre tipos e recuperação de DLQ após ACK. Detalhes explicitamente abertos em `ARCHITECTURE.md` devem ser resolvidos antes do código correspondente.

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
