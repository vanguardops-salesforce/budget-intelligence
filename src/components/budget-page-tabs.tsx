'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BarChart3, Settings } from 'lucide-react';

interface BudgetPageTabsProps {
  trackingContent: React.ReactNode;
  setupContent: React.ReactNode;
}

export function BudgetPageTabs({ trackingContent, setupContent }: BudgetPageTabsProps) {
  return (
    <Tabs defaultValue="tracking" className="space-y-4">
      <TabsList>
        <TabsTrigger value="tracking" className="gap-1.5">
          <BarChart3 className="h-4 w-4" />
          Tracking
        </TabsTrigger>
        <TabsTrigger value="setup" className="gap-1.5">
          <Settings className="h-4 w-4" />
          Setup
        </TabsTrigger>
      </TabsList>

      <TabsContent value="tracking">
        {trackingContent}
      </TabsContent>

      <TabsContent value="setup">
        {setupContent}
      </TabsContent>
    </Tabs>
  );
}
