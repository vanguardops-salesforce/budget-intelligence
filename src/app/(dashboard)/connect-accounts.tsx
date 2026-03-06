'use client';

import { useState } from 'react';
import { PlaidLink } from '@/components/plaid-link';

interface Entity {
  id: string;
  name: string;
  type: string;
}

export function ConnectAccountSection({ entities }: { entities: Entity[] }) {
  const [selectedEntity, setSelectedEntity] = useState<string>(entities[0]?.id ?? '');

  const selected = entities.find((e) => e.id === selectedEntity);

  return (
    <div className="mt-4 flex items-center gap-4 rounded-md border border-dashed border-gray-300 p-4">
      <select
        value={selectedEntity}
        onChange={(e) => setSelectedEntity(e.target.value)}
        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {entities.map((entity) => (
          <option key={entity.id} value={entity.id}>
            {entity.name} ({entity.type})
          </option>
        ))}
      </select>

      {selected && (
        <PlaidLink
          entityId={selected.id}
          entityName={selected.name}
          onSuccess={() => window.location.reload()}
        />
      )}
    </div>
  );
}
