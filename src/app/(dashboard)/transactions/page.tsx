import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function TransactionsPage() {
  const supabase = createServerSupabaseClient();

  const { data: transactions } = await supabase
    .from('transactions')
    .select('id, amount, date, merchant_name, plaid_category, is_recurring')
    .is('deleted_at', null)
    .order('date', { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">Transactions</h2>

      <div className="rounded-lg border bg-white">
        {/* Search bar - Phase 3 will make interactive */}
        <div className="border-b px-6 py-4">
          <input
            type="text"
            placeholder="Search transactions..."
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            disabled
          />
        </div>

        {(!transactions || transactions.length === 0) ? (
          <div className="p-6">
            <p className="text-sm text-gray-500">
              No transactions yet. Connect a bank account via Plaid to start syncing.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-medium uppercase text-gray-500">
                <tr>
                  <th className="px-6 py-3">Date</th>
                  <th className="px-6 py-3">Merchant</th>
                  <th className="px-6 py-3">Category</th>
                  <th className="px-6 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-6 py-3 text-gray-500">{tx.date}</td>
                    <td className="px-6 py-3 font-medium text-gray-900">
                      {tx.merchant_name ?? 'Unknown'}
                      {tx.is_recurring && (
                        <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                          recurring
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-gray-500">
                      {Array.isArray(tx.plaid_category) ? tx.plaid_category.join(' > ') : '—'}
                    </td>
                    <td className={`whitespace-nowrap px-6 py-3 text-right font-medium ${tx.amount < 0 ? 'text-green-600' : 'text-gray-900'}`}>
                      ${Math.abs(tx.amount).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
