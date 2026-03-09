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
import { formatCurrency, formatDate, maskAccount } from '@/lib/format';
import { Search, ArrowUpDown, RefreshCw } from 'lucide-react';

interface Transaction {
  id: string;
  amount: number;
  date: string;
  merchant_name: string | null;
  plaid_category: string[] | null;
  user_category_id: string | null;
  is_recurring: boolean;
  account_id: string;
}

interface Account {
  id: string;
  name: string;
  mask: string | null;
  type: string;
}

interface BudgetCategory {
  id: string;
  name: string;
}

interface TransactionTableProps {
  transactions: Transaction[];
  accounts: Account[];
  categories: BudgetCategory[];
}

export function TransactionTable({ transactions, accounts, categories }: TransactionTableProps) {
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<'date' | 'amount'>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const router = useRouter();

  const accountMap = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts]
  );

  const categoryMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  );

  const filtered = useMemo(() => {
    let result = transactions;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (tx) =>
          (tx.merchant_name?.toLowerCase().includes(q)) ||
          (tx.plaid_category?.some((c) => c.toLowerCase().includes(q))) ||
          (accountMap.get(tx.account_id)?.name.toLowerCase().includes(q))
      );
    }
    result = [...result].sort((a, b) => {
      if (sortField === 'date') {
        return sortDir === 'desc'
          ? b.date.localeCompare(a.date)
          : a.date.localeCompare(b.date);
      }
      return sortDir === 'desc'
        ? Math.abs(b.amount) - Math.abs(a.amount)
        : Math.abs(a.amount) - Math.abs(b.amount);
    });
    return result;
  }, [transactions, search, sortField, sortDir, accountMap]);

  function toggleSort(field: 'date' | 'amount') {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  async function handleCategoryChange(txId: string, categoryId: string) {
    setUpdatingId(txId);
    try {
      const res = await fetch('/api/transactions/category', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: txId,
          category_id: categoryId || null,
        }),
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search by merchant, category, or account..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border bg-background py-2 pl-10 pr-4 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Results count */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {filtered.length} transaction{filtered.length !== 1 ? 's' : ''}
          {search && ` matching "${search}"`}
        </p>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {transactions.length === 0
              ? 'No transactions yet. Connect a bank account via Plaid to start syncing.'
              : 'No transactions match your search.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <button
                    onClick={() => toggleSort('date')}
                    className="flex items-center gap-1 text-xs font-medium uppercase"
                  >
                    Date
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead className="hidden sm:table-cell">Account</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">
                  <button
                    onClick={() => toggleSort('amount')}
                    className="ml-auto flex items-center gap-1 text-xs font-medium uppercase"
                  >
                    Amount
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((tx) => {
                const account = accountMap.get(tx.account_id);
                const userCategory = tx.user_category_id
                  ? categoryMap.get(tx.user_category_id)
                  : null;
                const isUpdating = updatingId === tx.id;

                return (
                  <TableRow key={tx.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(tx.date)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {tx.merchant_name ?? 'Unknown'}
                        </span>
                        {tx.is_recurring && (
                          <Badge variant="secondary" className="text-[10px]">
                            <RefreshCw className="mr-1 h-2.5 w-2.5" />
                            recurring
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {account
                        ? `${account.name} ${maskAccount(account.mask, '')}`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <select
                        value={tx.user_category_id ?? ''}
                        onChange={(e) => handleCategoryChange(tx.id, e.target.value)}
                        disabled={isUpdating}
                        className="max-w-[160px] truncate rounded border bg-background px-2 py-1 text-xs focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      >
                        <option value="">
                          {Array.isArray(tx.plaid_category)
                            ? tx.plaid_category.join(' > ')
                            : 'Uncategorized'}
                        </option>
                        {categories.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name}
                          </option>
                        ))}
                      </select>
                      {userCategory && (
                        <span className="ml-1 text-[10px] text-green-600">
                          (override)
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={`whitespace-nowrap text-right font-semibold tabular-nums ${
                        tx.amount < 0 ? 'text-green-600' : ''
                      }`}
                    >
                      {tx.amount < 0 ? '+' : '-'}{formatCurrency(Math.abs(tx.amount))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
