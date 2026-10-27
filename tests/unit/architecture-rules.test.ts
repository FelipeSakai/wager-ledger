import { expect, test } from 'bun:test';
import { inspectArchitecture } from '../../scripts/architecture-rules';

const domain = 'src/modules/financial/domain/money/money.ts';
const application = 'src/modules/financial/application/use-cases/open-wallet.ts';
const infrastructure = 'src/modules/financial/infrastructure/persistence/records.ts';
const presentation = 'src/modules/financial/presentation/http/controller.ts';
const platform = 'src/platform/database/orm.ts';

test('architecture permits inward dependencies and isolates technical packages in adapters', () => {
  const sources = new Map([
    [domain, "import Decimal from 'decimal.js';"],
    [application, "import type { Money } from '../../domain/money/money';"],
    [
      infrastructure,
      "import { EntitySchema } from '@mikro-orm/core'; import type { Money } from '../../domain/money/money';",
    ],
    [presentation, "import { OpenWallet } from '../../application/use-cases/open-wallet';"],
    [platform, "import { MikroORM } from '@mikro-orm/postgresql';"],
  ]);
  expect(inspectArchitecture(sources)).toEqual([]);
});
test.each([
  [domain, "import { Injectable } from '@nestjs/common';"],
  [application, "import { EntitySchema } from '@mikro-orm/core';"],
  [platform, "import type { Money } from '../../modules/financial/domain/money/money';"],
  [presentation, "import type { Record } from '../../infrastructure/persistence/records';"],
])('architecture rejects inverted dependency in %s', (file, source) => {
  const sources = new Map([
    [domain, ''],
    [infrastructure, ''],
    [file, source],
  ]);
  expect(inspectArchitecture(sources).some((issue) => issue.rule === 'dependency')).toBe(true);
});
test('architecture rejects a type-only cycle as well as a runtime cycle', () => {
  const issues = inspectArchitecture(
    new Map([
      [domain, "import type { B } from './other';"],
      ['src/modules/financial/domain/money/other.ts', "export { A } from './money';"],
    ]),
  );
  expect(issues.some((issue) => issue.rule === 'cycle')).toBe(true);
});
test('architecture rejects missing modules and dynamic paths that evade inspection', () => {
  const issues = inspectArchitecture(
    new Map([[application, "import { X } from './missing'; const y = import(variable);"]]),
  );
  expect(issues.filter((issue) => issue.rule === 'resolution')).toHaveLength(2);
});
test('architecture detects HTTP status in a pure result even with no framework import', () => {
  const issues = inspectArchitecture(
    new Map([[domain, 'export interface Result { httpStatus: number }']]),
  );
  expect(issues.some((issue) => issue.rule === 'transport')).toBe(true);
});
test('architecture keeps port contracts independent of use-case implementations', () => {
  const issues = inspectArchitecture(
    new Map([
      [application, 'export class OpenWallet {}'],
      [
        'src/modules/financial/application/ports/wallet.ts',
        "import type { OpenWallet } from '../use-cases/open-wallet';",
      ],
    ]),
  );
  expect(issues.some((issue) => issue.rule === 'dependency')).toBe(true);
});
