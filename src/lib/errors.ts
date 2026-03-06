/**
 * Typed error classes for consistent error handling.
 * Client-facing responses use generic messages. Server logs get details.
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class MFARequiredError extends AppError {
  constructor(public readonly type: 'enrollment' | 'challenge') {
    super(
      type === 'enrollment' ? 'MFA enrollment required' : 'MFA challenge required',
      type === 'enrollment' ? 'MFA_REQUIRED' : 'MFA_CHALLENGE_REQUIRED',
      403
    );
    this.name = 'MFARequiredError';
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly resetAt: number) {
    super('Rate limit exceeded', 'RATE_LIMIT_EXCEEDED', 429);
    this.name = 'RateLimitError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class PlaidError extends AppError {
  constructor(
    message: string,
    public readonly plaidErrorCode?: string,
    public readonly plaidItemId?: string
  ) {
    super(message, 'PLAID_ERROR', 502, {
      plaid_error_code: plaidErrorCode,
      plaid_item_id: plaidItemId,
    });
    this.name = 'PlaidError';
  }
}

/**
 * Convert any error to a safe client-facing JSON response.
 * NEVER expose internal details, stack traces, or secrets.
 */
export function toClientError(error: unknown): { error: string; code?: string; status: number } {
  if (error instanceof RateLimitError) {
    return { error: 'Too many requests. Please try again later.', code: error.code, status: 429 };
  }
  if (error instanceof AuthenticationError) {
    return { error: 'Authentication required.', code: error.code, status: 401 };
  }
  if (error instanceof MFARequiredError) {
    return { error: error.message, code: error.code, status: 403 };
  }
  if (error instanceof ValidationError) {
    return { error: 'Invalid request.', code: error.code, status: 400 };
  }
  if (error instanceof AppError) {
    return { error: 'Something went wrong. Please try again.', code: error.code, status: error.statusCode };
  }
  return { error: 'Something went wrong. Please try again.', status: 500 };
}
