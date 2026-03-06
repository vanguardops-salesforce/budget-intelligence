import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function PortfolioPage() {
  const supabase = createServerSupabaseClient();

  const { data: holdings } = await supabase
    .from('holdings')
    .select('id, security_name, ticker, quantity, price, value, cost_basis')
    .is('deleted_at', null)
    .order('value', { ascending: false });

  const totalValue = holdings?.reduce((sum, h) => sum + (h.value ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">Portfolio</h2>

      {/* Summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-5">
          <p className="text-sm font-medium text-gray-500">Total Portfolio Value</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-5">
          <p className="text-sm font-medium text-gray-500">Positions</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{holdings?.length ?? 0}</p>
        </div>
        <div className="rounded-lg border bg-white p-5">
          <p className="text-sm font-medium text-gray-500">Last Updated</p>
          <p className="mt-1 text-sm text-gray-400">—</p>
        </div>
      </div>

      {/* Holdings table */}
      <div className="rounded-lg border bg-white">
        <div className="border-b px-6 py-4">
          <h3 className="text-lg font-medium text-gray-900">Holdings</h3>
          <p className="text-xs text-gray-400">READ-ONLY snapshot from Plaid. No trade execution.</p>
        </div>

        {(!holdings || holdings.length === 0) ? (
          <div className="p-6">
            <p className="text-sm text-gray-500">
              No holdings data. Connect an investment account via Plaid.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-medium uppercase text-gray-500">
                <tr>
                  <th className="px-6 py-3">Security</th>
                  <th className="px-6 py-3">Ticker</th>
                  <th className="px-6 py-3 text-right">Shares</th>
                  <th className="px-6 py-3 text-right">Price</th>
                  <th className="px-6 py-3 text-right">Value</th>
                  <th className="px-6 py-3 text-right">Gain/Loss</th>
                  <th className="px-6 py-3 text-right">Allocation</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {holdings.map((h) => {
                  const gainLoss = h.cost_basis ? h.value - h.cost_basis : null;
                  const allocation = totalValue > 0 ? (h.value / totalValue * 100) : 0;
                  return (
                    <tr key={h.id} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-gray-900">{h.security_name}</td>
                      <td className="px-6 py-3 text-gray-500">{h.ticker ?? '—'}</td>
                      <td className="px-6 py-3 text-right text-gray-500">{h.quantity}</td>
                      <td className="px-6 py-3 text-right text-gray-500">${h.price.toFixed(2)}</td>
                      <td className="px-6 py-3 text-right font-medium text-gray-900">
                        ${h.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className={`px-6 py-3 text-right font-medium ${
                        gainLoss === null ? 'text-gray-400' :
                        gainLoss >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {gainLoss !== null ? `$${gainLoss.toFixed(2)}` : '—'}
                      </td>
                      <td className="px-6 py-3 text-right text-gray-500">
                        {allocation.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
