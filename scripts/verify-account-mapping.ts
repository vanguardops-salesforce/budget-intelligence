/**
 * Read-only: compare Plaid's current account_ids against `accounts` rows.
 *
 * This is the check that could not be run from the diagnosis session, which
 * had no Plaid credentials. The server-side request log already proved the
 * mechanism — on 2026-09-22 Capital One item ccffe6d8 made a GET on accounts,
 * then no POST to transactions and no PATCH to accounts, then PATCHed the
 * cursor — but only a live Plaid call can show which account_ids the item
 * actually returns now.
 *
 * Makes no writes: /accounts/get on the Plaid side, SELECT on ours.
 *
 * Usage, from the repo root with .env.local populated:
 *
 *   npx tsx --env-file=.env.local scripts/verify-account-mapping.ts
 *   npx tsx --env-file=.env.local scripts/verify-account-mapping.ts ccffe6d8-3b5c-4da5-a02b-c166359b436e
 *
 * With no argument every plaid_item is checked. Exits non-zero if any item has
 * an account Plaid knows about that we do not.
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

/**
 * Mirrors src/lib/crypto.ts exactly: AES-256-GCM over `iv:authTag:ciphertext`
 * (all hex), with the key derived via scrypt — NOT the raw ENCRYPTION_KEY
 * bytes. Kept in step with that module; if it changes, change this too.
 */
const CRYPTO_SALT = 'budget-intel-salt';

function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext');
  }
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

async function main() {
  const only = process.argv[2];

  let query = supabase
    .from('plaid_items')
    .select('id, institution_name, status')
    .order('created_at');
  if (only) query = query.eq('id', only);

  const { data: items, error } = await query;
  if (error) throw new Error(`Failed to list plaid_items: ${error.message}`);
  if (!items?.length) {
    console.log('No plaid_items matched.');
    return;
  }

  let mismatches = 0;

  for (const item of items) {
    const label = `${item.institution_name ?? 'Unknown'} (${item.id.slice(0, 8)}, ${item.status})`;

    const { data: rows, error: acctError } = await supabase
      .from('accounts')
      .select('id, name, mask, plaid_account_id, deleted_at')
      .eq('plaid_item_id', item.id);

    if (acctError) {
      console.error(`${label}: failed to read accounts — ${acctError.message}`);
      continue;
    }

    const stored = new Map(
      (rows ?? [])
        .filter((r) => !r.deleted_at)
        .map((r) => [r.plaid_account_id as string, r])
    );

    let plaidAccounts;
    try {
      const { data: encrypted, error: tokenError } = await supabase.rpc('get_plaid_token', {
        p_plaid_item_id: item.id,
      });
      if (tokenError || !encrypted) throw new Error(tokenError?.message ?? 'no token');

      const response = await plaid.accountsGet({ access_token: decrypt(encrypted) });
      plaidAccounts = response.data.accounts;
    } catch (err) {
      const code =
        (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
        String(err);
      console.log(`\n${label}\n  SKIPPED — Plaid call failed: ${code}`);
      continue;
    }

    const live = new Set(plaidAccounts.map((a) => a.account_id));
    const missing = plaidAccounts.filter((a) => !stored.has(a.account_id));
    const orphaned = [...stored.entries()].filter(([id]) => !live.has(id));

    const status = missing.length > 0 ? 'MISMATCH' : 'ok';
    console.log(`\n${label}\n  ${status} — ${live.size} at Plaid, ${stored.size} stored`);

    for (const a of missing) {
      console.log(
        `  MISSING  ${a.account_id}  "${a.name}" ····${a.mask ?? '????'} (${a.type}) ` +
          '— Plaid returns this, we have no row: its transactions cannot be mapped'
      );
    }
    for (const [id, row] of orphaned) {
      console.log(
        `  ORPHAN   ${id}  "${row.name}" ····${row.mask ?? '????'} ` +
          '— stored but Plaid no longer returns it (likely a reissued id)'
      );
    }

    if (missing.length > 0) mismatches++;
  }

  console.log(
    mismatches > 0
      ? `\n${mismatches} item(s) have accounts Plaid knows about that we do not. ` +
          'Their transactions are unmappable until the accounts are created — ' +
          'a deployed sync will now create them automatically on its next run.'
      : '\nAll items map cleanly.'
  );

  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
