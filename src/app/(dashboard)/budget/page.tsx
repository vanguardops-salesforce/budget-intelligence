import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function BudgetPage() {
  const supabase = createServerSupabaseClient();

  const { data: categories } = await supabase
    .from('budget_categories')
    .select('id, name, entity_id, monthly_budget_amount, is_active')
    .eq('is_active', true)
    .order('name');

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">Budget</h2>

      {(!categories || categories.length === 0) ? (
        <div className="rounded-lg border bg-white p-6">
          <p className="text-sm text-gray-500">
            No budget categories configured. Run the seed SQL to create default categories.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-white">
          <div className="border-b px-6 py-4">
            <h3 className="text-lg font-medium text-gray-900">Budget vs Actual</h3>
            <p className="text-sm text-gray-500">Monthly budget tracking by category</p>
          </div>
          <div className="divide-y">
            {categories.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between px-6 py-4">
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{cat.name}</p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    {/* Phase 3: Wire up actual spending percentage */}
                    <div className="h-full w-0 rounded-full bg-blue-500 transition-all" />
                  </div>
                </div>
                <div className="ml-4 text-right">
                  <p className="text-sm font-medium text-gray-900">
                    $0 / ${cat.monthly_budget_amount?.toLocaleString() ?? '—'}
                  </p>
                  <p className="text-xs text-gray-500">remaining</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
