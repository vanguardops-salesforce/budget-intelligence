'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/format';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  ExternalLink,
  Clock,
  Wifi,
  WifiOff,
} from 'lucide-react';

interface PlaidItem {
  id: string;
  institution_name: string | null;
  status: string;
  last_successful_sync: string | null;
  last_error_code: string | null;
  error_count: number;
  consent_expiration: string | null;
}

interface ConnectionHealthProps {
  plaidItems: PlaidItem[];
}

/**
 * Connection health indicator showing Plaid item status,
 * last sync time, and a re-link button for items in error state.
 */
export function ConnectionHealth({ plaidItems }: ConnectionHealthProps) {
  const [relinkingId, setRelinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleRelink = useCallback(async (plaidItemId: string) => {
    setRelinkingId(plaidItemId);
    setError(null);

    try {
      // 1. Get a re-link token
      const tokenRes = await fetch('/api/plaid/create-relink-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plaid_item_id: plaidItemId }),
      });

      if (!tokenRes.ok) {
        const data = await tokenRes.json();
        throw new Error(data.error || 'Failed to create re-link token.');
      }

      const { link_token } = await tokenRes.json();

      // 2. Open Plaid Link in update mode
      await openPlaidLinkForReauth(link_token);

      // 3. On success, mark item as re-connected on backend
      // (Plaid handles this automatically via webhook — the update mode flow
      // sends an ITEM webhook with code LOGIN_REPAIRED)
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-link failed.');
    } finally {
      setRelinkingId(null);
    }
  }, [router]);

  if (plaidItems.length === 0) {
    return null;
  }

  const healthyCount = plaidItems.filter((i) => i.status === 'connected').length;
  const errorCount = plaidItems.filter((i) => i.status !== 'connected').length;

  // Overall health status
  const overallStatus = errorCount === 0 ? 'healthy' : errorCount === plaidItems.length ? 'critical' : 'degraded';

  const statusConfig = {
    healthy: { icon: Wifi, color: 'text-green-600', bg: 'bg-green-50 border-green-200', label: 'All Connected' },
    degraded: { icon: AlertTriangle, color: 'text-yellow-600', bg: 'bg-yellow-50 border-yellow-200', label: `${errorCount} Need${errorCount === 1 ? 's' : ''} Attention` },
    critical: { icon: WifiOff, color: 'text-red-600', bg: 'bg-red-50 border-red-200', label: 'All Disconnected' },
  };

  const config = statusConfig[overallStatus];
  const OverallIcon = config.icon;

  return (
    <div className="space-y-3">
      {/* Overall health summary */}
      <div className={`flex items-center gap-3 rounded-lg border p-3 ${config.bg}`}>
        <OverallIcon className={`h-5 w-5 shrink-0 ${config.color}`} />
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium ${config.color}`}>{config.label}</p>
          <p className="text-xs text-muted-foreground">
            {healthyCount} of {plaidItems.length} institution{plaidItems.length !== 1 ? 's' : ''} connected
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Per-institution status */}
      <div className="space-y-2">
        {plaidItems.map((item) => {
          const isHealthy = item.status === 'connected';
          const needsReauth = item.status === 'reauth_required';
          const isDegraded = item.status === 'degraded';
          const isDisconnected = item.status === 'disconnected';
          const isRelinking = relinkingId === item.id;

          // Check consent expiration
          const consentExpiring = item.consent_expiration
            ? new Date(item.consent_expiration).getTime() - Date.now() < 7 * 86_400_000
            : false;

          return (
            <div
              key={item.id}
              className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                {/* Status icon */}
                <div className="mt-0.5 shrink-0">
                  {isHealthy ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : needsReauth ? (
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                  ) : isDegraded ? (
                    <AlertTriangle className="h-4 w-4 text-orange-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium leading-none truncate">
                      {item.institution_name ?? 'Unknown Institution'}
                    </p>
                    <ItemStatusBadge status={item.status} />
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Last sync:{' '}
                      {item.last_successful_sync
                        ? formatRelativeTime(item.last_successful_sync)
                        : 'Never'}
                    </span>

                    {item.last_error_code && (
                      <span className="text-destructive">
                        Error: {item.last_error_code}
                        {item.error_count > 1 && ` (${item.error_count} failures)`}
                      </span>
                    )}

                    {consentExpiring && (
                      <span className="text-yellow-600">
                        Consent expiring soon
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Re-link button for items that need attention */}
              {(needsReauth || isDegraded || isDisconnected || consentExpiring) && (
                <button
                  onClick={() => handleRelink(item.id)}
                  disabled={isRelinking}
                  className="inline-flex items-center gap-1.5 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-1.5 text-xs font-medium text-yellow-800 hover:bg-yellow-100 disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
                >
                  {isRelinking ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Re-linking...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="h-3.5 w-3.5" />
                      Re-link Account
                    </>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ItemStatusBadge({ status }: { status: string }) {
  const config: Record<string, { variant: 'success' | 'warning' | 'danger' | 'secondary'; label: string }> = {
    connected: { variant: 'success', label: 'Connected' },
    degraded: { variant: 'warning', label: 'Degraded' },
    disconnected: { variant: 'danger', label: 'Disconnected' },
    reauth_required: { variant: 'warning', label: 'Re-auth Required' },
  };

  const { variant, label } = config[status] ?? { variant: 'secondary' as const, label: status };

  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * Open Plaid Link in update/re-auth mode.
 */
function openPlaidLinkForReauth(linkToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const plaidWindow = window as Window & {
      Plaid?: {
        create: (config: {
          token: string;
          onSuccess: () => void;
          onExit: (err: unknown) => void;
        }) => { open: () => void; destroy: () => void };
      };
    };

    function createReauthHandler() {
      const plaid = plaidWindow.Plaid;
      if (!plaid) {
        reject(new Error('Plaid Link not available.'));
        return;
      }

      const handler = plaid.create({
        token: linkToken,
        onSuccess: () => {
          resolve();
          handler.destroy();
        },
        onExit: (err) => {
          if (err) {
            reject(new Error('Re-authentication cancelled.'));
          } else {
            resolve(); // User closed voluntarily — not an error
          }
          handler.destroy();
        },
      });

      handler.open();
    }

    if (plaidWindow.Plaid) {
      createReauthHandler();
      return;
    }

    // Load Plaid script if not already loaded
    const script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.onload = () => createReauthHandler();
    script.onerror = () => reject(new Error('Failed to load Plaid Link script.'));
    document.head.appendChild(script);
  });
}
