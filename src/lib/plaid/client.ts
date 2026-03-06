import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { getSecrets } from '../env';

let _plaidClient: PlaidApi | null = null;

/**
 * Singleton Plaid API client. Server-only.
 * Uses sandbox by default — set PLAID_ENV=development or production when ready.
 */
export function getPlaidClient(): PlaidApi {
  if (_plaidClient) return _plaidClient;

  const secrets = getSecrets();
  const env = process.env.PLAID_ENV || 'sandbox';

  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': secrets.PLAID_CLIENT_ID,
        'PLAID-SECRET': secrets.PLAID_SECRET,
      },
    },
  });

  _plaidClient = new PlaidApi(configuration);
  return _plaidClient;
}
