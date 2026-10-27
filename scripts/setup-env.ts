import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const path = resolve(__dirname, '../.env');
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (typeof error !== 'object' || !error || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    content = await readFile(resolve(__dirname, '../.env.example'), 'utf8');
  }
  if (!/^LEDGER_CURSOR_SECRET=.+$/m.test(content)) {
    const entry = `LEDGER_CURSOR_SECRET=${randomBytes(32).toString('base64url')}`;
    content = /^LEDGER_CURSOR_SECRET=.*$/m.test(content)
      ? content.replace(/^LEDGER_CURSOR_SECRET=.*$/m, entry)
      : `${content.trimEnd()}\n${entry}\n`;
    await writeFile(path, content, { mode: 0o600 });
    console.log('Local environment prepared; cursor signing key generated');
  } else console.log('Existing local environment preserved');
}
main().catch(() => {
  console.error('Local environment setup failed');
  process.exitCode = 1;
});
