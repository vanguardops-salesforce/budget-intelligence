'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Account {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  entity_id: string;
}

interface Entity {
  id: string;
  name: string;
  type: string;
}

interface AccountEntityAssignmentProps {
  accounts: Account[];
  entities: Entity[];
}

/**
 * Allows users to reassign linked accounts to different entities.
 * Shown when a new account is linked or in account management.
 */
export function AccountEntityAssignment({ accounts, entities }: AccountEntityAssignmentProps) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleAssign(accountId: string, entityId: string) {
    setUpdating(accountId);
    setError(null);
    setSuccessId(null);

    try {
      const res = await fetch('/api/accounts/assign-entity', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, entity_id: entityId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to reassign account.');
      }

      setSuccessId(accountId);
      setTimeout(() => setSuccessId(null), 2000);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setUpdating(null);
    }
  }

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No accounts linked yet. Connect a bank account first.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="space-y-2">
        {accounts.map((account) => (
          <div
            key={account.id}
            className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">
                {account.name}
                {account.mask && (
                  <span className="ml-1 text-muted-foreground">····{account.mask}</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground capitalize">{account.type}</p>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={account.entity_id}
                onChange={(e) => handleAssign(account.id, e.target.value)}
                disabled={updating === account.id}
                className="h-8 rounded-md border bg-background px-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              >
                {entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.name} ({entity.type})
                  </option>
                ))}
              </select>

              {updating === account.id && (
                <svg className="h-4 w-4 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}

              {successId === account.id && (
                <span className="text-xs text-green-600">Saved</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
