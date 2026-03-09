import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { TransactionRulesManager } from '@/components/transaction-rules-manager';
import { Filter } from 'lucide-react';

export default async function RulesPage() {
  const supabase = createServerSupabaseClient();

  const [entitiesRes, categoriesRes, rulesRes] = await Promise.all([
    supabase
      .from('entities')
      .select('id, name, type')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('budget_categories')
      .select('id, name, entity_id')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('transaction_rules')
      .select(`
        id, entity_id, merchant_pattern, category_id, priority, is_active, created_at,
        budget_categories!transaction_rules_category_id_fkey(name),
        entities!transaction_rules_entity_id_fkey(name)
      `)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false }),
  ]);

  const entities = entitiesRes.data ?? [];
  const categories = categoriesRes.data ?? [];
  const rules = (rulesRes.data ?? []).map((rule) => ({
    id: rule.id,
    entity_id: rule.entity_id,
    merchant_pattern: rule.merchant_pattern,
    category_id: rule.category_id,
    priority: rule.priority,
    is_active: rule.is_active,
    created_at: rule.created_at,
    category_name: (rule.budget_categories as unknown as { name: string } | null)?.name ?? 'Unknown',
    entity_name: (rule.entities as unknown as { name: string } | null)?.name ?? 'Unknown',
  }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Transaction Rules</h2>
        <p className="text-muted-foreground">
          Create auto-categorization rules for your merchants. New transactions matching a rule will be automatically categorized.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Filter className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>Auto-Categorization Rules</CardTitle>
              <CardDescription>
                Rules match merchant names using case-insensitive substring matching.
                For example, &quot;WHOLEFDS&quot; will match &quot;WHOLE FOODS MARKET #10847&quot;.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TransactionRulesManager
            rules={rules}
            entities={entities}
            categories={categories}
          />
        </CardContent>
      </Card>
    </div>
  );
}
