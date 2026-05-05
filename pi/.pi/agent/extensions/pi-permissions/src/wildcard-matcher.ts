/**
 * Simple wildcard pattern matching
 * Supports * for zero or more characters
 */

export function matchWildcard(pattern: string, str: string): boolean {
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
    .replace(/\*/g, '.*');
  
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(str);
}

export function findMatchingPattern(
  patterns: Record<string, any>,
  str: string
): { pattern: string; value: any } | null {
  // Last matching pattern wins (like MasuRii's implementation)
  let lastMatch: { pattern: string; value: any } | null = null;
  
  for (const [pattern, value] of Object.entries(patterns)) {
    if (matchWildcard(pattern, str)) {
      lastMatch = { pattern, value };
    }
  }
  
  return lastMatch;
}
