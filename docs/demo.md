# Roteiro de demonstração e validação operacional

## Estado deste roteiro

Este roteiro orienta demonstrações técnicas e a validação operacional do Wager Ledger. Apenas o bootstrap está executável hoje. Os cenários financeiros, containers, scripts de seed e testes abaixo ainda serão implementados. Ainda não há medições de concorrência, cobertura ou performance.

Documentos de apoio: [arquitetura](../ARCHITECTURE.md), [decisões](adr/README.md) e [requisitos](requirements.md).

As [oito specs](specs/README.md) já organizam os contratos e cenários alvo. Money e Wallet/ledger estão aprovadas; os demais documentos são rascunhos recomendados para revisão ao aplicar. Este roteiro só ganhará comandos financeiros executáveis quando o código e o ambiente correspondentes existirem.

## Objetivo da demonstração

Explicar como o sistema impede um efeito financeiro duplicado e mantém saldo e ledger consistentes mesmo quando os processos falham. Sustentar cada afirmação com uma regra de domínio, garantia do banco e teste reproduzível.

Agenda sugerida para uma demonstração técnica de 15–20 minutos:

| Tempo aproximado | Conteúdo |
|---|---|
| 2 min | Problema, requisitos prioritários e limitações atuais |
| 3 min | Diagrama, fronteira transacional e direção das dependências |
| 7–10 min | Cenários financeiros, duplicatas, concorrência e recuperação |
| 3 min | Testes, observabilidade, trade-offs e próximos passos |

## O que pode ser demonstrado hoje

Com Bun instalado, no diretório do projeto:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run start:prod
```

Abrir `http://localhost:3000/` (ou a porta configurada). Resposta esperada:

```json
{ "name": "wager-ledger", "status": "bootstrap" }
```

Esse resultado comprova inicialização e build; não comprova saúde do banco, SQS ou garantias financeiras. Encerrar o processo após a demonstração.

## Preparação do ambiente de demonstração financeira

Antes da execução dos cenários financeiros, deverão existir:

- Docker Compose com PostgreSQL, LocalStack, migrations, filas e pelo menos três processos/instâncias da aplicação.
- Seeds identificáveis por cenário; cada cenário usa sua própria wallet e IDs para não depender de execução anterior.
- Scripts versionados para disparo HTTP/SQS, consulta, sincronização dos participantes e injeção de falhas.
- Comandos documentados para setup, testes e teardown apenas dos recursos do ambiente de demonstração. Nunca apagar volumes/dados do usuário para preparar uma demo.
- Registro de versões, commit usado, recursos do ambiente, comandos, resultados e logs sanitizados.
- Uma consulta de reconciliação em fotografia consistente e consultas de ledger/inbox/outbox para comprovar cada efeito.

Os nomes finais dos scripts e comandos serão adicionados quando existirem. A apresentação não deve depender de edição manual do banco para simular sucesso.

## Cenários e evidências esperadas

| Cenário | Ação planejada | Evidência necessária |
|---|---|---|
| Abertura | Criar wallet com 100.00 BRL | Saldo 100.00, versão 1, OPENING e um crédito atômico |
| Fluxo financeiro | BET 25.00 e WIN 10.00 na mesma wallet | Saldo 85.00; ledger de abertura, débito e crédito; reconciliação consistente |
| Replay após outras operações | Reenviar a BET anterior depois da WIN | Resposta original da BET com saldo 75.00, replay true; saldo atual permanece 85.00 |
| Conflito | Reutilizar a key alterando valor ou contexto | 409, sem alteração de saldo/ledger |
| 50 duplicatas | Enviar a mesma BET 50 vezes em paralelo | Um débito e uma identidade financeira persistente; replays coerentes |
| Disputa por saldo | Wallet nova de 100.00; duas BET de 80.00 em processos distintos | Uma PROCESSED, outra REJECTED; saldo 20.00 e exatamente um débito |
| Wallets independentes | Operações simultâneas em wallets diferentes | Ambas avançam; ausência de lock global; ledger consistente em cada uma |
| Três instâncias | Repetir disputa/duplicatas distribuindo entre três processos | PIDs/instâncias e barreira registrados; mesmas invariantes |
| Fora de ordem | Entregar REFUND antes da BET referenciada | PENDING_REFERENCE durável, ACK após commit, posterior aplicação única |
| Referência inexistente | Avançar relógio controlado ou aguardar política aprovada | Limite/TTL respeitado, rejeição com failure code próprio e evento |
| Reversão inválida | Reverter WIN cujo débito inverso excederia o saldo | Rejeição específica de reversão, saldo preservado, nenhum ledger adicional |
| Inbox/redelivery | Interromper consumidor depois do commit e antes de ACK | Mensagem entregue novamente, inbox impede repetição, saldo estável |
| Outbox após commit | Interromper processo financeiro antes de publicar | Outbox já persistida; outro publisher conclui sem perda |
| Dois publishers | Processar outbox concorrente e expirar um claim | Retomada; event IDs estáveis; nenhuma mensagem abandonada |
| Crash após envio | Interromper publisher antes de marcar publicado | Possível duplicata demonstrada; consumidor deduplica por event ID |
| Retry e DLQ | Causar falha transitória e depois mensagem permanente inválida | Backoff/limite, retomada e destino DLQ conforme classificação |
| Reinício | Reiniciar com referências e eventos pendentes | Trabalho retomado, sem reaplicar efeito financeiro confirmado |
| Constraints | Tentar saldo negativo, ledger mutável e duplicação por SQL de teste | Banco recusa com papel da aplicação; rollback preserva estado |
| Observabilidade | Consultar logs, métricas e health durante falhas | Correlação, ausência de segredos e readiness refletindo dependências |

Em cada cenário financeiro, encerrar comparando saldo materializado com reconstrução do ledger. Para eventos, conferir também event ID, estado da outbox e deduplicação do consumidor. Contar ACK ou número de mensagens por si só não comprova correção financeira.

## Pontos de revisão técnica

1. Por que o lock fica na wallet e como wallets diferentes continuam em paralelo?
2. Qual constraint impede duas instâncias de aplicar a mesma operação?
3. O que acontece se a mesma identidade externa aparecer com outra key ou conteúdo?
4. Como wallet, ledger, inbox e outbox compartilham o mesmo commit?
5. O que pode acontecer entre publicar no SQS e marcar publicado no PostgreSQL?
6. Como uma referência ausente sobrevive ao reinício e quando deixa de ser pendência?
7. Por que uma rejeição de negócio recebe ACK, mas uma falha transitória exige retry?
8. Como o banco impede alterações de ledger fora do caminho feliz da aplicação?
9. Como a reconciliação evita comparar leituras de momentos diferentes?
10. O que autenticação adiada significa e como o IdP seria integrado?

## Trade-offs a declarar

Defaults de operação e decisões de negócio dos novos rascunhos estão centralizados no índice de specs. A restrição adicional proposta de uma reversão efetivada por referência, mesmo entre tipos diferentes, deve ser revisada antes de apresentar esse comportamento como contrato acordado.

- A wallet com muita disputa tem processamento serializado; não apresentar throughput sem medição.
- Entrega de eventos é at-least-once, exigindo consumidores idempotentes.
- Ledger de entrada única atende ao escopo; partidas dobradas não foram assumidas.
- Sem IdP, a identidade do chamador HTTP não está garantida.
- LocalStack comprova o fluxo local, mas não substitui validação de configuração operacional na AWS.
- Testes de correção não comprovam capacidade de produção, disponibilidade ou segurança completas.

Quando o sistema estiver implementado, atualizar este roteiro com os comandos exatos, links para testes e resultados da validação vinculados ao commit utilizado. Manter falhas e limitações visíveis.
