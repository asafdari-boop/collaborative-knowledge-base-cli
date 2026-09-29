export class CkbError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class PathEscapeError extends CkbError {
  public constructor(path: string) {
    super("path_escape", `Path escapes the configured vault: ${path}`);
  }
}

export class SymlinkPathError extends CkbError {
  public constructor(path: string) {
    super("symlink_path", `Refusing to write through a symbolic link: ${path}`);
  }
}

export class InvalidWorkspaceError extends CkbError {
  public constructor(message: string) {
    super("invalid_workspace", message);
  }
}

export class InvalidFrontmatterError extends CkbError {
  public constructor(message: string) {
    super("invalid_frontmatter", message);
  }
}

export class InvalidObjectHashError extends CkbError {
  public constructor(hash: string) {
    super("invalid_object_hash", `Invalid object hash: ${hash}`);
  }
}

export class ObjectHashMismatchError extends CkbError {
  public constructor(hash: string) {
    super("object_hash_mismatch", `Stored object does not match its hash: ${hash}`);
  }
}

export class InvalidStateError extends CkbError {
  public constructor(message: string) {
    super("invalid_state", message);
  }
}

export class WorkspaceLockedError extends CkbError {
  public constructor() {
    super("workspace_locked", "Another knowledge-base write operation is active");
  }
}

export class StaleRevisionError extends CkbError {
  public readonly expectedHash: string | null;
  public readonly actualHash: string | null;

  public constructor(path: string, expectedHash: string | null, actualHash: string | null) {
    super("stale_revision", `Live revision changed before writing ${path}`);
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class StaleStateError extends CkbError {
  public readonly expectedHash: string;
  public readonly actualHash: string;

  public constructor(expectedHash: string, actualHash: string) {
    super("stale_state", "Workspace state changed before the operation acquired its lock");
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class InvalidTransactionError extends CkbError {
  public constructor(message: string) {
    super("invalid_transaction", message);
  }
}

export class TransactionRollbackError extends CkbError {
  public constructor(message: string) {
    super("rollback_failed", message);
  }
}

export class RecoveryConflictError extends CkbError {
  public constructor(path: string) {
    super(
      "recovery_conflict",
      `Recovery stopped because ${path} no longer matches the prepared operation`,
    );
  }
}

export class ReviewNotFoundError extends CkbError {
  public constructor(reviewId: string) {
    super("review_not_found", `Review not found: ${reviewId}`);
  }
}

export class StaleReviewError extends CkbError {
  public constructor(reviewId: string) {
    super("stale_review", `The live page or review artifact changed after ${reviewId} was created`);
  }
}

export class PageNotTrackedError extends CkbError {
  public constructor(path: string) {
    super("page_not_tracked", `No shared base is recorded for ${path}`);
  }
}

export class PageIdentityMismatchError extends CkbError {
  public constructor(path: string) {
    super("page_identity_mismatch", `A proposal attempted to change the stable page ID for ${path}`);
  }
}

export class DependencyUnavailableError extends CkbError {
  public constructor(dependency: string, detail?: string) {
    super(
      "dependency_unavailable",
      `${dependency} is unavailable${detail ? `: ${detail}` : ""}`,
    );
  }
}

export class MalformedExportError extends CkbError {
  public constructor(message: string) {
    super("malformed_export", message);
  }
}

export class IncompleteCensusError extends CkbError {
  public constructor(message: string) {
    super("incomplete_census", message);
  }
}

export class SourceMirrorModifiedError extends CkbError {
  public constructor(path: string) {
    super("source_mirror_modified", `Generated source was modified outside CKB: ${path}`);
  }
}

export class SensitiveContentExcludedError extends CkbError {
  public constructor(noteIdHash: string) {
    super("sensitive_content_excluded", `Sensitive note content was excluded: ${noteIdHash}`);
  }
}

export class CompilerValidationError extends CkbError {
  public constructor(message: string) {
    super("compiler_validation_failed", message);
  }
}

export class ProcessTimeoutError extends CkbError {
  public constructor(executable: string, timeoutMs: number) {
    super("process_timeout", `${executable} exceeded its ${timeoutMs}ms execution limit`);
  }
}

export class ProcessOutputLimitError extends CkbError {
  public constructor(executable: string, maxOutputBytes: number) {
    super(
      "process_output_limit",
      `${executable} exceeded its ${maxOutputBytes}-byte output limit`,
    );
  }
}

export class ProcessSpawnError extends CkbError {
  public constructor(executable: string, detail: string) {
    super("process_spawn_failed", `Unable to start ${executable}: ${detail}`);
  }
}

export class InvalidSourceIdentityError extends CkbError {
  public constructor(message: string) {
    super("invalid_source_identity", message);
  }
}

export class AttachmentTooLargeError extends CkbError {
  public constructor(path: string, sizeBytes: number, maxBytes: number) {
    super(
      "attachment_too_large",
      `Attachment ${path} is ${sizeBytes} bytes, over the ${maxBytes}-byte limit`,
    );
  }
}

export class InvalidSensitivityPatternError extends CkbError {
  public constructor(pattern: string, detail: string) {
    super("invalid_sensitivity_pattern", `Invalid sensitivity pattern ${pattern}: ${detail}`);
  }
}
