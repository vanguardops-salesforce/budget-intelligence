export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { DashboardShell } from '@/components/dashboard-shell';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Fetch entities for the selector
  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, type')
    .eq('is_active', true)
    .order('name');

  return (
    <DashboardShell entities={entities ?? []} userEmail={user.email ?? ''}>
      {children}
    </DashboardShell>
  );
}
