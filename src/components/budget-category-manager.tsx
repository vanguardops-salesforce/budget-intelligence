'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { Plus, Trash2, Pencil, DollarSign } from 'lucide-react';

interface Category {
  id: string;
  entity_id: string;
  name: string;
  monthly_budget_amount: number | null;
  is_active: boolean;
  entity_name: string;
}

interface Entity {
  id: string;
  name: string;
  type: string;
}

interface BudgetCategoryManagerProps {
  categories: Category[];
  entities: Entity[];
}

export function BudgetCategoryManager({ categories, entities }: BudgetCategoryManagerProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formEntity, setFormEntity] = useState(entities[0]?.id || '');
  const [formName, setFormName] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [filterEntity, setFilterEntity] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const router = useRouter();

  const filteredCategories = useMemo(
    () =>
      filterEntity === 'all'
        ? categories
        : categories.filter((c) => c.entity_id === filterEntity),
    [categories, filterEntity]
  );

  const totalBudget = useMemo(
    () =>
      filteredCategories.reduce(
        (sum, c) => sum + (c.is_active ? Number(c.monthly_budget_amount) || 0 : 0),
        0
      ),
    [filteredCategories]
  );

  function resetForm() {
    setFormEntity(entities[0]?.id || '');
    setFormName('');
    setFormAmount('');
    setEditingId(null);
    setShowForm(false);
  }

  function startEdit(category: Category) {
    setEditingId(category.id);
    setFormEntity(category.entity_id);
    setFormName(category.name);
    setFormAmount(
      category.monthly_budget_amount != null
        ? String(category.monthly_budget_amount)
        : ''
    );
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const amount = formAmount.trim() ? Number(formAmount) : null;

      if (editingId) {
        const res = await fetch('/api/budget-categories', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingId,
            name: formName.trim(),
            monthly_budget_amount: amount,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to update category.');
        }
        setSuccessMsg('Category updated.');
      } else {
        const res = await fetch('/api/budget-categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_id: formEntity,
            name: formName.trim(),
            monthly_budget_amount: amount,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create category.');
        }
        setSuccessMsg('Category created.');
      }

      resetForm();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(categoryId: string) {
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/budget-categories', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: categoryId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete category.');
      }
      setSuccessMsg('Category deactivated.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function handleInlineAmountUpdate(categoryId: string, newAmount: string) {
    const amount = newAmount.trim() ? Number(newAmount) : null;
    if (amount !== null && (isNaN(amount) || amount < 0)) return;

    try {
      const res = await fetch('/api/budget-categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: categoryId,
          monthly_budget_amount: amount,
        }),
      });
      if (res.ok) {
        router.refresh();
      }
    } catch {
      // Silently handle — user can retry
    }
  }

  return (
    <div className="space-y-4">
      {/* Action row */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => {
            if (showForm && !editingId) {
              resetForm();
            } else {
              resetForm();
              setShowForm(true);
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          <Plus className="h-4 w-4" />
          New Category
        </button>

        <div className="flex items-center gap-2">
          <label htmlFor="filter-entity" className="text-xs font-medium text-muted-foreground">
            Filter:
          </label>
          <select
            id="filter-entity"
            value={filterEntity}
            onChange={(e) => setFilterEntity(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">All Entities</option>
            {entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.name}
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto flex items-center gap-1.5 text-sm">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">Total Monthly Budget:</span>
          <span className="font-bold tabular-nums">{formatCurrency(totalBudget)}</span>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="rounded-md bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}
      {successMsg && (
        <div className="rounded-md bg-green-50 p-3">
          <p className="text-sm text-green-700">{successMsg}</p>
        </div>
      )}

      {/* Create / Edit form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="space-y-3 rounded-lg border bg-muted/30 p-4"
        >
          <h4 className="text-sm font-semibold">
            {editingId ? 'Edit Category' : 'Create New Category'}
          </h4>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Entity
              </label>
              <select
                value={formEntity}
                onChange={(e) => setFormEntity(e.target.value)}
                disabled={!!editingId}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              >
                {entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.name} ({entity.type})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Category Name
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g., Groceries, Rent, Marketing"
                required
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Monthly Budget ($)
              </label>
              <input
                type="number"
                value={formAmount}
                onChange={(e) => setFormAmount(e.target.value)}
                placeholder="0.00 (optional)"
                min={0}
                step={0.01}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading || !formName.trim()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Saving...' : editingId ? 'Update Category' : 'Create Category'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Categories table */}
      {filteredCategories.length === 0 ? (
        <div className="rounded-lg border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {categories.length === 0
              ? 'No budget categories yet. Create your first category above.'
              : 'No categories match the selected filter.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Monthly Budget</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCategories.map((cat) => (
                <TableRow
                  key={cat.id}
                  className={!cat.is_active ? 'opacity-50' : ''}
                >
                  <TableCell className="font-medium">{cat.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {cat.entity_name}
                  </TableCell>
                  <TableCell>
                    <input
                      type="number"
                      defaultValue={cat.monthly_budget_amount ?? ''}
                      placeholder="No budget"
                      min={0}
                      step={0.01}
                      onBlur={(e) => {
                        const current = cat.monthly_budget_amount;
                        const newVal = e.target.value.trim()
                          ? Number(e.target.value)
                          : null;
                        if (newVal !== current) {
                          handleInlineAmountUpdate(cat.id, e.target.value);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      className="w-28 rounded border bg-background px-2 py-1 text-sm tabular-nums focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={cat.is_active ? 'success' : 'secondary'}>
                      {cat.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => startEdit(cat)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Edit category"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      {cat.is_active && (
                        <button
                          onClick={() => handleDelete(cat.id)}
                          className="rounded p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                          title="Deactivate category"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
