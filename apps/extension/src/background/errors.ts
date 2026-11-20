import type { ErrorInfo } from "../shared/messages";

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly fields: Record<string, string>;
  readonly extra: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { status?: number; requestId?: string | null; retryable?: boolean; fields?: Record<string, string>; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.code = code;
    this.status = opts.status ?? 0;
    this.requestId = opts.requestId ?? null;
    this.retryable = opts.retryable ?? false;
    this.fields = opts.fields ?? {};
    this.extra = opts.extra ?? {};
  }
}

/** The user is not (or no longer) signed in to the extension. */
export const authRequired = (message = "Connect Prepzy to your account to continue.") => new AppError("auth_required", message);

export const networkError = (message = "Connection lost. The server may still be processing your request.") =>
  new AppError("network_error", message, { retryable: true });

export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof AppError) {
    const fieldText = Object.entries(e.fields)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    return {
      code: e.code,
      message: fieldText && e.code === "validation_failed" ? `${e.message} (${fieldText})` : e.message,
      requestId: e.requestId,
      retryable: e.retryable,
    };
  }
  return { code: "internal_error", message: "Something went wrong in the extension. Try again.", requestId: null, retryable: true };
}
