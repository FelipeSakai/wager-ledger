# SPEC-004 — Reversões e referências pendentes

| Campo | Conteúdo |
|---|---|
| ID | SPEC-004 |
| Estado | Rascunho |
| Revisão | 0.2 |
| Requisitos relacionados | D05, D10–D15, A01, A03, A05, M04, M10, M12, O03, O04 |
| Dependências | SPEC-001 e SPEC-002 aprovadas; contratos recomendados de SPEC-003 e SPEC-006 |
| Aprovação do conteúdo | Revisão prevista antes da implementação; defaults recomendados identificados |
| Implementação | Não iniciada |

## Objetivo e escopo

Reverter integralmente uma operação elegível sem editar seu histórico e aguardar referências entregues fora de ordem com retomada após falhas. WIN/LOSS com referência explícita compartilham somente resolução, validação de contexto/estado e espera pela referência, conforme [SPEC-003](003-wager-processing-and-idempotency.md); não herdam igualdade de valor nem efeito inverso de reversão.

Não inclui reversão parcial, câmbio, compensação manual sem trilha, rollback de LOSS/OPENING/ROLLBACK ou alteração de uma transação terminal. [Wallet e ledger](002-wallet-and-ledger.md) permanecem na mesma fronteira SQL.

## Regras de referência

- Resolver por `(providerId, referenceExternalTransactionId)`, não por ID interno fornecido pelo cliente.
- A referência deve pertencer ao mesmo provider, player, wallet, moeda e rodada. Não acrescentar igualdade de gameId como requisito implícito.
- REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND. A referência precisa estar PROCESSED para aplicar o efeito.
- Somente em REFUND/ROLLBACK, o valor precisa ser integral e igual ao da referência, preservando moeda e precisão de Money. Nessas reversões, um valor maior/menor não é estorno parcial permitido. WIN pode ter valor diferente da BET referenciada e LOSS conserva sua regra própria de zero.
- Reversão que debitaria além do saldo é rejeitada e auditável com REVERSAL_INSUFFICIENT_FUNDS, diferente de INSUFFICIENT_FUNDS de BET.
- Nunca editar/apagar a referência ou seu ledger. Uma reversão efetivada cria nova transação, lançamento invertido, versão e eventos. WIN segue o crédito próprio e LOSS não cria ledger nem altera a versão.

| Operação | Referência | Efeito |
|---|---|---|
| REFUND | BET processada | CREDIT do valor original |
| ROLLBACK | BET processada | CREDIT do valor original |
| ROLLBACK | WIN processada | DEBIT do valor original |
| ROLLBACK | REFUND processada | DEBIT do valor original |

## Unicidade e política adicional recomendada — REV-D01

O mínimo é impedir duas reversões processadas do mesmo tipo sobre a mesma referência. **Recomendação adicional para revisão:** impedir também que REFUND e ROLLBACK revertam a mesma referência duas vezes, por tipos diferentes. Usar reserva/unicidade de reversão efetivada por referenceTransactionId, restrita a REFUND/ROLLBACK PROCESSED. Tentativas rejeitadas não consomem o direito de reversão.

Essa recomendação evita devolver duas vezes o débito de uma BET usando duas operações distintas. É mais restritiva que a unicidade por referência/tipo e precisa ser confirmada ao aplicar esta spec; não está implicitamente aprovada pelas specs anteriores. Alternativa: manter somente a unicidade por tipo, documentando os efeitos cumulativos permitidos.

Reverter um REFUND por ROLLBACK atua sobre a transação REFUND, sem reabrir a BET original nem liberar sua reserva de reversão. Estados terminais e ledger permanecem imutáveis.

## Referência fora de ordem — REV-D02

Referência inexistente ou existente em estado ainda não terminal gera PENDING_REFERENCE. Registrar identidade, comando, motivo de espera, número de tentativas, nextAttemptAt e prazo na mesma transação com inbox/outbox quando aplicáveis. Persistir evento de pendência uma vez por transação, não a cada varredura.

Contexto/tipo inválido ou referência REJECTED/FAILED gera rejeição terminal específica, não espera infinita. Auto-referência pelo mesmo ID externo é inválida. Dependências cíclicas entre pendências não podem movimentar saldo e terminam por prazo; detecção antecipada de grafos complexos é opcional.

Defaults recomendados:

| Parâmetro | Valor e justificativa |
|---|---|
| Prazo de espera | 24 horas desde createdAt, persistido; cobre reinícios e atrasos sem pendência eterna |
| Limite de tentativas | 1.000 verificações de referência; limite defensivo adicional ao prazo |
| Backoff | Base de 5 segundos, exponencial, teto de 300 segundos e jitter entre metade do atraso e o atraso completo |
| Polling | A cada segundo, lote de até 50 IDs elegíveis; parâmetros configuráveis |
| Falha transitória de infraestrutura | Não consumir tentativa de referência nem prorrogar createdAt/prazo |

O prazo é avaliado depois de reler a referência: se ela já estiver aplicável no momento da retomada, processar; se continuar indisponível e prazo/limite tiver sido atingido, rejeitar. Isso permite recuperação após atraso do próprio worker sem rejeitar uma referência já disponível. Uma transação já rejeitada nunca volta a processar se a referência aparecer depois.

## Worker e transação

1. Selecionar IDs candidatos sem segurar lock de transação antes de adquirir o lock da wallet.
2. Abrir novo contexto SQL, bloquear wallet, reler a transação e confirmar estado, elegibilidade e agendamento. Outra instância pode já ter concluído a operação.
3. Resolver e validar referência; todos os registros financeiros relevantes usam a mesma ordem de locks.
4. Se aplicável, reservar a reversão, aplicar o domínio, atualizar saldo/versão, ledger, status, snapshot e outbox no mesmo commit. A inbox da entrega original já está confirmada e não é recriada pelo agendador.
5. Se ainda pendente, persistir tentativas/nextAttemptAt; se esgotada, registrar rejeição, snapshot do saldo observado e evento na mesma unidade.
6. Liberar locks por commit/rollback. Nenhuma consulta a SQS ou outra API dentro da transação.

Uma corrida entre dois workers da mesma pendência não incrementa tentativas duas vezes nem aplica duas reversões: reler o estado/agendamento sob lock. Wallets diferentes continuam em paralelo. Retry de uma rejeição financeira exige nova identidade se for uma nova tentativa de negócio; repetir a key original devolve o resultado original.

## Resultado e códigos recomendados

Submissão pendente usa 202 e informa transactionId, status, balance observado e idempotentReplay, seguindo SPEC-003. O saldo é informativo da observação, sem afirmar aplicação. Após terminal, o snapshot é fixado.

| Código | Situação |
|---|---|
| REFERENCE_CONTEXT_MISMATCH | Provider/player/wallet/moeda/rodada incompatíveis |
| REFERENCE_KIND_NOT_ALLOWED | Tipo de referência incompatível com a operação |
| REFERENCE_NOT_PROCESSED | Referência em estado terminal que não permite aplicação |
| REFERENCE_SELF_REFERENCE | Operação referencia a própria identidade externa |
| REFERENCE_AMOUNT_MISMATCH | Somente REFUND/ROLLBACK: valor não integralmente igual ao da referência |
| REFERENCE_NOT_FOUND_EXPIRED | Referência ausente ao esgotar prazo/limite |
| REFERENCE_NOT_READY_EXPIRED | Referência existente, mas ainda não aplicável ao esgotar prazo/limite |
| REFERENCE_ALREADY_REVERSED | Reserva de reversão já consumida conforme política adotada |
| REVERSAL_INSUFFICIENT_FUNDS | Inversão produziria saldo negativo |

Rejeições são 422 e sem novo ledger. Falhas transitórias mantêm possibilidade de retry. FAILED segue a recuperação segura da SPEC-003, sem ser usado para referência simplesmente atrasada. Colisão de identidade continua 409, não código de reversão.

REFERENCE_AMOUNT_MISMATCH aplica-se exclusivamente a REFUND/ROLLBACK. Para uma reversão de crédito com amount válido cujo resultado exceda MAX, usar REJECTED/422 com MONEY_OUT_OF_RANGE, conforme SPEC-003: persistir resultado, snapshot anterior e evento de rejeição, sem saldo/versão/ledger adicional e sem consumir a reserva de reversão efetivada. A mesma regra vale ao resolver uma referência pendente.

## Cenários de aceite

| ID | Ação / condição | Resultado esperado | Evidência |
|---|---|---|---|
| REV-001 | REFUND de BET processada | Crédito integral, nova versão/ledger; BET intacta | U/I |
| REV-002 | ROLLBACK de BET/WIN/REFUND | Direção inversa correta para cada tipo | U/I |
| REV-003 | Repetir a mesma reversão pela mesma key | Resultado original, sem novo crédito/débito | I/C |
| REV-004 | Duas reversões do mesmo tipo e referência em paralelo | Uma efetivada; outra rejeitada; reserva única | C |
| REV-005 | REFUND e ROLLBACK da mesma BET em paralelo | Sob REV-D01, uma efetivada; impedir devolução dupla | C; política em revisão |
| REV-006 | Valor parcial/excedente ou contexto divergente | Código específico e nenhum efeito financeiro | U/I |
| REV-007 | REFUND/ROLLBACK antes da referência | Pendência durável; aplicação única após referência válida | I/C |
| REV-008 | Referência terminal rejeitada ou tipo proibido | Rejeição específica sem esperar o prazo | U/I |
| REV-009 | Reversão de WIN sem saldo suficiente | REVERSAL_INSUFFICIENT_FUNDS e trilha auditável | U/I |
| REV-010 | Prazo/limite atingido e referência ainda indisponível | Rejeição com evento, sem ledger | I com relógio controlado |
| REV-011 | Worker reinicia; referência já está disponível | Retomada sem perder agendamento ou duplicar efeito | I |
| REV-012 | Dois workers veem o mesmo registro elegível | Um processamento ou reagendamento válido sob lock | C |
| REV-013 | Falha SQL após reserva ou escrita parcial | Rollback da reserva, ledger, saldo, status e eventos | I |
| REV-014 | Referência chega depois de rejeição terminal | Resultado permanece rejeitado, sem reabertura | I |
| REV-015 | Auto-referência/ciclo de pendências | Nenhuma movimentação; erro imediato ou expiração definida | U/I |
| REV-016 | ROLLBACK de REFUND já efetivada | Debita o REFUND e não libera/reabre a BET original | I; REV-D01 |
| REV-017 | REFUND ou ROLLBACK de BET geraria crédito acima de MAX, inclusive após espera de referência | MONEY_OUT_OF_RANGE, REJECTED/422 e replay estável; nenhum ledger/reserva consumida; nova identidade pode tentar depois de saldo disponível | U/I/E |
| REV-018 | WIN 10.00 referencia BET processada de 25.00 no mesmo contexto | Crédito permitido; não aplicar igualdade de valor de reversão | U/I |
| REV-019 | LOSS 0.00 referencia BET processada de 25.00 no mesmo contexto | PROCESSED sem ledger nem alteração de saldo/versão | U/I |

## Revisão e conclusão

Verificar todos os tipos com Money exato, ledger antes/depois, snapshots e unicidades no PostgreSQL real. Agendamento usa relógio injetável; não esperar 24 horas nos testes. Incluir três processos no harness de concorrência, crash/reinício e injeção de falhas.

REV-D01 é uma decisão de negócio importante para revisão ao aplicar a spec. REV-D02 contém defaults operacionais ajustáveis, com testes das fronteiras. Detecção antecipada de ciclos complexos é opcional; expiração durável é obrigatória. Reversão parcial e câmbio ficam fora do escopo.

Rascunho 0.2 de 26/10/2026, revisado após análise independente para separar políticas compartilhadas de referência das regras exclusivas de reversão e cobrir overflow de crédito. Não há implementação nem evidências executadas. As recomendações não alteram silenciosamente os ADRs ou contratos já aprovados.
