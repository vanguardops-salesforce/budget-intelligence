'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface PlaidLinkProps {
  entities: Array<{ id: string; name: string; type: string }>;
}

/**
 * Plaid Link component.
 * Handles the full Link flow:
 * 1. User selects an entity and clicks "Connect Account"
 * 2. We create a link_token via our API
 * 3. Plaid Link opens in an iframe
 * 4. On success, we exchange the public_token via our API
 * 5. The page refreshes to show the new connection
 *
 * Uses the Plaid Link drop-in script (loaded from CDN via CSP allowlist).
 */
export function PlaidLink({ entities }: PlaidLinkProps) {
  const [selectedEntity, setSelectedEntity] = useState(entities[0]?.id || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const router = useRouter();

  const handleConnect = useCallback(async () => {
    if (!selectedEntity) {
      setError('Please select an entity first.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // 1. Create link token
      const linkRes = await fetch('/api/plaid/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: selectedEntity }),
      });

      if (!linkRes.ok) {
        const data = await linkRes.json();
        throw new Error(data.error || 'Failed to create link token.');
      }

      const { link_token } = await linkRes.json();

      // 2. Open Plaid Link
      const plaidResult = await openPlaidLink(link_token);

      if (!plaidResult) {
        // User closed the modal
        setLoading(false);
        return;
      }

      // 3. Exchange public token
      const exchangeRes = await fetch('/api/plaid/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_token: plaidResult.public_token,
          entity_id: selectedEntity,
          institution: plaidResult.institution,
        }),
      });

      if (!exchangeRes.ok) {
        const data = await exchangeRes.json();
        throw new Error(data.error || 'Failed to link account.');
      }

      const exchangeData = await exchangeRes.json();
      setSuccess(`Connected ${exchangeData.institution_name || 'account'} successfully!`);

      // Refresh the page to show the new connection
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [selectedEntity, router]);

  if (entities.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        Create entities first (run seed SQL) before connecting accounts.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="entity-select" className="block text-sm font-medium text-gray-700">
            Entity
          </label>
          <select
            id="entity-select"
            value={selectedEntity}
            onChange={(e) => setSelectedEntity(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.name} ({entity.type})
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={handleConnect}
          disabled={loading || !selectedEntity}
          className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Connecting...
            </>
          ) : (
            'Connect Account'
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {success && (
        <div className="rounded-md bg-green-50 p-3">
          <p className="text-sm text-green-700">{success}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Open Plaid Link using the drop-in handler.
 * Returns the public_token and institution on success, or null if the user exits.
 */
function openPlaidLink(
  linkToken: string
): Promise<{ public_token: string; institution: { name: string; institution_id: string } } | null> {
  return new Promise((resolve, reject) => {
    // Check if Plaid script is already loaded
    if (typeof window !== 'undefined' && (window as PlaidWindow).Plaid) {
      createHandler(linkToken, resolve, reject);
      return;
    }

    // Dynamically load the Plaid Link script
    const script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.onload = () => createHandler(linkToken, resolve, reject);
    script.onerror = () => reject(new Error('Failed to load Plaid Link script.'));
    document.head.appendChild(script);
  });
}

interface PlaidWindow extends Window {
  Plaid?: {
    create: (config: PlaidHandlerConfig) => { open: () => void; destroy: () => void };
  };
}

interface PlaidHandlerConfig {
  token: string;
  onSuccess: (public_token: string, metadata: PlaidSuccessMetadata) => void;
  onExit: (err: unknown) => void;
}

interface PlaidSuccessMetadata {
  institution: { name: string; institution_id: string };
}

function createHandler(
  linkToken: string,
  resolve: (value: { public_token: string; institution: { name: string; institution_id: string } } | null) => void,
  reject: (error: Error) => void
) {
  const plaid = (window as PlaidWindow).Plaid;
  if (!plaid) {
    reject(new Error('Plaid Link not available.'));
    return;
  }

  const handler = plaid.create({
    token: linkToken,
    onSuccess: (public_token, metadata) => {
      resolve({
        public_token,
        institution: metadata.institution,
      });
      handler.destroy();
    },
    onExit: (err) => {
      if (err) {
        reject(new Error('Plaid Link error.'));
      } else {
        resolve(null); // User closed voluntarily
      }
      handler.destroy();
    },
  });

  handler.open();
}
