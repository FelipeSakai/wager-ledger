# Validação da entrega — 27/10/2026

## Revisão atual

As melhorias da avaliação técnica estão implementadas e organizadas em commits locais:

- integridade da moeda do saldo histórico e erro seguro em consultas/replay;
- queda TCP real após COMMIT, recuperando efeito único e inbox pelo mesmo pool;
- classificação de indisponibilidade quando o driver perde o código da desconexão;
- deadline completo, inclusive limpeza que trava ou falha com recurso aberto;
- redelivery simultâneo após falha de heartbeat e crash antes/depois da DLQ tardia;
- contexto próprio por operação/entrega para correlacionar retry, lock, transição e ACK;
- CI Linux, Prettier fixado, setup único e exemplos HTTP/SQS;
- README/arquitetura atuais, matriz de evidências e histórico separado.

A implementação parte da base Git 44710c3 e foi organizada em commits por assunto,
com autoria e committer FelipeSakai (felipesakaiipolito@gmail.com). Para consultar a
sequência: `git log --reverse --oneline 44710c3..HEAD`. Nenhum push ou resultado
hospedado de GitHub Actions foi produzido nesta etapa. Decisões no [ADR 0005](adr/0005-shutdown-failure-evidence-and-validation.md).

## Checks e resultados

| Verificação | Evidência |
|---|---|
| Instalação congelada | Bun 1.4.4/bun.lock; Prettier 3.9.10 apenas em desenvolvimento |
| Setup único | Executado; preservou .env/segredo e volumes; migrations/filas prontas |
| Formatação | Prettier aprovado; migrations históricas excluídas da reformatação |
| Arquitetura/typecheck/build | Aprovados; 85 arquivos de produção sem dependências invertidas/ciclos |
| Suíte macOS arm64 | 639 aprovados, 0 falhas, 2.452 asserções; 25 arquivos; 49,43 s |
| Suíte Ubuntu 24.04 AMD64 limpa | 639 aprovados, 0 falhas, 2.452 asserções; 25 arquivos; 99,96 s |
| Smoke final | API e três workers reiniciados no build validado; live/ready/metrics 200 em 3001/3101/3102/3103 |
| Distribuição | 443 unitários + 196 integrações PostgreSQL/LocalStack/processos |

A suíte macOS foi reexecutada durante a organização dos commits, com o resultado
acima e sem mudança de código. O ensaio Ubuntu registra a validação anterior da mesma implementação.

A mesma implementação final passou em macOS arm64 e Ubuntu 24.04 AMD64. A instalação Linux foi criada
sem reaproveitar .env, node_modules, dist ou metadados Git da cópia de desenvolvimento.

O ensaio Linux usa Ubuntu 24.04 AMD64 e binário oficial Bun 1.4.4 fixados por digest, cópia dos fontes sem
.env/node_modules/dist/.git e instalação pelo lockfile. PostgreSQL 17.11 e LocalStack
4.0.3 existentes foram reutilizados via rede Docker, com bancos/filas UUID próprios.
A aplicação AMD64 executa por emulação no host arm64; as dependências PostgreSQL e
LocalStack continuam nos containers existentes. Não se declara instalação Docker
em máquina nova nem execução do runner GitHub hospedado.

Bases do ensaio local:

- Ubuntu: `sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c`.
- Bun: `sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`, plataforma linux/amd64.
- Binário copiado da imagem oficial para Ubuntu com ca-certificates/libstdc++6.
- uname confirmou Linux x86_64; os-release confirmou Ubuntu 24.04.5 LTS.

## Cobertura acrescentada

- PROC-017 observa CommandComplete/COMMIT do PostgreSQL real e reseta TCP antes
  de entregar a resposta ao cliente. Outra conexão confirma a transação durável;
  a chamada recebe INFRASTRUCTURE_UNAVAILABLE e repete pela mesma identidade,
  em contexto novo no mesmo pool. Com/sem inbox: um débito, eventos/inbox sem
  duplicação, snapshot 75.00 mesmo depois de WIN levar saldo atual a 85.00.
  Esse teste exercita banco e caso de uso; as provas de ACK/SQS são as suítes
  próprias existentes, não uma alegação de entrega real SQS dentro do proxy.
- PROC-020 corrompe apenas a moeda do resultado em três estados, em banco UUID.
  GET interno/externo e replay retornam 500 seguro, sem alterar história/ledger.
  O domínio cobre também FAILED e preserva rejeições antecipadas de contexto.
- O teste de COMMIT revelou o erro sem código de node-postgres no rollback de
  conexão morta. A classificação compartilhada de leitura/escrita reconhece
  mensagens exatas; não converte erros desconhecidos em rejeição ou FAILED.

- Os três entrypoints de worker são executados de verdade. Preload exclusivo do
  harness informa início da limpeza e injeta travamento/erro; não há flags de teste
  interpretadas por produção. Saída normal é 0; deadline excedido é 1, sem prorrogar
  por SIGTERM repetido. A prova não depende de matar pelo timeout externo do teste.
- SQS-017 observa o mesmo transportMessageId em dois PIDs, receipts diferentes e
  dois backends simultaneamente esperando o lock. Resultado: uma inbox e um débito,
  com saldo final 75.00 reconciliado.
- SQS-025 confirma FAILED com origem já ACKada, mata dispatcher em barreira antes
  ou depois do envio real, espera lease expirar e retoma em outro processo. Conserva
  corpo/task/transferId e reconciliação. Não afirma exatamente uma entrega à DLQ.
- Observabilidade verifica correlação em lock/retry reais e em dois grupos SQS até
  transição e ACK, sem misturar contextos. IDs permanecem fora das labels.

Migrations, política monetária, identidade/hash e fronteira transacional não mudaram.
Prettier só altera apresentação do código e fica fora do runtime de produção.
O [mapa de evidências](evidence.md) relaciona os critérios aos testes.

## CI e limites

O [workflow](../.github/workflows/ci.yml) usa Ubuntu 24.04, Actions fixadas por SHA,
Bun fixado, permissões de leitura, setup, estilo, arquitetura/typecheck, build e
suite real. Logs de dependências aparecem em falha; o encerramento preserva volumes.
Seu resultado remoto só pode ser confirmado após publicação/execução.

Sem IdP, deploy AWS, tracing/dashboard, benchmark ou consumidor de eventos de produção.
FAILED automático continua restrito a INVALID_REFERENCE_STATE após recuperação segura.
O conjunto de provas não cobre todos os interleavings possíveis de falhas distribuídas.

Ensaios anteriores foram preservados no [histórico](history/delivery-stages.md).
