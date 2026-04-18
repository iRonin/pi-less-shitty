/**
 * Core filtering engine with wildcard pattern matching and per-pattern replacements.
 *
 * Patterns support:
 *   *  — zero or more characters (glob-style)
 *   ?  — exactly one character (typo tolerance)
 *
 * Example patterns:
 *   "f*ck"    → matches fuck, fuuck, fck, etc.
 *   "sh?t"    → matches shit, shat, sht (typo)
 *   "dumb f*ck" → matches dumb fuck, dumb fck, etc.
 */

export interface CompiledRule {
  raw: string;
  regex: RegExp;
  replacement: string;
}

export interface FilterConfig {
  /** Map of pattern → replacement. null replacement means use default. */
  replacements: Record<string, string | null>;
  defaultReplacement: string;
  caseSensitive: boolean;
}

export interface CompiledFilter {
  rules: CompiledRule[];
}

/**
 * Build a compiled filter from configuration.
 * Rules are sorted longest-first so multi-word patterns (e.g. "dumb f*ck")
 * match before shorter ones (e.g. "f*ck") that would overlap.
 */
export function compileFilter(config: FilterConfig): CompiledFilter {
  const flags = config.caseSensitive ? "g" : "gi";

  const rules: CompiledRule[] = Object.entries(config.replacements)
    .map(([pattern, replacement]) => {
      let escaped = "";
      for (const ch of pattern) {
        switch (ch) {
          case "*":
            escaped += ".*";
            break;
          case "?":
            escaped += ".";
            break;
          default:
            if ("\\.^$+{}()|[]".includes(ch)) {
              escaped += "\\" + ch;
            } else {
              escaped += ch;
            }
        }
      }
      return {
        raw: pattern,
        regex: new RegExp(escaped, flags),
        replacement: replacement ?? config.defaultReplacement,
      };
    })
    // Longest pattern first: "dumb f*ck" before "f*ck"
    .sort((a, b) => b.raw.length - a.raw.length);

  return { rules };
}

/**
 * Apply all compiled rules to text.
 * Longer patterns are applied first to prevent shorter patterns
 * from consuming text that a longer pattern should have matched.
 */
export function sanitize(text: string, filter: CompiledFilter): string {
  let result = text;
  for (const rule of filter.rules) {
    rule.regex.lastIndex = 0;
    result = result.replace(rule.regex, rule.replacement);
  }
  return result;
}

/**
 * Check if text contains any pattern matches.
 * Returns array of matched raw patterns.
 */
export function detectMatches(text: string, filter: CompiledFilter): string[] {
  const matched = new Set<string>();
  for (const rule of filter.rules) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) {
      matched.add(rule.raw);
    }
  }
  return Array.from(matched);
}
