import { isAbsolute } from 'node:path';

// Only the host configuration names sessions and files. Conversation text and
// checkpoints cannot add a file to this list.
export function compactionFiles(setting?: string): Record<string, string[]> {
  if (!setting?.trim()) return {};
  const invalid = () => new Error('RIFTJACK_COMPACTION_FILES must map codex:<session> or claude:<session> to a list of relative workspace file paths.');
  let value: unknown;
  try { value = JSON.parse(setting); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  for (const [key, paths] of Object.entries(value)) {
    if (!/^(codex|claude):[a-zA-Z0-9_-]{1,256}$/.test(key) || !Array.isArray(paths) || !paths.length || paths.length > 32 ||
        paths.some(path => typeof path !== 'string' || path.length > 1024 || isAbsolute(path) ||
          /[\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))) throw invalid();
  }
  return value as Record<string, string[]>;
}
