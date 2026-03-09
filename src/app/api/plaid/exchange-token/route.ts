import { NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { getPlaidClient } from '@/lib/plaid/client';
import { encrypt } from '@/lib/crypto';
import { toClientError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const ip = getClientIP(request.headers) ?? 'unknown';
    const rateCheck = checkRateLimit(RATE_LIMITS.PLAID_LINK, user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
    }

    const body = await request.json();
    const { public_token, entity_id, institution } = body;

    if (!public_token || typeof public_token !== 'string') {
      return NextResponse.json({ error: 'Missing public_token.' }, { status: 400 });
    }

    if (!entity_id || typeof entity_id !== 'string') {
      return NextResponse.json({ error: 'Missing entity_id.' }, { status: 400 });
    }

    // Verify entity ownership (RLS enforces user_id match)
    const { data: entity, error: entityError } = await supabase
      .from('entities')
      .select('id')
      .eq('id', entity_id)
      .eq('is_active', true)
      .single();

    if (entityError || !entity) {
      return NextResponse.json({ error: 'Invalid entity.' }, { status: 400 });
    }

    // Exchange public token for access token via Plaid
    const plaidClient = getPlaidClient();
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const accessToken = exchangeResponse.data.access_token;
    const plaidItemId = exchangeResponse.data.item_id;

    // Service role client for private schema operations
    const serviceClient = createServiceRoleClient();

    // Insert plaid_item record
    const { data: plaidItemRow, error: itemInsertError } = await serviceClient
      .from('plaid_items')
      .insert({
        user_id: user.id,
        entity_id,
        plaid_item_id: plaidItemId,
        institution_name: institution?.name || null,
        status: 'connected',
      })
      .select('id')
      .single();

    if (itemInsertError || !plaidItemRow) {
      logger.error('Failed to insert plaid_item', { error_message: itemInsertError?.message });
      return NextResponse.json({ error: 'Failed to store connection.' }, { status: 500 });
    }

    // Encrypt the access token and store in private.plaid_tokens
    const encryptedToken = encrypt(accessToken);
    const { error: tokenInsertError } = await serviceClient
      .schema('private')
      .from('plaid_tokens')
      .insert({
        plaid_item_id: plaidItemRow.id,
        access_token_encrypted: encryptedToken,
      });

    if (tokenInsertError) {
      logger.error('Failed to store encrypted token', { error_message: tokenInsertError.message });
      // Roll back the plaid_item since token storage failed
      await serviceClient.from('plaid_items').delete().eq('id', plaidItemRow.id);
      return NextResponse.json({ error: 'Failed to store credentials.' }, { status: 500 });
    }

    // Fetch accounts from Plaid and store them
    try {
      const accountsResponse = await plaidClient.accountsGet({
        access_token: accessToken,
      });

      const accountRows = accountsResponse.data.accounts.map((acct) => ({
        user_id: user.id,
        entity_id,
        plaid_item_id: plaidItemRow.id,
        plaid_account_id: acct.account_id,
        name: acct.name,
        official_name: acct.official_name || null,
        type: acct.type || 'other',
        subtype: acct.subtype || null,
        current_balance: acct.balances.current,
        available_balance: acct.balances.available,
        currency: acct.balances.iso_currency_code || 'USD',
        mask: acct.mask || null,
      }));

      if (accountRows.length > 0) {
        const { error: acctInsertError } = await serviceClient
          .from('accounts')
          .insert(accountRows);

        if (acctInsertError) {
          logger.error('Failed to insert accounts', { error_message: acctInsertError.message });
        }
      }
    } catch (acctError) {
      // Non-fatal — the sync cron will pick up accounts later
      logger.warn('Failed to fetch initial accounts', { error_message: String(acctError) });
    }

    // Audit log
    await writeAuditLog(serviceClient, {
      userId: user.id,
      action: 'PLAID_ITEM_LINKED',
      entityType: 'plaid_item',
      entityId: plaidItemRow.id,
      details: {
        institution_name: institution?.name,
        plaid_item_id: plaidItemId,
        ip_address: ip,
      },
      ipAddress: ip,
    });

    logger.info('Plaid item linked successfully', {
      user_id: user.id,
      plaid_item_db_id: plaidItemRow.id,
    });

    return NextResponse.json({
      success: true,
      plaid_item_id: plaidItemRow.id,
      institution_name: institution?.name || null,
    });
  } catch (error) {
    logger.error('exchange-token error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
