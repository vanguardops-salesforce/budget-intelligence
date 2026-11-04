/**
 * Read-only: did Plaid reissue transaction_ids for an item?
 *
 * This is the question that decides whether a cursor reset is safe.
 *
 * Transactions are upserted on `plaid_transaction_id` (UNIQUE), so a replay is
 * idempotent ONLY if Plaid still returns the same transaction_ids it did
 * before. If the 2026-09-21 relink reissued them along with the account_ids,
 * a cursor reset re-pulls the full history under new ids, the upsert matches
 * nothing, and every existing row is duplicated rather than updated.
 *
 * The test: pick a date window where we already hold transactions, ask Plaid
 * for that same window via /transactions/get, and compare the id sets.
 *
 *   high overlap → ids are stable  → cursor reset is idempotent, safe
 *   ~zero overlap → ids were reissued → a reset WILL duplicate; see
 *                   scripts/manual/02-recover-capital-one.sql §E
 *
 * Makes no writes: /transactions/get on the Plaid side, SELECT on ours.
 *
 * Usage, from the repo root with .env.local populated:
 *
 *   npx tsx --env-file=.env.local scripts/probe-transaction-ids.ts ccffe6d8-3b5c-4da5-a02b-c166359b436e
 *
 * Optional second argument widens the comparison window (default 60 days back
 * from the newest transaction we hold for the item):
 *
 *   npx tsx --env-file=.env.local scripts/probe-transaction-ids.ts <item-uuid> 120
 */

import { createClient } from '@supabase/supabase-js';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createDecipheriv, scryptSync } from 'crypto';

const {
  NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PLAID_CLIENT_ID,
  PLAID_SECRET,
  PLAID_ENV,
  ENCRYPTION_KEY,
} = process.env;

for (const [name, value] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PLAID_CLIENT_ID,
  PLAID_SECRET,
  PLAID_ENV,
  ENCRYPTION_KEY,
})) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(2);
  }
}

/** Mirrors src/lib/crypto.ts — scrypt-derived key, iv:authTag:ciphertext hex. */
const CRYPTO_SALT = 'budget-intel-salt';

function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Malformed ciphertext');
  const [ivHex, authTagHex, encrypted] = parts;
  const key = scryptSync(ENCRYPTION_KEY!, CRYPTO_SALT, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}

const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV as keyof typeof PlaidEnvironments],
    baseOptions: {
      headers: { 'PLAID-CLIENT-ID': PLAID_CLIENT_ID!, 'PLAID-SECRET': PLAID_SECRET! },
    },
  })
);

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const itemId = process.argv[2];
  const windowDays = Number(process.argv[3] ?? 60);

  if (!itemId) {
    console.error('Usage: probe-transaction-ids.ts <plaid_item_uuid> [window_days]');
    process.exit(2);
  }

  const { data: item, error: itemError } = await supabase
    .from('plaid_items')
    .select('id, institution_name, status')
    .eq('id', itemId)
    .single();

  if (itemError || !item) {
    console.error(`No plaid_item ${itemId}: ${itemError?.message}`);
    process.exit(2);
  }

  // Our stored transactions for the item, newest first.
  const { data: accounts, error: acctError } = await supabase
    .from('accounts')
    .select('id, name, mask')
    .eq('plaid_item_id', itemId);

  if (acctError) throw new Error(`accounts read failed: ${acctError.message}`);
  const accountIds = (accounts ?? []).map((a) => a.id);

  if (accountIds.length === 0) {
    console.error('Item has no accounts rows — nothing to compare.');
    process.exit(2);
  }

  const { data: stored, error: txnError } = await supabase
    .from('transactions')
    .select('plaid_transaction_id, date')
    .in('account_id', accountIds)
    .order('date', { ascending: false })
    .limit(5000);

  if (txnError) throw new Error(`transactions read failed: ${txnError.message}`);
  if (!stored?.length) {
    console.error('No stored transactions for this item — nothing to compare.');
    process.exit(2);
  }

  const newestStored = stored[0].date as string;
  const endDate = newestStored;
  const startDate = daysBefore(newestStored, windowDays);

  const storedInWindow = new Set(
    stored
      .filter((t) => (t.date as string) >= startDate && (t.date as string) <= endDate)
      .map((t) => t.plaid_transaction_id as string)
  );

  console.log(`Item      : ${item.institution_name ?? 'Unknown'} (${itemId.slice(0, 8)}, ${item.status})`);
  console.log(`Accounts  : ${(accounts ?? []).map((a) => `${a.name} ····${a.mask ?? '????'}`).join(', ')}`);
  console.log(`Window    : ${startDate} → ${endDate} (${windowDays} days)`);
  console.log(`Stored    : ${storedInWindow.size} transaction(s) in window\n`);

  if (storedInWindow.size === 0) {
    console.error('No stored transactions inside the window — widen it with the second argument.');
    process.exit(2);
  }

  // Ask Plaid for the same window.
  const { data: encrypted, error: tokenError } = await supabase.rpc('get_plaid_token', {
    p_plaid_item_id: itemId,
  });
  if (tokenError || !encrypted) {
    console.error(`Could not read token: ${tokenError?.message ?? 'none stored'}`);
    process.exit(2);
  }
  const accessToken = decrypt(encrypted);

  const livePlaidIds = new Set<string>();
  let offset = 0;
  let total = Infinity;

  try {
    while (offset < total) {
      const response = await plaid.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset },
      });
      total = response.data.total_transactions;
      for (const t of response.data.transactions) livePlaidIds.add(t.transaction_id);
      if (response.data.transactions.length === 0) break;
      offset += response.data.transactions.length;
    }
  } catch (err) {
    const code =
      (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
      String(err);
    console.error(`Plaid /transactions/get failed: ${code}`);
    if (code === 'PRODUCT_NOT_READY') {
      console.error('The item is still pulling history — wait a few minutes and re-run.');
    }
    process.exit(2);
  }

  const overlap = [...storedInWindow].filter((id) => livePlaidIds.has(id));
  const overlapPct = (overlap.length / storedInWindow.size) * 100;

  console.log(`Plaid     : ${livePlaidIds.size} transaction(s) in the same window`);
  console.log(`Overlap   : ${overlap.length}/${storedInWindow.size} stored ids still returned by Plaid ` +
    `(${overlapPct.toFixed(1)}%)\n`);

  if (overlapPct >= 90) {
    console.log('VERDICT: transaction_ids are STABLE.');
    console.log('  A cursor reset is idempotent — the replay will update existing rows in');
    console.log('  place via the plaid_transaction_id upsert. Proceed with');
    console.log('  scripts/manual/02-recover-capital-one.sql as written.');
    process.exit(0);
  }

  if (overlapPct <= 10) {
    console.log('VERDICT: transaction_ids were REISSUED.');
    console.log('  A cursor reset WILL duplicate the existing rows — the upsert key no longer');
    console.log('  matches. Do NOT run §D of 02 until you have read §E, which covers this');
    console.log('  case. Duplicates would have to be reconciled against the originals, and');
    console.log('  the originals carry the categorisations.');
    process.exit(1);
  }

  console.log('VERDICT: INCONCLUSIVE — partial overlap.');
  console.log('  This is not a clean reissue or a clean match. Possible causes: pending');
  console.log('  transactions that settled (Plaid replaces the pending id with a posted');
  console.log('  one), or a window that straddles the relink. Re-run with a larger window');
  console.log('  ending before 2026-09-21, and do not reset the cursor until it resolves.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
