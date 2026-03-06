import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const supabase = createServerSupabaseClient();

  // Fetch summary data (Phase 3 will wire these to real data)
  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, type')
    .eq('is_active', true);

  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, name, type, current_balance, mask, is_active')
    .eq('is_active', true)
    .is('deleted_at', null);

  const { data: plaidItems } = await supabase
    .from('plaid_items')
    .select('id, institution_name, status, last_successful_sync');

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">Overview</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Net Worth" value="--" subtitle="Connect accounts to see" />
        <SummaryCard title="Total Cash" value="--" subtitle="Across all accounts" />
        <SummaryCard title="MTD Spending" value="--" subtitle="This month" />
        <SummaryCard title="Forecast" value="--" subtitle="30-day projection" />
      </div>

      {/* Connection status */}
      <div className="rounded-lg border bg-white p-6">
        <h3 className="text-lg font-medium text-gray-900">Connected Accounts</h3>
        {(!plaidItems || plaidItems.length === 0) ? (
          <p className="mt-4 text-sm text-gray-500">
            No accounts connected yet. Use the Plaid Link flow to connect your bank accounts.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {plaidItems.map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {item.institution_name ?? 'Unknown Institution'}
                  </p>
                  <p className="text-xs text-gray-500">
                    Last synced: {item.last_successful_sync
                      ? new Date(item.last_successful_sync).toLocaleString()
                      : 'Never'}
                  </p>
                </div>
                <StatusBadge status={item.status} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Entities */}
      <div className="rounded-lg border bg-white p-6">
        <h3 className="text-lg font-medium text-gray-900">Entities</h3>
        {(!entities || entities.length === 0) ? (
          <p className="mt-4 text-sm text-gray-500">
            No entities configured. Run the seed SQL to create your entities.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {entities.map((entity) => (
              <div key={entity.id} className="rounded-md border p-4">
                <p className="font-medium text-gray-900">{entity.name}</p>
                <p className="text-xs uppercase text-gray-500">{entity.type}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ title, value, subtitle }: { title: string; value: string; subtitle: string }) {
  return (
    <div className="rounded-lg border bg-white p-5">
      <p className="text-sm font-medium text-gray-500">{title}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      <p className="mt-1 text-xs text-gray-400">{subtitle}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    connected: 'bg-green-100 text-green-700',
    degraded: 'bg-yellow-100 text-yellow-700',
    disconnected: 'bg-red-100 text-red-700',
    reauth_required: 'bg-orange-100 text-orange-700',
  };

  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
