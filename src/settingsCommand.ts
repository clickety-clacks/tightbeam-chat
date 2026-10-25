export function isSettingsCommand(content: unknown): content is string {
  return typeof content === 'string' && content.trim() === '/settings';
}
