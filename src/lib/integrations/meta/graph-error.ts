const META_AUTH_PERMISSION_CODES = new Set([10, 190, 200, 275, 294]);

export class MetaGraphRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly metaCode: number | null;

  constructor(
    code: string,
    status: number,
    retryable: boolean,
    metaCode: number | null = null,
  ) {
    super(`A Graph API recusou a operação (${code}).`);
    this.name = "MetaGraphRequestError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.metaCode = metaCode;
  }
}

export function isMetaAuthOrPermissionError(
  error: MetaGraphRequestError,
): boolean {
  return (
    error.status === 401 ||
    error.status === 403 ||
    (error.metaCode !== null && META_AUTH_PERMISSION_CODES.has(error.metaCode))
  );
}

export function assertMatchingMetaIdentifier(
  signedIdentifier: string | null,
  graphIdentifier: string | null,
  mismatchCode: string,
): void {
  if (
    signedIdentifier !== null &&
    graphIdentifier !== null &&
    signedIdentifier !== graphIdentifier
  ) {
    throw new MetaGraphRequestError(mismatchCode, 502, false);
  }
}
