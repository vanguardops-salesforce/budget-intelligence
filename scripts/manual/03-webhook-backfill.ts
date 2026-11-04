/**
 * Register the webhook URL on Plaid items that predate it.
 *
 * Plaid binds the webhook URL to an item at link time, from
 * `link_token_create`. The eight items created 2026-03-18 were linked before
 * that field was configured, and nothing in the codebase has ever called
 * /item/webhook/update — so they receive no webhooks at all. Every one of the
 * 159 stored webhook events belongs to the single item created 2026-05-29.
 *
 * The practical consequences: the nightly heal sweep is the only thing keeping
 * those items current, and the ITEM/ERROR path that marks an item
 * `reauth_required` can never fire for them — which is how Amex 18dedaa2
 * retried a login failure 39 times without ever escalating.
 *
 * This is a WRITE against production Plaid items. It is deliberately dry-run
 * by default and prints exactly what it would change.
 *
 *   # 1. Review the plan (no writes):
 *   npx tsx --env-file=.env.local scripts/manual/03-webhook-backfill.ts
 *
 *   # 2. Apply, after reading the plan:
 *   npx tsx --env-file=.env.local scripts/manual/03-webhook-backfill.ts --apply
 *
 *   # Single item:
 *   npx tsx --env-file=.env.local scripts/manual/03-webhook-backfill.ts --apply <plaid_item_uuid>
 *
 * Safe to re-run: /item/webhook/update is idempotent for a given URL. Plaid
 * sends a WEBHOOK_UPDATE_ACKNOWLEDGED event to the new URL on success, which
 * the processor now classifies as a recognised no-op.
 *
 * Note: this does NOT backfill missed history. It only makes future webhooks
 * arrive. The nightly heal sweep already covers the gap.
 */

import { createClient } from '@supabase/supabase-js';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createDecipheriv, scryptSync } from 'crypto';

const {
  NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_APP_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PLAID_CLIENT_ID,
  PLAID_SECRET,
  PLAID_ENV,
  ENCRYPTION_KEY,
} = process.env;

for (const [name, value] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_APP_URL,
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

const WEBHOOK_URL = `${NEXT_PUBLIC_APP_URL}/api/plaid/webhook`;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const onlyItem = args.find((a) => !a.startsWith('--'));

  console.log(`Plaid environment : ${PLAID_ENV}`);
  console.log(`Webhook URL       : ${WEBHOOK_URL}`);
  console.log(`Mode              : ${apply ? 'APPLY (writes to Plaid)' : 'DRY RUN (no writes)'}\n`);

  if (!WEBHOOK_URL.startsWith('https://')) {
    console.error('Refusing to continue: Plaid requires an https webhook URL.');
    console.error(`NEXT_PUBLIC_APP_URL is currently "${NEXT_PUBLIC_APP_URL}".`);
    process.exit(2);
  }

  let query = supabase
    .from('plaid_items')
    .select('id, institution_name, status, created_at')
    .order('created_at');
  if (onlyItem) query = query.eq('id', onlyItem);

  const { data: items, error } = await query;
  if (error) throw new Error(`Failed to list plaid_items: ${error.message}`);
  if (!items?.length) {
    console.log('No plaid_items matched.');
    return;
  }

  // How many webhook events has each item ever received? Zero is the signal
  // that its webhook URL was never registered.
  const { data: eventRows, error: eventError } = await supabase
    .from('plaid_webhook_events')
    .select('plaid_item_id');
  if (eventError) throw new Error(`Failed to count webhook events: ${eventError.message}`);

  const eventCounts = new Map<string, number>();
  for (const row of eventRows ?? []) {
    const id = row.plaid_item_id as string;
    eventCounts.set(id, (eventCounts.get(id) ?? 0) + 1);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    const seen = eventCounts.get(item.id) ?? 0;
    const label =
      `${(item.institution_name ?? 'Unknown').padEnd(28)} ${item.id.slice(0, 8)} ` +
      `linked ${String(item.created_at).slice(0, 10)}  events=${String(seen).padStart(3)}`;

    if (seen > 0) {
      console.log(`SKIP    ${label}  — already receiving webhooks`);
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`WOULD   ${label}  — would register webhook URL`);
      updated++;
      continue;
    }

    try {
      const { data: encrypted, error: tokenError } = await supabase.rpc('get_plaid_token', {
        p_plaid_item_id: item.id,
      });
      if (tokenError || !encrypted) throw new Error(tokenError?.message ?? 'no token');

      await plaid.itemWebhookUpdate({
        access_token: decrypt(encrypted),
        webhook: WEBHOOK_URL,
      });

      console.log(`UPDATED ${label}`);
      updated++;
    } catch (err) {
      const code =
        (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ??
        String(err);
      console.log(`FAILED  ${label}  — ${code}`);
      failed++;
    }
  }

  console.log(
    `\n${apply ? 'Updated' : 'Would update'}: ${updated}   Skipped: ${skipped}   Failed: ${failed}`
  );

  if (!apply && updated > 0) {
    console.log('\nRe-run with --apply to perform these updates.');
  }
  if (apply && updated > 0) {
    console.log(
      '\nPlaid sends WEBHOOK_UPDATE_ACKNOWLEDGED to the new URL on success. ' +
        'Confirm with:\n' +
        "  SELECT plaid_item_id, webhook_type, webhook_code, created_at\n" +
        '  FROM plaid_webhook_events ORDER BY created_at DESC LIMIT 20;'
    );
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
