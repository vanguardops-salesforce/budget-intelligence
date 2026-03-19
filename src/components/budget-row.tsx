'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { Pencil, Check, X } from 'lucide-react';

interface BudgetRowProps {
  id: string;
  name: string;
  spent: number;
  budget: number;
  pct: number;
  remaining: number;
  overBudget: boolean;
  rationale: string | null;
}

export function BudgetRow({ id, name, spent, budget, pct, remaining, overBudget, rationale }: BudgetRowProps) {
  const [editing, setEditing] = useState(false);
  const [newAmount, setNewAmount] = useState(String(budget));
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/budget/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_id: id,
          monthly_budget_amount: parseFloat(newAmount) || 0,
        }),
      });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setNewAmount(String(budget));
    setEditing(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {overBudget && (
            <Badge variant="danger" className="text-[10px]">Over</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold tabular-nums">
                {formatCurrency(spent)} /
              </span>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  value={newAmount}
                  onChange={(e) => setNewAmount(e.target.value)}
                  className="w-24 rounded border bg-background px-2 py-1 text-sm text-right tabular-nums focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') handleCancel();
                  }}
                />
              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded p-1 text-green-600 hover:bg-green-50 disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                onClick={handleCancel}
                className="rounded p-1 text-red-600 hover:bg-red-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold tabular-nums">
                {formatCurrency(spent)}
              </span>
              <span className="text-sm text-muted-foreground">
                {' / '}{budget > 0 ? formatCurrency(budget) : 'No budget'}
              </span>
              <button
                onClick={() => setEditing(true)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Edit budget"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
      <Progress
        value={pct}
        className="h-2.5"
        indicatorClassName={
          overBudget
            ? 'bg-destructive'
            : pct > 80
            ? 'bg-yellow-500'
            : 'bg-green-500'
        }
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{pct}% used</span>
        <span>
          {remaining >= 0
            ? `${formatCurrency(remaining)} remaining`
            : `${formatCurrency(Math.abs(remaining))} over`}
        </span>
      </div>
      {rationale && (
        <p className="text-xs text-muted-foreground italic">{rationale}</p>
      )}
    </div>
  );
}
