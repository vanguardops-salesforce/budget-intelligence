'use client';

import { useState, useCallback } from 'react';

interface PlaidLinkProps {
  entityId: string;
  entityName: string;
  onSuccess?: () => void;
}

/**
 * PlaidLink component — initiates the Plaid Link flow.
 *
 * 1. Calls /api/plaid/create-link-token to get a link_token
 * 2. Opens the Plaid Link modal (via Plaid's CDN script)
 * 3. On success, exchanges the public_token via /api/plaid/exchange-token
 *
 * Uses the Plaid Link drop-in script rather than react-plaid-link
 * to keep the dependency footprint minimal.
 */
export function PlaidLink({ entityId, entityName, onSuccess }: PlaidLinkProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleConnect = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Step 1: Get a link token
      const tokenRes = await fetch('/api/plaid/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entityId }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.json();
        throw new Error(err.error ?? 'Failed to create link token');
      }

      const { link_token } = await tokenRes.json();

      // Step 2: Load Plaid Link script and open modal
      const Plaid = await loadPlaidScript();

      const handler = Plaid.create({
        token: link_token,
        onSuccess: async (publicToken: string, metadata: { institution?: { name?: string } }) => {
          try {
            // Step 3: Exchange public token
            const exchangeRes = await fetch('/api/plaid/exchange-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                public_token: publicToken,
                entity_id: entityId,
                institution_name: metadata.institution?.name,
              }),
            });

            if (!exchangeRes.ok) {
              const err = await exchangeRes.json();
              throw new Error(err.error ?? 'Failed to exchange token');
            }

            setSuccess(true);
            onSuccess?.();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to connect account');
          }
        },
        onExit: (err: { error_message?: string } | null) => {
          setLoading(false);
          if (err) {
            setError(err.error_message ?? 'Connection cancelled');
          }
        },
      });

      handler.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start connection');
      setLoading(false);
    }
  }, [entityId, onSuccess]);

  if (success) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4">
        <p className="text-sm font-medium text-green-800">
          Account connected to {entityName}! Transactions will sync shortly.
        </p>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={handleConnect}
        disabled={loading}
        className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
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
          <>Connect Bank Account</>
        )}
      </button>

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}

// Plaid Link script types
interface PlaidHandler {
  open: () => void;
  exit: () => void;
}

interface PlaidFactory {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void;
    onExit: (err: { error_message?: string } | null) => void;
  }) => PlaidHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidFactory;
  }
}

let plaidScriptPromise: Promise<PlaidFactory> | null = null;

function loadPlaidScript(): Promise<PlaidFactory> {
  if (plaidScriptPromise) return plaidScriptPromise;

  plaidScriptPromise = new Promise((resolve, reject) => {
    if (window.Plaid) {
      resolve(window.Plaid);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.async = true;
    script.onload = () => {
      if (window.Plaid) {
        resolve(window.Plaid);
      } else {
        reject(new Error('Plaid script loaded but Plaid object not found'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load Plaid Link script'));
    document.head.appendChild(script);
  });

  return plaidScriptPromise;
}
