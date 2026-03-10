'use client';

import { PlaidLink } from '@/components/plaid-link';

interface Entity {
  id: string;
  name: string;
  type: string;
}

export function ConnectAccountSection({ entities }: { entities: Entity[] }) {
  return (
    <div className="mt-4 rounded-md border border-dashed border-gray-300 p-4">
      <PlaidLink entities={entities} />
    </div>
  );
}
