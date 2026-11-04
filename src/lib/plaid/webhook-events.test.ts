import { describe, it, expect } from 'vitest';
import {
  classifyWebhookEvent,
  errorCodeFromPayload,
  statusForErrorCode,
  PROCESSED_WEBHOOK_TYPES,
} from './webhook-events';

describe('classifyWebhookEvent', () => {
  describe('TRANSACTIONS', () => {
    it.each([
      'SYNC_UPDATES_AVAILABLE',
      'INITIAL_UPDATE',
      'HISTORICAL_UPDATE',
      'DEFAULT_UPDATE',
      'TRANSACTIONS_REMOVED',
    ])('routes %s to a sync', (code) => {
      expect(classifyWebhookEvent('TRANSACTIONS', code)).toBe('sync');
    });

    it('treats unrecognised transaction codes as no-ops', () => {
      expect(classifyWebhookEvent('TRANSACTIONS', 'SOMETHING_NEW')).toBe('noop');
    });
  });

  describe('ITEM — the type that was never processed at all', () => {
    it('routes ERROR to item_error', () => {
      expect(classifyWebhookEvent('ITEM', 'ERROR')).toBe('item_error');
    });

    it('routes NEW_ACCOUNTS_AVAILABLE to an account refresh', () => {
      // The 2026-08-17 event that sat pending for five weeks holding the
      // missing card.
      expect(classifyWebhookEvent('ITEM', 'NEW_ACCOUNTS_AVAILABLE')).toBe('refresh_accounts');
    });

    it('routes LOGIN_REPAIRED to the repair handler', () => {
      expect(classifyWebhookEvent('ITEM', 'LOGIN_REPAIRED')).toBe('login_repaired');
    });

    it.each(['PENDING_EXPIRATION', 'PENDING_DISCONNECT'])(
      'treats %s as an item error so it escalates',
      (code) => {
        expect(classifyWebhookEvent('ITEM', code)).toBe('item_error');
      }
    );

    it('treats unrecognised item codes as no-ops', () => {
      expect(classifyWebhookEvent('ITEM', 'WEBHOOK_UPDATE_ACKNOWLEDGED')).toBe('noop');
    });
  });

  it('ignores types the processor does not consume', () => {
    expect(classifyWebhookEvent('AUTH', 'DEFAULT_UPDATE')).toBe('noop');
    expect(classifyWebhookEvent('HOLDINGS', 'DEFAULT_UPDATE')).toBe('noop');
  });

  it('does not confuse webhook codes with webhook types', () => {
    // The original bug: DEFAULT_UPDATE et al. were listed as *types*, so the
    // filter matched nothing and ITEM was excluded entirely.
    expect(classifyWebhookEvent('DEFAULT_UPDATE', 'DEFAULT_UPDATE')).toBe('noop');
    expect(classifyWebhookEvent('INITIAL_UPDATE', 'INITIAL_UPDATE')).toBe('noop');
    expect(PROCESSED_WEBHOOK_TYPES).toEqual(['TRANSACTIONS', 'ITEM']);
  });
});

describe('errorCodeFromPayload', () => {
  it('reads the nested Plaid error_code', () => {
    expect(
      errorCodeFromPayload({ error: { error_code: 'ITEM_LOGIN_REQUIRED' } }, 'ERROR')
    ).toBe('ITEM_LOGIN_REQUIRED');
  });

  it('uses the webhook code itself for pending-expiration events', () => {
    // These carry no error object — the code is the condition.
    expect(errorCodeFromPayload({}, 'PENDING_EXPIRATION')).toBe('PENDING_EXPIRATION');
    expect(errorCodeFromPayload(null, 'PENDING_DISCONNECT')).toBe('PENDING_DISCONNECT');
  });

  it('falls back to UNKNOWN when there is nothing to read', () => {
    expect(errorCodeFromPayload({}, 'ERROR')).toBe('UNKNOWN');
    expect(errorCodeFromPayload(null, 'ERROR')).toBe('UNKNOWN');
    expect(errorCodeFromPayload({ error: {} }, 'ERROR')).toBe('UNKNOWN');
    expect(errorCodeFromPayload({ error: { error_code: 7 } }, 'ERROR')).toBe('UNKNOWN');
  });
});

describe('statusForErrorCode', () => {
  it('sends reauth codes to reauth_required', () => {
    expect(statusForErrorCode('ITEM_LOGIN_REQUIRED')).toBe('reauth_required');
    expect(statusForErrorCode('PENDING_EXPIRATION')).toBe('reauth_required');
  });

  it('sends everything else to degraded', () => {
    expect(statusForErrorCode('INSTITUTION_DOWN')).toBe('degraded');
    expect(statusForErrorCode('UNKNOWN')).toBe('degraded');
  });

  it('only ever returns a status the DB CHECK constraint allows', () => {
    const allowed = ['connected', 'degraded', 'disconnected', 'reauth_required'];
    for (const code of ['ITEM_LOGIN_REQUIRED', 'INSTITUTION_DOWN', 'UNKNOWN', '']) {
      expect(allowed).toContain(statusForErrorCode(code));
    }
  });
});
