import type { CkbConfig } from "../config/schema.js";
import { InvalidSensitivityPatternError } from "../core/errors.js";
import type { ExtractedNote } from "../extractors/types.js";

export interface RedactionResult {
  content: string;
  redactions: number;
}

export type ExclusionReason = "note_id" | "title_pattern";

export interface SensitivityResult {
  note: ExtractedNote;
  redactions: number;
  reasons: ExclusionReason[];
}

const ASSIGNED_SECRET =
  /(?<![.\w])(password|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|aws_access_key_id)\b(\s*[:=]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s#]+)/gi;
const PRIVATE_KEY =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const OPENAI_STYLE_TOKEN = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const LABELED_NUMERIC_SECRET_LINE =
  /^(\s*(?:\*\*|__)?(?:cvc|cvv|pin|card(?: number)?)(?:\*\*|__)?)(\s*(?::|=)?\s+)(\d(?:[\d -]*\d)?)(\s*)$/gim;
const STANDALONE_TOKEN_LINE = /^(\s*(?:\*\*|__)?)(\S{8,64})((?:\*\*|__)?\s*)$/gm;
const CARD_NUMBER = /(?<![A-Za-z0-9])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9])/g;

function isLikelyStandaloneSecret(value: string): boolean {
  const candidate = value.replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, "");
  return !candidate.includes("://") &&
    /[a-z]/.test(candidate) &&
    /[A-Z]/.test(candidate) &&
    /\d/.test(candidate) &&
    /[^A-Za-z0-9]/.test(candidate);
}

function isCodePlaceholder(value: string): boolean {
  const candidate = value.replace(/^['"]|['"]$/g, "");
  if (candidate.includes("[REDACTED_SECRET]")) return true;
  return /^(?:string|number|boolean|unknown|undefined|null|config\.|this\.|process\.env\b)/i
    .test(candidate) ||
    /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*[;,) ]*$/.test(candidate);
}

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isInsideHttpUrl(content: string, offset: number): boolean {
  const start = Math.max(
    content.lastIndexOf("http://", offset),
    content.lastIndexOf("https://", offset),
  );
  return start >= 0 && !/[\s)\]]/.test(content.slice(start, offset));
}

export function redactSecrets(content: string): RedactionResult {
  let redactions = 0;
  let redacted = content.replace(
    ASSIGNED_SECRET,
    (full, key: string, separator: string) => {
      const value = full.slice(key.length + separator.length).trim();
      if (isCodePlaceholder(value)) return full;
      redactions += 1;
      return `${key}${separator}[REDACTED_SECRET]`;
    },
  );
  for (const pattern of [PRIVATE_KEY, OPENAI_STYLE_TOKEN, AWS_ACCESS_KEY]) {
    redacted = redacted.replace(pattern, () => {
      redactions += 1;
      return "[REDACTED_SECRET]";
    });
  }
  redacted = redacted.replace(
    LABELED_NUMERIC_SECRET_LINE,
    (_full, label: string, separator: string, _value: string, trailing: string) => {
      redactions += 1;
      return `${label}${separator}[REDACTED_SECRET]${trailing}`;
    },
  );
  redacted = redacted.replace(CARD_NUMBER, (value, offset: number, content: string) => {
    if (isInsideHttpUrl(content, offset) || !/[ -]/.test(value) || !passesLuhn(value)) return value;
    redactions += 1;
    return "[REDACTED_SECRET]";
  });
  // Standalone mixed-character tokens are ambiguous in ordinary prose. Only
  // redact them when the same note already contains a high-confidence secret.
  if (redactions > 0) {
    redacted = redacted.replace(CARD_NUMBER, (value, offset: number, content: string) => {
      if (isInsideHttpUrl(content, offset) || !/[ -]/.test(value)) return value;
      redactions += 1;
      return "[REDACTED_SECRET]";
    });
    redacted = redacted.replace(
      STANDALONE_TOKEN_LINE,
      (full, leading: string, token: string, trailing: string) => {
        if (!isLikelyStandaloneSecret(token)) return full;
        redactions += 1;
        return `${leading}[REDACTED_SECRET]${trailing}`;
      },
    );
  }
  return { content: redacted, redactions };
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch (error: unknown) {
      throw new InvalidSensitivityPatternError(
        pattern,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

export function applySensitivity(
  note: ExtractedNote,
  config: CkbConfig["sensitivity"],
): SensitivityResult {
  const reasons: ExclusionReason[] = [];
  if (config.excludedNoteIds.includes(note.id)) reasons.push("note_id");
  if (compilePatterns(config.excludedTitlePatterns).some((pattern) => pattern.test(note.title))) {
    reasons.push("title_pattern");
  }

  if (reasons.length > 0) {
    const title = redactSecrets(note.title);
    const accountName = redactSecrets(note.accountName);
    const folderName = redactSecrets(note.folderName);
    let linkRedactions = 0;
    const internalLinks = note.internalLinks.map((link) => {
      if (!link.label) return { ...link };
      const label = redactSecrets(link.label);
      linkRedactions += label.redactions;
      return { ...link, label: label.content };
    });
    return {
      note: {
        ...note,
        title: title.content,
        accountName: accountName.content,
        folderName: folderName.content,
        internalLinks,
        sensitivity: "excluded",
      },
      redactions: title.redactions + accountName.redactions + folderName.redactions + linkRedactions,
      reasons,
    };
  }
  if (!config.redactSecrets) {
    return { note: { ...note }, redactions: 0, reasons };
  }
  const body = note.markdown === null
    ? { content: null, redactions: 0 }
    : redactSecrets(note.markdown);
  const title = redactSecrets(note.title);
  const accountName = redactSecrets(note.accountName);
  const folderName = redactSecrets(note.folderName);
  let linkRedactions = 0;
  const internalLinks = note.internalLinks.map((link) => {
    if (!link.label) return { ...link };
    const label = redactSecrets(link.label);
    linkRedactions += label.redactions;
    return { ...link, label: label.content };
  });
  return {
    note: {
      ...note,
      title: title.content,
      accountName: accountName.content,
      folderName: folderName.content,
      markdown: body.content,
      internalLinks,
    },
    redactions:
      body.redactions +
      title.redactions +
      accountName.redactions +
      folderName.redactions +
      linkRedactions,
    reasons,
  };
}
