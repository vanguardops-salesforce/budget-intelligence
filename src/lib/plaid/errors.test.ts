import { describe, it, expect } from 'vitest';
import {
  extractPlaidError,
  requiresReauth,
  UnknownAccountError,
  UNKNOWN_ERROR_CODE,
} from './errors';

/** The shape the Plaid SDK throws: an Axios error carrying the API body. */
function plaidAxiosError(body: Record<string, unknown>) {
  const err = new Error('Request failed with status code 400') as Error & {
    response: { data: Record<string, unknown> };
  };
  err.response = { data: body };
  return err;
}

describe('extractPlaidError', () => {
  it('pulls the real error_code out of a Plaid SDK error', () => {
    const error = plaidAxiosError({
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_type: 'ITEM_ERROR',
      error_message: 'the login details of this item have changed',
    });

    expect(extractPlaidError(error)).toEqual({
      errorCode: 'ITEM_LOGIN_REQUIRED',
      errorType: 'ITEM_ERROR',
      errorMessage: 'the login details of this item have changed',
    });
  });

  it('falls back to display_message when error_message is absent', () => {
    const error = plaidAxiosError({
      error_code: 'INSTITUTION_DOWN',
      display_message: 'This institution is temporarily unavailable.',
    });
    const info = extractPlaidError(error);
    expect(info.errorCode).toBe('INSTITUTION_DOWN');
    expect(info.errorMessage).toBe('This institution is temporarily unavailable.');
    expect(info.errorType).toBeNull();
  });

  it('uses a sentinel for errors that never reached Plaid', () => {
    const info = extractPlaidError(new Error('socket hang up'));
    expect(info.errorCode).toBe(UNKNOWN_ERROR_CODE);
    expect(info.errorMessage).toBe('socket hang up');
  });

  it('handles non-Error throwables without crashing', () => {
    expect(extractPlaidError('boom').errorCode).toBe(UNKNOWN_ERROR_CODE);
    expect(extractPlaidError(null).errorCode).toBe(UNKNOWN_ERROR_CODE);
    expect(extractPlaidError(undefined).errorMessage).toBe('undefined');
  });

  it('ignores a non-string or empty error_code', () => {
    expect(extractPlaidError(plaidAxiosError({ error_code: 42 })).errorCode).toBe(UNKNOWN_ERROR_CODE);
    expect(extractPlaidError(plaidAxiosError({ error_code: '' })).errorCode).toBe(UNKNOWN_ERROR_CODE);
  });

  it('truncates very long messages for storage', () => {
    const error = plaidAxiosError({ error_code: 'X', error_message: 'y'.repeat(900) });
    expect(extractPlaidError(error).errorMessage).toHaveLength(500);
  });
});

describe('requiresReauth', () => {
  it('escalates codes that only the user can clear', () => {
    expect(requiresReauth('ITEM_LOGIN_REQUIRED')).toBe(true);
    expect(requiresReauth('PENDING_EXPIRATION')).toBe(true);
    expect(requiresReauth('ITEM_LOCKED')).toBe(true);
    expect(requiresReauth('INVALID_CREDENTIALS')).toBe(true);
    expect(requiresReauth('INVALID_MFA')).toBe(true);
  });

  it('does not escalate transient or unrelated failures', () => {
    expect(requiresReauth('INSTITUTION_DOWN')).toBe(false);
    expect(requiresReauth('RATE_LIMIT_EXCEEDED')).toBe(false);
    expect(requiresReauth('INTERNAL_SERVER_ERROR')).toBe(false);
    expect(requiresReauth(UNKNOWN_ERROR_CODE)).toBe(false);
  });

  it('never escalates the old invented literals', () => {
    // The whole point: these carried no diagnosis, so they must not be treated
    // as actionable. They should not exist any more, but be explicit about it.
    expect(requiresReauth('HEAL_SYNC_ERROR')).toBe(false);
    expect(requiresReauth('SYNC_ERROR')).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(requiresReauth(null)).toBe(false);
    expect(requiresReauth(undefined)).toBe(false);
    expect(requiresReauth('')).toBe(false);
  });
});

describe('UnknownAccountError', () => {
  it('names the unmapped accounts and the number of transactions at risk', () => {
    const err = new UnknownAccountError('ccffe6d8', ['newAcct1', 'newAcct2'], 254);
    expect(err.name).toBe('UnknownAccountError');
    expect(err.droppedCount).toBe(254);
    expect(err.unknownAccountIds).toEqual(['newAcct1', 'newAcct2']);
    expect(err.message).toContain('254 transaction(s)');
    expect(err.message).toContain('newAcct1');
    expect(err.message).toContain('before the cursor advances');
  });

  it('is catchable as an Error', () => {
    expect(new UnknownAccountError('x', ['y'], 1)).toBeInstanceOf(Error);
  });
});
