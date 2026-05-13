import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { getSecrets } from '../env';
import { logger } from '../logger';

let _plaidClient: PlaidApi | null = null;

/**
 * Singleton Plaid API client. Server-only.
 * Reads PLAID_ENV from validated environment secrets.
 * Valid values: "sandbox", "development", "production".
 */
export function getPlaidClient(): PlaidApi {
  if (_plaidClient) return _plaidClient;

  const secrets = getSecrets();
  const env = secrets.PLAID_ENV;

  logger.info('Initializing Plaid client', { plaid_env: env });

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
