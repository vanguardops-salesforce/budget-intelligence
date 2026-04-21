import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getPlaidClient } from '@/lib/plaid/client';
import { decrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';

/**
 * Sync credit card liabilities (statement balance, due date, APR, min payment)
 * for every connected Plaid Item. Upserts into public.card_statements keyed on
 * plaid_account_id. One bad Item does not abort the job.
 *
 * Protected by CRON_SECRET bearer token when invoked from Vercel Cron.
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const secrets = getSecrets();

    if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
      logger.warn('Unauthorized sync-liabilities access attempt');
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const supabase = createServiceRoleClient();
    const plaidClient = getPlaidClient();

    const { data: tokens, error: tokensError } = await supabase
      .schema('private')
      .from('plaid_tokens')
      .select('plaid_item_id, access_token_encrypted');

    if (tokensError) {
      logger.error('Failed to load plaid_tokens', { error_message: tokensError.message });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    const tokenRows = tokens ?? [];
    const errors: string[] = [];
    let synced = 0;

    for (const tokenRow of tokenRows) {
      const plaidItemDbId = tokenRow.plaid_item_id as string;

      try {
        const { data: item, error: itemError } = await supabase
          .from('plaid_items')
          .select('id, entity_id, plaid_item_id, status')
          .eq('id', plaidItemDbId)
          .single();

        if (itemError || !item) {
          errors.push(`plaid_item ${plaidItemDbId}: not found`);
          continue;
        }

        if (item.status === 'reauth_required' || item.status === 'disconnected') {
          logger.info('Skipping liabilities sync for non-active item', {
            plaid_item_db_id: plaidItemDbId,
            status: item.status,
          });
          continue;
        }

        const accessToken = decrypt(tokenRow.access_token_encrypted as string);

        const response = await plaidClient.liabilitiesGet({ access_token: accessToken });

        const creditCards = response.data.liabilities.credit ?? [];
        const accounts = response.data.accounts ?? [];

        for (const cc of creditCards) {
          const account = accounts.find((a) => a.account_id === cc.account_id);
          if (!account) continue;

          const purchaseApr = (cc.aprs ?? []).find((a) => a.apr_type === 'purchase_apr')
            ?.apr_percentage ?? null;

          const nextDue = cc.next_payment_due_date ?? null;
          const isOverdue = nextDue
            ? new Date(nextDue) < new Date(new Date().toISOString().split('T')[0])
            : false;

          const row = {
            entity_id: item.entity_id,
            plaid_account_id: cc.account_id,
            plaid_item_id: item.id,
            card_name: account.name,
            card_mask: account.mask ?? null,
            last_statement_balance: cc.last_statement_balance ?? null,
            last_statement_issue_date: cc.last_statement_issue_date ?? null,
            next_payment_due_date: nextDue,
            minimum_payment_amount: cc.minimum_payment_amount ?? null,
            current_balance: account.balances?.current ?? null,
            credit_limit: account.balances?.limit ?? null,
            purchase_apr: purchaseApr,
            is_overdue: isOverdue,
            last_payment_amount: cc.last_payment_amount ?? null,
            last_payment_date: cc.last_payment_date ?? null,
            updated_at: new Date().toISOString(),
          };

          const { error: upsertError } = await supabase
            .from('card_statements')
            .upsert(row, { onConflict: 'plaid_account_id' });

          if (upsertError) {
            errors.push(`plaid_item ${plaidItemDbId} / account ${cc.account_id}: ${upsertError.message}`);
            continue;
          }

          synced++;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('sync-liabilities failed for item', {
          plaid_item_db_id: plaidItemDbId,
          error_message: msg,
        });
        errors.push(`plaid_item ${plaidItemDbId}: ${msg}`);
      }
    }

    logger.info('sync-liabilities completed', {
      tokens: tokenRows.length,
      synced,
      errors: errors.length,
    });

    return NextResponse.json({ synced, errors });
  } catch (error) {
    logger.error('sync-liabilities cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}

// Vercel Cron only issues GET requests, so mirror POST for the scheduled run.
export const GET = POST;
