import { posix } from 'node:path';
import ts from 'typescript';

export interface ArchitectureIssue {
  file: string;
  line: number;
  rule: 'dependency' | 'resolution' | 'cycle' | 'transport';
  message: string;
}

type Layer =
  'domain' | 'application' | 'infrastructure' | 'presentation' | 'platform' | 'bootstrap';
function layer(file: string): Layer | undefined {
  if (file.startsWith('src/platform/')) return 'platform';
  if (file.startsWith('src/bootstrap/') || file === 'src/main.ts') return 'bootstrap';
  return /^src\/modules\/[^/]+\/(domain|application|infrastructure|presentation)\//.exec(
    file,
  )?.[1] as Layer | undefined;
}

const allowed: Record<Layer, readonly Layer[]> = {
  domain: ['domain'],
  application: ['application', 'domain'],
  infrastructure: ['infrastructure', 'application', 'domain', 'platform'],
  presentation: ['presentation', 'application', 'domain'],
  platform: ['platform'],
  bootstrap: ['bootstrap', 'platform', 'infrastructure', 'presentation', 'application', 'domain'],
};

// Both value and type imports count: neither may invert ownership or introduce cycles.
export function inspectArchitecture(sources: ReadonlyMap<string, string>): ArchitectureIssue[] {
  const issues: ArchitectureIssue[] = [];
  const graph = new Map<string, string[]>();
  for (const [file, source] of sources) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const ownLayer = layer(file);
    graph.set(file, []);
    const issue = (node: ts.Node, rule: ArchitectureIssue['rule'], message: string) => {
      issues.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        rule,
        message,
      });
    };
    const dependency = (node: ts.Node, specifier: string) => {
      if (!specifier.startsWith('.')) {
        if (ownLayer === 'domain' && specifier !== 'decimal.js')
          issue(node, 'dependency', `Domain cannot import ${specifier}`);
        if (ownLayer === 'application')
          issue(node, 'dependency', `Application cannot import external dependency ${specifier}`);
        if (specifier.startsWith('src/'))
          issue(node, 'dependency', 'Use explicit relative imports for local dependencies');
        return;
      }
      const base = posix.normalize(posix.join(posix.dirname(file), specifier));
      const target = [base, `${base}.ts`, `${base}/index.ts`].find((candidate) =>
        sources.has(candidate),
      );
      if (!target) {
        issue(node, 'resolution', `Local dependency does not exist: ${specifier}`);
        return;
      }
      graph.get(file)!.push(target);
      const targetLayer = layer(target);
      if (ownLayer && (!targetLayer || !allowed[ownLayer].includes(targetLayer))) {
        issue(node, 'dependency', `${ownLayer} cannot import ${target}`);
      }
      const ownModule = /^src\/modules\/([^/]+)\//.exec(file)?.[1];
      const targetModule = /^src\/modules\/([^/]+)\//.exec(target)?.[1];
      if (ownModule && targetModule && ownModule !== targetModule)
        issue(node, 'dependency', 'Modules must not import each other through internal files');
      if (file.includes('/application/ports/') && target.includes('/application/use-cases/')) {
        issue(node, 'dependency', 'Ports cannot depend on use-case implementations');
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        dependency(node, node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        dependency(node, node.moduleReference.expression.text);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) dependency(node, argument.text);
        else issue(node, 'resolution', 'Dynamic module paths cannot be checked');
      }
      if (
        (ownLayer === 'domain' || ownLayer === 'application') &&
        (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
        ['httpStatus', 'HttpStatus', 'HttpException'].includes(node.text)
      ) {
        issue(
          node,
          'transport',
          'HTTP status belongs to HTTP presentation or legacy storage decoding',
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  const active: string[] = [];
  const complete = new Set<string>();
  const reported = new Set<string>();
  const visit = (file: string): void => {
    const start = active.indexOf(file);
    if (start !== -1) {
      const cycle = [...active.slice(start), file];
      const key = [...new Set(cycle)].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({ file, line: 1, rule: 'cycle', message: cycle.join(' -> ') });
      }
      return;
    }
    if (complete.has(file)) return;
    active.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.pop();
    complete.add(file);
  };
  for (const file of sources.keys()) visit(file);
  return issues;
}
