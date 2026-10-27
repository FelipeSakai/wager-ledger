import { resolve } from 'node:path';

async function main(): Promise<void> {
  const root = resolve(__dirname, '..');
  const run = async (command: string[]) => {
    const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
    if ((await child.exited) !== 0) throw new Error('Local setup step failed');
  };
  await run([process.execPath, 'run', 'setup:env']);
  await run(['docker', 'compose', 'up', '-d', '--wait', 'postgres', 'localstack']);
  await run([process.execPath, 'run', 'migration:up']);
  await run([process.execPath, 'run', 'sqs:setup']);
  console.log(
    'Local dependencies, schema and queues are ready. Start the API/workers as documented.',
  );
}
main().catch(() => {
  console.error('Local setup failed; inspect the previous step. Existing volumes were preserved.');
  process.exitCode = 1;
});
