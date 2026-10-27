# 0003 — Escopo incremental, autenticação e critérios de entrega

Estado: aceita em 26/10/2026; implementação pendente.

## Contexto

Correção financeira, concorrência, idempotência e recuperação de falhas são as prioridades do núcleo financeiro. A integração de autenticação externa será tratada em uma etapa própria, antes da exposição pública em produção. O desenvolvimento será incremental, com aprovação do responsável e registro das decisões que afetam a operação e a manutenção do sistema.

## Decisão

Priorizar garantias obrigatórias e sua comprovação. Adiar integração com IdP externo, mantendo `ProviderIdentityPort` como ponto de extensão explícito quando a apresentação HTTP for implementada. Não criar usuários/senhas locais. Validar provider no domínio mesmo para mensagens internas. Health permanece aberto.

Definição de escopo monetário confirmada em 26/10/2026: usar BRL nas entradas, saldos, transações, ledger e apresentação de valores da primeira versão. Money permanece multimoeda, com testes de conflito BRL/USD. Conversão cambial, entrada em moeda estrangeira com débito convertido, visualização em moeda alternativa e integração com API de cotações ficam para uma evolução futura, sem compromisso de implementação nesta entrega.

Documentação em português; código, contratos, eventos e failure codes em inglês. `AGENTS.md` concentra regras práticas e referências; `ARCHITECTURE.md` explica o sistema; requisitos mapeiam evidências; roteiro de demo descreve cenários reproduzíveis. Não marcar recurso como concluído com base só no desenho.

Cada etapa terá escopo apresentado e aprovado antes de alterações. Publicação/commit deve estar autorizada no escopo correspondente. A aprovação da documentação não autoriza implementar banco, domínio ou workers.

Orientação de planejamento atualizada em 26/10/2026: o responsável autorizou redigir as specs restantes sem solicitar aprovação por arquivo ou escolha de rotina. Defaults recomendados e decisões materiais ficam documentados para revisão ao aplicar; itens muito opcionais são destacados. SPEC-001/002 permanecem aprovadas, e os novos rascunhos não são promovidos automaticamente a contratos aprovados. Código, dependências e publicação seguem sujeitos à autorização da etapa correspondente.

Testes usam Bun. Integração e concorrência usam serviços reais em containers e processos independentes. Mocks podem isolar testes unitários, mas não substituir PostgreSQL/SQS nos cenários que avaliam suas garantias.

## Alternativas consideradas

- Integrar Keycloak/Zitadel desde o começo: adiciona operação e configuração antes de validar as garantias de consistência que sustentam o núcleo financeiro.
- Adicionar dashboards, tracing e teste de carga primeiro: são extensões úteis após o mínimo obrigatório, mas não substituem testes de correção.
- Documentar apenas ao final: favorece desvio entre requisitos, decisões e implementação e dificulta discussão das etapas.
- Exibir e aceitar valores estrangeiros convertidos para uma carteira BRL: demanda políticas de cotação, validade, arredondamento, confirmação e auditoria. Fica adiado para manter o foco nas garantias do processamento financeiro.
- Manter saldos reais em várias moedas: exigiria habilitação de moedas na aplicação e, para conversão entre saldos, um fluxo financeiro adicional. A primeira versão não precisa dessa capacidade operacional.

## Consequências e limitações

Sem IdP não é possível garantir a identidade do chamador HTTP. A solução não deve ser exposta como serviço de produção. O ponto de extensão é projeto futuro, ainda não existe no bootstrap. Integração OIDC, autorização e vínculo de claims ao provider exigirão uma etapa própria.

Documentos devem ser atualizados junto ao comportamento, sem alegações de performance, cobertura ou segurança sem evidência. O roteiro só vira demonstração executável depois de existirem scripts e dados correspondentes.

A aplicação não depende de provedores de câmbio para processar ou apresentar valores. O usuário opera em BRL; representação de USD no domínio serve aos testes de conflito e não oferece saldo, entrada ou exibição em USD. Qualquer evolução cambial exige spec própria e revisão explícita das fronteiras e contratos.

## Como validar

Conferir rastreabilidade de cada requisito, comandos documentados realmente existentes e limitações explícitas. Ensaiar a demonstração a partir de ambiente limpo, registrando versões, comandos, resultados e evidências. Revisar que a autenticação adiada não desliga as validações de domínio.
