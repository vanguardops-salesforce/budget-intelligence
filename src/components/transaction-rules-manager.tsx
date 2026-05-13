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
import { formatDate } from '@/lib/format';
import { Plus, Trash2, Play, Pencil } from 'lucide-react';

interface Rule {
  id: string;
  entity_id: string;
  merchant_pattern: string;
  category_id: string;
  priority: number;
  is_active: boolean;
  created_at: string;
  category_name: string;
  entity_name: string;
}

interface Entity {
  id: string;
  name: string;
  type: string;
}

interface Category {
  id: string;
  name: string;
  entity_id: string;
}

interface TransactionRulesManagerProps {
  rules: Rule[];
  entities: Entity[];
  categories: Category[];
}

export function TransactionRulesManager({ rules, entities, categories }: TransactionRulesManagerProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formEntity, setFormEntity] = useState(entities[0]?.id || '');
  const [formPattern, setFormPattern] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formPriority, setFormPriority] = useState(0);
  const [loading, setLoading] = useState(false);
  const [applyingRules, setApplyingRules] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const router = useRouter();

  // Filter categories by selected entity
  const filteredCategories = useMemo(
    () => categories.filter((c) => c.entity_id === formEntity),
    [categories, formEntity]
  );

  function resetForm() {
    setFormEntity(entities[0]?.id || '');
    setFormPattern('');
    setFormCategory('');
    setFormPriority(0);
    setEditingId(null);
    setShowForm(false);
  }

  function startEdit(rule: Rule) {
    setEditingId(rule.id);
    setFormEntity(rule.entity_id);
    setFormPattern(rule.merchant_pattern);
    setFormCategory(rule.category_id);
    setFormPriority(rule.priority);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      if (editingId) {
        // Update existing rule
        const res = await fetch('/api/transaction-rules', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: editingId,
            merchant_pattern: formPattern,
            category_id: formCategory,
            priority: formPriority,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to update rule.');
        }
        setSuccessMsg('Rule updated.');
      } else {
        // Create new rule
        const res = await fetch('/api/transaction-rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_id: formEntity,
            merchant_pattern: formPattern,
            category_id: formCategory,
            priority: formPriority,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create rule.');
        }
        setSuccessMsg('Rule created.');
      }

      resetForm();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(ruleId: string) {
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/transaction-rules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ruleId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete rule.');
      }
      setSuccessMsg('Rule deleted.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function handleToggle(ruleId: string, isActive: boolean) {
    try {
      await fetch('/api/transaction-rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ruleId, is_active: !isActive }),
      });
      router.refresh();
    } catch {
      // Silently handle toggle errors
    }
  }

  async function handleApplyRules() {
    setApplyingRules(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/transaction-rules/apply', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to apply rules.');
      }
      setSuccessMsg(`Applied rules to ${data.applied} transaction(s).`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setApplyingRules(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
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
          New Rule
        </button>

        <button
          onClick={handleApplyRules}
          disabled={applyingRules || rules.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          {applyingRules ? 'Applying...' : 'Apply Rules to Existing Transactions'}
        </button>
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
            {editingId ? 'Edit Rule' : 'Create New Rule'}
          </h4>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Entity
              </label>
              <select
                value={formEntity}
                onChange={(e) => {
                  setFormEntity(e.target.value);
                  setFormCategory('');
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
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
                Merchant Pattern
              </label>
              <input
                type="text"
                value={formPattern}
                onChange={(e) => setFormPattern(e.target.value)}
                placeholder="e.g., WHOLEFDS, AMAZON, STARBUCKS"
                required
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Category
              </label>
              <select
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
                required
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">Select category...</option>
                {filteredCategories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
                {filteredCategories.length === 0 && (
                  <option value="" disabled>
                    No categories for this entity
                  </option>
                )}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Priority (higher = first)
              </label>
              <input
                type="number"
                value={formPriority}
                onChange={(e) => setFormPriority(Number(e.target.value))}
                min={0}
                max={1000}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading || !formPattern || !formCategory}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Saving...' : editingId ? 'Update Rule' : 'Create Rule'}
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

      {/* Rules table */}
      {rules.length === 0 ? (
        <div className="rounded-lg border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No rules yet. Create your first auto-categorization rule above.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Example: &quot;WHOLEFDS&quot; → Groceries, &quot;UBER&quot; → Transportation
          </p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Merchant Pattern</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead className="text-center">Priority</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id} className={!rule.is_active ? 'opacity-50' : ''}>
                  <TableCell>
                    <button
                      onClick={() => handleToggle(rule.id, rule.is_active)}
                      title={rule.is_active ? 'Click to disable' : 'Click to enable'}
                    >
                      <Badge variant={rule.is_active ? 'success' : 'secondary'}>
                        {rule.is_active ? 'Active' : 'Disabled'}
                      </Badge>
                    </button>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                      {rule.merchant_pattern}
                    </code>
                  </TableCell>
                  <TableCell className="text-sm">{rule.category_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{rule.entity_name}</TableCell>
                  <TableCell className="text-center text-sm tabular-nums">{rule.priority}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(rule.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => startEdit(rule)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Edit rule"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(rule.id)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                        title="Delete rule"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
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
