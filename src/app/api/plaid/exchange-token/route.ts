import { NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { getPlaidClient } from '@/lib/plaid/client';
import { encrypt } from '@/lib/crypto';
import { z } from 'zod';

const bodySchema = z.object({
  public_token: z.string().min(1),
  entity_id: z.string().uuid(),
  institution_name: z.string().optional(),
});

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
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
    }

    // Verify entity ownership
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('id', parsed.data.entity_id)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found.' }, { status: 404 });
    }

    // Exchange public token for access token
    const plaid = getPlaidClient();
    const exchangeResponse = await plaid.itemPublicTokenExchange({
      public_token: parsed.data.public_token,
    });

    const accessToken = exchangeResponse.data.access_token;
    const plaidItemId = exchangeResponse.data.item_id;

    // Encrypt the access token
    const encryptedToken = encrypt(accessToken);

    // Use service role client for private schema operations
    const serviceClient = createServiceRoleClient();

    // Create plaid_items record
    const { data: plaidItem, error: itemError } = await serviceClient
      .from('plaid_items')
      .insert({
        user_id: user.id,
        entity_id: parsed.data.entity_id,
        plaid_item_id: plaidItemId,
        institution_name: parsed.data.institution_name ?? null,
        status: 'connected',
      })
      .select('id')
      .single();

    if (itemError || !plaidItem) {
      logger.error('Failed to create plaid_items record', {
        error_message: itemError?.message ?? 'Unknown error',
      });
      return NextResponse.json({ error: 'Failed to save connection.' }, { status: 500 });
    }

    // Store encrypted token in private.plaid_tokens via RPC
    const { error: tokenError } = await serviceClient.rpc('store_plaid_token', {
      p_plaid_item_id: plaidItem.id,
      p_encrypted_token: encryptedToken,
    });

    if (tokenError) {
      logger.error('Failed to store encrypted token', {
        error_message: tokenError.message,
      });
      // Clean up the plaid_items record since token storage failed
      await serviceClient.from('plaid_items').delete().eq('id', plaidItem.id);
      return NextResponse.json({ error: 'Failed to save connection.' }, { status: 500 });
    }

    // Fetch and store accounts from Plaid
    const accountsResponse = await plaid.accountsGet({ access_token: accessToken });

    const accountRows = accountsResponse.data.accounts.map((account) => ({
      user_id: user.id,
      entity_id: parsed.data.entity_id,
      plaid_item_id: plaidItem.id,
      plaid_account_id: account.account_id,
      name: account.name,
      official_name: account.official_name ?? null,
      type: mapPlaidAccountType(account.type),
      subtype: account.subtype ?? null,
      current_balance: account.balances.current,
      available_balance: account.balances.available,
      currency: account.balances.iso_currency_code ?? 'USD',
      mask: account.mask ?? null,
    }));

    if (accountRows.length > 0) {
      const { error: accountsError } = await serviceClient
        .from('accounts')
        .insert(accountRows);

      if (accountsError) {
        logger.error('Failed to store accounts', {
          error_message: accountsError.message,
        });
      }
    }

    // Audit log
    await writeAuditLog(serviceClient, {
      userId: user.id,
      action: 'PLAID_ITEM_LINKED',
      entityType: 'plaid_item',
      entityId: plaidItem.id,
      details: {
        institution_name: parsed.data.institution_name,
        accounts_count: accountRows.length,
      },
      ipAddress: ip,
    });

    logger.info('Plaid item linked successfully', {
      user_id: user.id,
      plaid_item_id: plaidItemId,
      accounts_count: String(accountRows.length),
    });

    return NextResponse.json({
      item_id: plaidItem.id,
      accounts: accountRows.length,
    });
  } catch (error) {
    logger.error('exchange-token error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}

function mapPlaidAccountType(plaidType: string): string {
  const mapping: Record<string, string> = {
    depository: 'depository',
    credit: 'credit',
    investment: 'investment',
    loan: 'loan',
  };
  return mapping[plaidType] ?? 'other';
}
