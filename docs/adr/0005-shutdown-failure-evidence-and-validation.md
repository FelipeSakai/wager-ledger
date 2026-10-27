# 0005 — Deadline completo, correlação e validação reproduzível

Estado: aceita na etapa de melhorias autorizada em 27/10/2026; evidência no relatório de entrega.

## Contexto e decisão

A avaliação técnica identificou que o deadline dos workers terminava antes da limpeza
final, alguns logs técnicos não tinham correlação e havia janelas de falha sem prova
dedicada. A reprodução e a leitura do projeto também exigiam muitos passos.

ProcessShutdown mantém um timer referenciado até concluir trabalho e limpeza com sucesso. Uma limpeza que falha não cancela o deadline. Sinais
repetidos são idempotentes. Recursos posteriores são tentados mesmo após erro de
fechamento anterior; prazo esgotado encerra com código 1. O mesmo recurso é usado
na API. Não há ACK especulativo nem classificação de FAILED por timeout de shutdown.

O contexto de telemetria pertence a cada operação/entrega e recebe somente IDs
validados conforme disponíveis. Aplicação passa contexto explicitamente à UoW/retry;
consumidor passa contexto próprio ao handler e ao ACK. Não usar variável global ou
registrar payload, chaves ou receipt handles. IDs continuam fora das labels.

Acrescentar provas PostgreSQL/LocalStack com processos independentes: perda de
visibilidade apesar de heartbeat, SIGKILL antes/depois do envio tardio de DLQ e
encerramento dos entrypoints reais com limpeza travada. Fault injection existe só
no harness/preload; produção não recebe modo oculto para simular sucesso.

`bun run setup` agrega preparação sem purgar dados. Exemplos HTTP/SQS e matriz de
evidências facilitam avaliação. README/arquitetura mostram o estado atual; evidências
datadas são arquivadas separadamente. Contratos e IDs dos cenários são preservados.

Prettier 3.9.10 é fixado como dependência de desenvolvimento para legibilidade e
check de estilo. Migrations históricas ficam fora da reformatação. A CI de Ubuntu
24.04 usa Bun 1.4.4, Actions fixadas por commit, permissões de leitura e execução de
setup/checks/build/testes reais. Ela não publica nem precisa de credenciais externas.

## Alternativas e limites

Só mover clearTimeout deixaria duplicação e risco de regressão nos quatro papéis;
um helper de processo mantém uma regra pequena e testável. Interromper uma limpeza
pendente com um Promise.race sem encerrar o processo deixaria recursos vivos e
não garantiria o prazo. Matar antes de drenar admitidas aumentaria redelivery.

Mocks de PostgreSQL/SQS não comprovam disputa e recuperação; são reservados a
contratos unitários. A validação Linux local usa containers existentes de dependências
e bancos/filas descartáveis; não substitui execução hospedada ou deploy AWS.
A CI será declarada aprovada remotamente somente quando houver resultado real.
Não acrescentar auth, tracing ou carga para cumprir esta etapa.

## Complemento da reavaliação — 27/10/2026

A prova de COMMIT incerto agora intercepta a resposta real do PostgreSQL e reseta
a conexão antes de entregá-la. A transação confirmada é observada por outra conexão;
o replay recupera o mesmo resultado pelo pool original sem novo efeito/inbox/outbox.
O teste revelou mensagens de node-postgres sem SQLSTATE após tentativa de rollback
em conexão morta. Uma allowlist técnica de códigos/mensagens exatas classifica
indisponibilidade em escrita e leitura; não certifica rollback nem cria FAILED.

A reidratação financeira também compara a moeda do saldo histórico com o contexto
validado. Rejeições antecipadas por player/moeda mantêm seu significado original.
Esses ajustes reforçam contratos existentes; não alteram fronteira SQL, política
monetária, hash ou migrations. A execução local Ubuntu 24.04 AMD64 é registrada
separadamente do workflow hospedado, ainda dependente de publicação.
