# SPEC-001 — Money e contratos monetários

| Campo | Conteúdo |
|---|---|
| ID | SPEC-001 |
| Estado | Aprovada |
| Revisão | 1.0 |
| Requisitos relacionados | F04, F05, F06, F07, F08; suporte a D02, D03 e D07 |
| Dependências de definição | Arquitetura e ADR 0001 |
| Dependências de implementação | Decimal.js selecionada; versão e instalação pendentes da etapa de implementação |
| Aprovação do conteúdo | Aprovado pelo responsável pelo projeto em 26/10/2026 |
| Implementação | Não iniciada |

Este documento define o contrato aprovado do objeto de valor monetário do núcleo financeiro, conforme a [arquitetura](../../ARCHITECTURE.md) e o [ADR 0001](../adr/0001-financial-core.md). A aprovação encerra as decisões funcionais desta spec; implementação e evidências de execução continuam pendentes.

## Objetivo

Representar valor e moeda com aritmética decimal exata, evitando perda de centavos, conversões para ponto flutuante e operações entre moedas incompatíveis. O mesmo objeto de valor será utilizado por carteiras, transações, ledger e reconciliação.

## Escopo e exclusões

Inclui criação, zero, valores internos com sinal, operações, comparações, imutabilidade e serialização. Define expectativas de mapeamento monetário, sem implementar persistência.

Não inclui câmbio, taxas, juros, multiplicação, divisão, rateio, arredondamento comercial ou busca de cotações. Entrada e visualização convertidas também estão fora da primeira versão da aplicação, conforme o [ADR 0003](../adr/0003-scope-and-evidence.md). Esta spec não decide se uma BET, WIN ou LOSS pode ter valor zero: essa é uma regra de operação, a ser definida nas specs seguintes. `Money` precisa representar zero para abertura, comparação e reconciliação.

Saldo negativo é proibido na Wallet; resultado negativo no objeto `Money` é necessário para diferenças e cálculos internos. Essas responsabilidades são distintas.

## Regras já estabelecidas

| ID | Regra |
|---|---|
| MNY-R01 | Valor monetário nunca usa `number`, `float` ou `double`, inclusive em argumentos de construção e conversões intermediárias |
| MNY-R02 | Cada instância contém valor decimal exato e moeda explícita |
| MNY-R03 | Operações não alteram os operandos; campos internos não podem ser modificados por consumidores |
| MNY-R04 | Contratos de entrada/saída monetários usam strings com escala de duas casas; não arredondar silenciosamente |
| MNY-R05 | Entradas externas negativas, vazias, não finitas, exponenciais ou com mais de duas casas são rejeitadas |
| MNY-R06 | Operações que envolvem dois valores exigem moedas iguais; conversão cambial não é implícita |
| MNY-R07 | Domínio não importa NestJS, MikroORM, SDK AWS, HTTP nem tipos monetários do ORM |
| MNY-R08 | Construtor é privado; factories explicitam criação e reconstrução de estado |
| MNY-R09 | Entrada monetária exige string com exatamente duas casas, como `"25.00"`; números e formas `"25"`/`"25.0"` são rejeitados, sem normalização silenciosa |
| MNY-R10 | O domínio representa moedas distintas, incluindo BRL e USD para testes; operações entre moedas diferentes geram erro. A aplicação usa somente BRL nas entradas, saldos, transações, ledger e apresentação de valores da primeira versão |
| MNY-R11 | Usar Decimal.js com configuração exclusiva de 40 dígitos significativos de trabalho; preservar aritmética exata no conjunto de operações suportado |
| MNY-R12 | Alinhar o intervalo de Money à futura persistência NUMERIC(20, 2), com 18 dígitos inteiros e dois decimais; exceder o limite gera erro, sem arredondamento |
| MNY-R13 | O catálogo de representação contém somente BRL e USD, com códigos exatos em maiúsculas e sem consulta externa |
| MNY-R14 | Rejeitar espaços, sinal positivo, zeros excedentes à esquerda, ausência de parte inteira e formato regional |
| MNY-R15 | rehydrate valida integridade e admite negativos internos; from continua rejeitando negativos externos |
| MNY-R16 | Operações binárias, inclusive equals, rejeitam moedas diferentes com CURRENCY_MISMATCH |

## Contrato de entrada

O formato monetário abaixo define o contrato alvo. A declaração descreve a implementação futura; não é uma interface já existente no código:

```ts
interface MoneyProps {
  amount: string;
  currency: string;
}
```

```json
{ "amount": "25.00", "currency": "BRL" }
```

### Formato aprovado para amount — Q-MNY-01

Receber e serializar valores como strings decimais com exatamente duas casas. Rejeitar `"25"`, `"25.0"` e valores numéricos em vez de completar casas ou converter tipos automaticamente. A entrada externa continua não negativa, conforme as regras já estabelecidas.

Rejeitar espaços, sinal positivo, zeros excedentes à esquerda, ausência de parte inteira e formato regional. Não corrigir o texto nem completar casas automaticamente. A decisão lexical está registrada em Q-MNY-08.

Gramática: `^(0|[1-9][0-9]*)\.[0-9]{2}$`. Aplicar também o limite de magnitude antes de entregar a string à biblioteca decimal. Uma entrada externa válida tem no máximo 21 caracteres: 18 dígitos inteiros, ponto e duas casas. A implementação deve limitar o texto antes do parser decimal, sem encaminhar entradas arbitrariamente longas para a biblioteca.

| Entrada | Resultado | Situação |
|---|---|---|
| `"0.00"`, `"25.00"`, `"0.01"` | Aceitar, respeitando moeda e intervalo | Formato aprovado |
| `25`, `25.00`, `null` ou campo ausente | Rejeitar: não é string monetária válida | Regra estabelecida e aprovação de formato |
| `"25"`, `"25.0"` | Rejeitar: escala diferente de duas casas | Aprovado em Q-MNY-01 |
| `".50"` | Rejeitar ausência de parte inteira | Aprovado em Q-MNY-08 |
| `"01.00"`, `"+1.00"`, `" 1.00"`, `"1.00 "` | Rejeitar sem corrigir texto | Aprovado em Q-MNY-08 |
| `"-1.00"`, `"-0.00"` | Rejeitar na entrada externa | Regra já estabelecida: sinal negativo externo inválido |
| `"1.001"`, `"1e2"`, `"NaN"`, `"Infinity"`, `""` | Rejeitar | Regra já estabelecida: escala inválida ou conteúdo não admitido |
| `"1,00"`, `"1,000.00"`, `"R$ 1.00"` | Rejeitar formato regional | Aprovado em Q-MNY-08 |

Aceitar `"25"` ou `"25.0"` e normalizar para `"25.00"` foi descartado. O formato fixo mantém o contrato previsível e evita representações alternativas de escala no futuro cálculo de idempotência.

### Moedas no domínio e na aplicação — Q-MNY-02

Money representa BRL e USD, com testes de conflito entre elas. Toda operação binária exige moedas iguais, incluindo `equals`, conforme Q-MNY-05.

Aprovado: a aplicação usa somente BRL nas entradas, saldos, transações, ledger e apresentação de valores da primeira versão. A restrição comercial pertence à aplicação, não ao objeto Money. Rejeitar USD na entrada da aplicação não autoriza remover sua representação no domínio ou os testes de conflito.

Não haverá preferência de visualização em USD, entrada estrangeira convertida para BRL, conversão entre carteiras ou consulta a uma API de cotações nesta versão. Uma evolução desse escopo exige spec própria; não é condição para concluir Money ou as funcionalidades financeiras planejadas.

O catálogo é um subconjunto explícito dos códigos ISO, contendo somente `BRL` e `USD`. Será mantido localmente e versionado no Git, sem dependência de API de moedas, cotação ou catálogo externo em runtime. Validar pertencimento à lista, sem converter caixa ou remover espaços. `brl`, ` BRL` e qualquer código fora da lista geram INVALID_CURRENCY, ainda que outro código seja válido em um catálogo mundial.

Atualizações do catálogo exigem alteração revisada do código e da spec, com testes correspondentes e aprovação da etapa. A validade de um código no domínio não habilita sua operação comercial na aplicação.

Nesta fase, a escala do produto é sempre duas casas: não há suporte geral a moedas com escalas diferentes. As specs de aplicação detalharão o erro para moeda não habilitada e testarão a rejeição de USD em HTTP/SQS, preservando os testes multimoeda do domínio.

### Precisão, magnitude e biblioteca aprovadas — Q-MNY-03

Usar Decimal.js para a representação e a aritmética do domínio. Instanciar um construtor exclusivo por `Decimal.clone({ precision: 40 })`, mantido encapsulado pela implementação de Money, sem alterar ou depender da configuração global da biblioteca. O número 40 configura dígitos significativos de trabalho, não casas decimais do contrato nem valor monetário.

Alinhar o intervalo do objeto de valor à futura persistência `NUMERIC(20, 2)`: 20 dígitos totais, dos quais dois são decimais. Isso permite até 18 dígitos na parte inteira. O limite positivo é:

```text
MAX = 999999999999999999.99
```

A entrada externa admite de zero a MAX. A magnitude interna tem intervalo simétrico de -MAX a MAX, conforme Q-MNY-04. A Wallet permanece não negativa. Este limite define capacidade de representação, não limites comerciais de saldo ou aposta.

Validar tipo, formato e magnitude de entrada, executar a operação decimal e verificar o intervalo do resultado. Qualquer resultado fora da faixa deve produzir erro explícito, sem truncar, arredondar, saturar ou alterar operandos. A soma/subtração de dois operandos com até 20 dígitos totais e escala dois pode exigir até 21 dígitos no resultado intermediário; a precisão de trabalho 40 preserva esse cálculo antes de detectar overflow. A garantia vale para soma, subtração e inversão no escopo atual; não autoriza operações novas sem revisar precisão e arredondamento.

Armazenar diretamente o decimal monetário, por exemplo `125.75`, e moeda separada; não converter para centavos inteiros como formato de persistência desta solução. O mapper deve preservar strings/decimais em ambos os sentidos. A validação de escala ocorre antes do banco, sem depender de coerção automática de NUMERIC para rejeitar excesso de casas.

A versão da dependência será selecionada e fixada na etapa de implementação autorizada. Não há instalação ou migration nesta decisão documental. Agregações de reconciliação que possam exceder o intervalo intermediário precisarão de estratégia própria na SPEC-007, sem arredondamento nem perda de cancelamentos; precisão de trabalho 40 não é garantia para somatórios sem limite de tamanho.

Referências técnicas: [Decimal.js — configuração isolada](https://mikemcl.github.io/decimal.js/#clone), [Decimal.js — precisão](https://mikemcl.github.io/decimal.js/#precision) e [PostgreSQL — NUMERIC](https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-NUMERIC-DECIMAL).

## Contrato de domínio

```ts
declare class Money {
  private constructor();

  static from(props: MoneyProps): Money;
  static zero(currency: string): Money;
  static rehydrate(props: MoneyProps): Money;

  add(other: Money): Money;
  subtract(other: Money): Money;
  negate(): Money;

  isZero(): boolean;
  isPositive(): boolean;
  isNegative(): boolean;
  isLessThan(other: Money): boolean;
  equals(other: Money): boolean;

  toJSON(): MoneyProps;
  toString(): string;
}
```

Esta declaração descreve a API pública alvo, sem expor o estado privado da implementação, e ainda não foi adicionada ao código. O tipo decimal fica encapsulado e não pode ser retornado por getters mutáveis.

### Factories e valores com sinal — Q-MNY-04

- `from`: entrada externa não negativa, sujeita às políticas de formato, moeda e magnitude; inclusive `"-0.00"` é rejeitado.
- `zero`: cria valor zero na moeda fornecida, validando a moeda.
- `rehydrate`: restaura representação persistida exata, aceitando a gramática externa ou sua forma com sinal negativo inicial. Não reaplica regras de negócio de Wallet ou transação. Valida tipo, formato, escala, magnitude e moeda; dados corruptos geram INVALID_PERSISTED_MONEY. Zero negativo persistido é normalizado para `"0.00"`, como todo zero interno.
- `subtract` e `negate`: podem produzir negativos internos. Zero interno sempre normaliza para `"0.00"`, incluindo a negação de zero.

`rehydrate` não pode ser usada pelo adaptador de entrada para contornar a proibição de negativos externos. A reconstrução não fornece um caminho para restaurar uma Wallet negativa: isso continua sob responsabilidade do agregado e das garantias do banco.

`toJSON` pode emitir um valor negativo interno para representar uma diferença de reconciliação. Esse contrato de saída não torna uma requisição negativa válida.

## Semântica das operações

| Operação | Resultado |
|---|---|
| `add` | Novo Money com soma exata e mesma moeda |
| `subtract` | Novo Money com diferença exata; pode ser negativo |
| `negate` | Novo Money com sinal inverso; zero permanece zero |
| `isZero` | Verdadeiro somente para valor zero |
| `isPositive` / `isNegative` | Zero é falso em ambas; considerar negativos internos |
| `isLessThan` | Compara valores na mesma moeda |
| `equals` | Compara valor exato na mesma moeda |
| `toJSON` | Novo objeto de dados, com amount fixo em duas casas e currency |
| `toString` | amount, espaço e código da moeda, por exemplo `"25.00 BRL"`, sem formatação regional |

Toda operação binária, incluindo `equals`, lança CURRENCY_MISMATCH quando as moedas diferirem. Não retornar apenas `false` nesse caso: a diferença de moeda é uma combinação inválida de operandos. A comparação entre valores da mesma moeda retorna boolean normalmente.

## Contrato de erros — Q-MNY-06

| Código | Condição |
|---|---|
| `INVALID_MONEY_AMOUNT` | Tipo, gramática, escala ou sinal externos inválidos |
| `INVALID_CURRENCY` | Formato ou código fora do catálogo de representação |
| `CURRENCY_MISMATCH` | Operação binária com moedas diferentes |
| `MONEY_OUT_OF_RANGE` | Entrada ou resultado fora do intervalo suportado |
| `INVALID_PERSISTED_MONEY` | Representação persistida inconsistente ao reidratar |

Os códigos são estáveis e fazem parte do contrato. Os erros devem trazer o código e uma mensagem legível, sem depender do texto da biblioteca decimal. Erro de tipo/formato externo usa INVALID_MONEY_AMOUNT; magnitude externa ou resultado aritmético fora da faixa usa MONEY_OUT_OF_RANGE. Qualquer falha de integridade em rehydrate usa INVALID_PERSISTED_MONEY, inclusive moeda inválida ou magnitude excedida.

O nome das classes de erro é detalhe de implementação; o mapeamento HTTP pertence às specs de aplicação. Não há erro de saldo insuficiente em Money: um valor válido pode superar o saldo da Wallet, e a rejeição pertence ao agregado/caso de uso.

## Persistência, concorrência e efeitos

Money não faz I/O, não controla transações, não adquire locks, não produz mensagens e não decide ACK/retry. Duas chamadas podem compartilhar uma instância imutável sem depender de mutex. O processamento financeiro concorrente continua sujeito ao desenho transacional das specs seguintes.

O mapper futuro deverá preservar decimal e moeda sem passar por `Number`, `parseFloat` ou APIs equivalentes. A migration deverá proteger escala/intervalo e não-negatividade onde o tipo de registro exigir. Não confiar em coerção/arredondamento automático do banco para validar entrada externa com excesso de casas.

Round-trip real com MikroORM/PostgreSQL pertence à etapa de persistência. A verificação unitária desta spec não comprova esse round-trip, nem saldo/ledger consistentes.

## Cenários de aceite

Os cenários são critérios de aceite aprovados do contrato alvo. A coluna de rastreabilidade aponta as decisões correspondentes; os testes ainda não foram implementados ou executados.

| ID | Dado / quando | Então | Rastreabilidade |
|---|---|---|---|
| MNY-001 | Construir `"25.00"` em BRL | Representar exatamente 25.00; JSON preserva valor e moeda | Nenhuma |
| MNY-002 | Somar `"0.10"` e `"0.20"` em BRL | Resultado `"0.30"`, sem resíduo decimal | Nenhuma |
| MNY-003 | Subtrair `"0.20"` de `"0.10"` em BRL | Resultado interno `"-0.10"`; negativo verdadeiro | Q-MNY-04 |
| MNY-004 | Somar `"9007199254740993.01"` e `"0.09"` em BRL | Resultado `"9007199254740993.10"`, sem perda de centavos | Precisão aprovada em Q-MNY-03 |
| MNY-005 | Usar cada entrada inválida da tabela de amount | Rejeitar explicitamente com INVALID_MONEY_AMOUNT, sem criar valor parcialmente válido | Q-MNY-01, Q-MNY-06, Q-MNY-08 |
| MNY-006 | Criar zero e negar zero em BRL | JSON `"0.00"`; isZero true; isPositive/isNegative false | Q-MNY-04 |
| MNY-007 | Comparar `"1.00"` com `"2.00"` e com outro `"1.00"` em BRL | Ordenação e igualdade coerentes; comparação consigo é verdadeira | Nenhuma |
| MNY-008 | Somar, subtrair ou ordenar BRL e USD | CURRENCY_MISMATCH; operandos preservados | Q-MNY-02, Q-MNY-06 |
| MNY-009 | Chamar equals entre BRL e USD | CURRENCY_MISMATCH em vez de false | Q-MNY-02, Q-MNY-05, Q-MNY-06 |
| MNY-010 | Executar add/subtract/negate e alterar o objeto devolvido por toJSON | Nenhum Money original muda; resultados aritméticos são novas instâncias | Nenhuma |
| MNY-011 | Reconstruir `"25.00"` e `"-0.10"` persistidos em BRL | Preservar valor e moeda; from continua rejeitando `"-0.10"` | Q-MNY-04 |
| MNY-012 | Reidratar dado monetário corrupto, incluindo escala, moeda ou magnitude inválidas | INVALID_PERSISTED_MONEY, sem criar objeto utilizável | Q-MNY-04, Q-MNY-06 |
| MNY-013 | Construir `"999999999999999999.99"` e somar `"0.00"` na mesma moeda | Preservar exatamente o limite superior | Aprovada em Q-MNY-03 |
| MNY-014 | Somar `"0.01"` a MAX ou subtrair `"0.01"` de -MAX | MONEY_OUT_OF_RANGE, sem arredondamento ou alteração dos operandos | Q-MNY-03, Q-MNY-04, Q-MNY-06 |
| MNY-015 | Informar brl, moeda com espaços ou código ausente do catálogo | INVALID_CURRENCY, sem correção silenciosa | Q-MNY-02, Q-MNY-06 |
| MNY-016 | Serializar positivo, negativo interno e zero | JSON com duas casas; toString usa amount, espaço e código da moeda | Q-MNY-04, Q-MNY-07 |
| MNY-017 | Obter JSON e reconstruir um valor externo não negativo válido | Valor/moeda equivalentes, objetos independentes | Formato aprovado em Q-MNY-01; moeda e magnitude conforme políticas correspondentes |
| MNY-018 | Negar duas vezes um valor ou somar seu inverso | Recuperar valor original ou zero exato, respectivamente | Q-MNY-03, Q-MNY-04 |
| MNY-019 | Tentar construir `"1000000000000000000.00"` | MONEY_OUT_OF_RANGE por exceder o limite de 18 dígitos inteiros | Q-MNY-03, Q-MNY-06 |
| MNY-020 | Alterar a configuração global de Decimal.js e repetir os cálculos de Money | A configuração exclusiva mantém precisão e resultados de Money | Aprovada em Q-MNY-03 |
| MNY-021 | Construir valores válidos em BRL e USD separadamente | Ambas as moedas são representáveis no domínio; isso não habilita USD na aplicação | Q-MNY-02 |
| MNY-022 | Usar `"-0.00"` em from e em rehydrate | from rejeita com INVALID_MONEY_AMOUNT; rehydrate restaura zero e serializa `"0.00"` | Q-MNY-04, Q-MNY-06 |

## Estratégia de testes e conclusão

Testes unitários com Bun, próximos ao domínio, sem inicializar NestJS, banco ou broker. Os testes deverão usar strings para todos os valores monetários, inclusive resultados esperados. As tabelas de entradas inválidas devem ser exercitadas caso a caso.

Além dos exemplos, testar limites superior/inferior, zero, imutabilidade e invariantes algébricas dentro do intervalo suportado. Validar que Decimal.js com precisão de trabalho 40 não arredonda os casos de fronteira e que a configuração global não afeta o construtor exclusivo de Money. Um check de imports deve impedir dependências de framework/ORM no domínio quando o mecanismo de verificação arquitetural for implementado.

Ainda não há arquivo `Money`, biblioteca decimal instalada nem script de testes. Não há resultados executados para esta spec. Nenhum comando novo é introduzido por esta etapa documental.

Para marcar a spec como `Verificada` após implementação autorizada:

1. Partir desta revisão aprovada e obter autorização para a etapa de implementação.
2. Implementar as regras, os cenários aplicáveis e os testes unitários.
3. Executar os checks pertinentes do projeto e os testes, registrando comandos, versão e resultado reais.
4. Relacionar F04–F08 aos caminhos e evidências correspondentes, sem marcar garantias de persistência ou Wallet como atendidas por testes de Money.

## Decisões aprovadas

| ID | Questão | Decisão | Impacto | Situação |
|---|---|---|---|---|
| Q-MNY-01 | Tipo e escala monetários | String com exatamente duas casas; rejeitar números, `"25"` e `"25.0"`, sem normalizar | Validação, compatibilidade e futuro hash | Aprovada em 26/10/2026 |
| Q-MNY-02 | Moedas representáveis, habilitação e catálogo | Subconjunto local dos códigos ISO BRL/USD, em maiúsculas, versionado no Git e atualizado por alteração revisada; aplicação somente BRL, incluindo entrada e apresentação, sem câmbio | Validação do domínio e fronteira da aplicação | Aprovada em 26/10/2026 |
| Q-MNY-03 | Precisão e biblioteca | Decimal.js com construtor exclusivo de precisão 40; NUMERIC(20, 2), com limite positivo 999999999999999999.99; overflow explícito | Magnitude, aritmética, mapper e migration futura; versão a fixar na implementação | Aprovada em 26/10/2026 |
| Q-MNY-04 | Reconstrução e valores internos com sinal | rehydrate valida integridade e aceita negativos internos; from só não negativos; zero interno sempre normalizado | API de domínio, reconciliação e mappers | Aprovada em 26/10/2026 |
| Q-MNY-05 | Igualdade entre moedas distintas | Lançar CURRENCY_MISMATCH também em equals | Semântica de comparação | Aprovada em 26/10/2026 |
| Q-MNY-06 | Taxonomia de erros | Os cinco códigos definidos no contrato de erros, incluindo erro próprio de integridade persistida | Contratos e diagnóstico | Aprovada em 26/10/2026 |
| Q-MNY-07 | Formato de toString | amount + espaço + currency, sem locale | Debug e usos internos | Aprovada em 26/10/2026 |
| Q-MNY-08 | Regras lexicais adicionais de amount | Rejeitar espaços, sinal positivo, zeros excedentes à esquerda, ausência de parte inteira e formato regional | Gramática de entrada e representação canônica | Aprovada em 26/10/2026 |

## Dependências futuras e limites da aprovação

Não há decisões funcionais pendentes nesta spec. A versão exata de Decimal.js será verificada e fixada na etapa de implementação autorizada, sem mudar o contrato aprovado. O nome de classes auxiliares e a organização interna dos arquivos são detalhes dessa implementação.

A permissão de valores zero por tipo de transação será definida na SPEC-002/SPEC-003. Enforcement no PostgreSQL, round-trip do mapper, mapeamento HTTP e acumulação da reconciliação pertencem às respectivas specs. Esses itens não bloqueiam a aprovação do contrato de Money, mas continuam necessários para as funcionalidades responsáveis.

## Registro de revisão e aprovação

| Revisão | Data | Alteração | Estado |
|---|---|---|---|
| 0.1 | 26/10/2026 | Rascunho inicial para discussão de contratos e cenários | Rascunho |
| 0.2 | 26/10/2026 | Aprovação parcial: strings com duas casas, domínio multimoeda e aplicação inicialmente BRL; detalhes restantes separados das definições aceitas | Rascunho |
| 0.3 | 26/10/2026 | Aprovação de Decimal.js, precisão de trabalho 40 e intervalo alinhado a NUMERIC(20, 2); inclusão dos cenários de overflow e isolamento de configuração | Rascunho |
| 0.4 | 26/10/2026 | Confirmação de aplicação exclusivamente BRL, incluindo entrada e apresentação; câmbio e API de cotações fora da primeira versão, preservando domínio multimoeda | Rascunho |
| 1.0 | 26/10/2026 | Aprovação integral do contrato: catálogo local, validação lexical, reconstrução, valores internos com sinal, comparação, serialização e códigos de erro | Aprovada |

Aprovação do conteúdo: concedida pelo responsável pelo projeto em 26/10/2026, abrangendo Q-MNY-01 a Q-MNY-08 e os critérios desta revisão. Implementação, instalação de biblioteca, commit e publicação dependem de autorização da etapa correspondente. Evidências de execução: ainda não existem.
