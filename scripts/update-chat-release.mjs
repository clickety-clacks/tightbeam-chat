import { installChatRelease, rollbackChatRelease } from './chat-release-updater.mjs';

async function main(arguments_) {
  const [command, value, extra] = arguments_;
  if (extra !== undefined) throw new Error('Use one Chat release command at a time.');
  if (command === 'install' && value) {
    const result = await installChatRelease(value);
    process.stdout.write(`${JSON.stringify({ action: 'installed', ...result })}\n`);
    return;
  }
  if (command === 'rollback' && value === undefined) {
    const result = await rollbackChatRelease();
    process.stdout.write(`${JSON.stringify({ action: 'rolled-back', ...result })}\n`);
    return;
  }
  throw new Error('Usage: node update-chat-release.mjs install <published-tag> | rollback');
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Chat release update failed.'}\n`);
  process.exitCode = 1;
}
