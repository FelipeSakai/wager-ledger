import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectArchitecture } from './architecture-rules';

async function main(): Promise<void> {
  const root = resolve(__dirname, '..');
  const sources = new Map<string, string>();
  const collect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else if (file.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(file))
        sources.set(file, await readFile(resolve(root, file), 'utf8'));
    }
  };
  await collect('src');
  const issues = inspectArchitecture(sources);
  for (const issue of issues)
    console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`);
  if (issues.length) process.exitCode = 1;
  else
    console.log(
      `Architecture verified: ${sources.size} source files, allowed boundaries and no import cycles`,
    );
}
main().catch(() => {
  console.error('Architecture verification failed');
  process.exitCode = 1;
});
