export const dynamic = "force-dynamic";

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatCurrency } from '@/lib/format';
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';

// Known subscription services and their expected monthly cost
const KNOWN_SUBSCRIPTIONS: Record<string, { category: 'keep' | 'review' | 'cancel'; note: string }> = {
  'Claude.ai': { category: 'keep', note: 'Primary AI tool — non-negotiable' },
  'Anthropic': { category: 'review', note: 'Separate API charge? Verify not duplicate of Claude.ai' },
  'Fubo': { category: 'review', note: '$90/mo — consider free MLB.TV via T-Mobile instead' },
  'Netflix': { category: 'keep', note: 'Family entertainment' },
  'Spotify': { category: 'keep', note: 'Music streaming' },
  'Audible': { category: 'cancel', note: 'Paused until June 15. Cancel if not using 1+ book/month' },
  'Paramount+': { category: 'cancel', note: 'Rarely used — cancel' },
  'Amazon Prime': { category: 'keep', note: 'Switch to annual ($139/yr) to save $51/yr' },
  'Apple': { category: 'review', note: '3 separate charges ($13 + $8 + $5). Audit in Settings > Apple ID' },
  'Crunch Fitness': { category: 'review', note: 'Double charge? Should be ~$18/mo. Call to investigate' },
  'Crunch Buford': { category: 'review', note: 'Second Crunch location — are you using both?' },
  'Tridot Rundot': { category: 'keep', note: 'Training plan' },
  'Zwift Inc.': { category: 'keep', note: 'Indoor cycling training' },
  'Instant Ink': { category: 'keep', note: 'HP printer ink — trivial cost' },
  'Amazon Alexa Skills': { category: 'review', note: 'What skill is this? $1.60/mo' },
  'GrubHub+': { category: 'review', note: '$10.88/mo — are you using free delivery enough to justify?' },
  'Elevenlabs.io': { category: 'review', note: 'AI voice tool — VD business expense. Still using?' },
  'Skool': { category: 'review', note: '$99/mo VD expense — community platform. Getting value?' },
  'OpenAI': { category: 'keep', note: 'VD business tool — API usage' },
  'Www.perplexity.ai': { category: 'keep', note: 'Research tool — VD business expense' },
  'Workspace': { category: 'keep', note: 'Google Workspace — VD business expense' },
  'Svcskingdomv': { category: 'review', note: 'Kingdom related? Verify what this is' },
  'Lovable': { category: 'review', note: '$25/mo — what is this service?' },
  'Next Insur Gen': { category: 'keep', note: 'Business insurance — VD' },
  'Progressive Insurance': { category: 'keep', note: 'Auto insurance' },
  'State Farm': { category: 'keep', note: 'Property insurance — VCG' },
  'T-Mobile': { category: 'keep', note: 'Phone plan' },
  'Spectrum': { category: 'keep', note: 'Internet' },
  'Sawnee Electric Membersh': { category: 'keep', note: 'Electricity — utility' },
  'City Of Sugar Hill': { category: 'keep', note: 'Water/sewer — utility' },
  'Florida Power & Light': { category: 'keep', note: 'Rental property utility — VCG' },
  'Paulding County': { category: 'keep', note: 'Rental property utility — VCG' },
  'WAVE - *MFNF COACHINRALEIGH': { category: 'review', note: '$210/mo coaching service — getting ROI?' },
  'Anti Acne Club': { category: 'review', note: '$35/mo skincare subscription — still using?' },
  'Nutrafol': { category: 'review', note: '$84/mo hair supplement — is it working?' },
  'Methodiq Health': { category: 'review', note: '$24/mo — what is this?' },
  'Interest Charge on Purchases': { category: 'cancel', note: 'Credit card interest! You should be paying in full' },
  'INTEREST CHARGE:PURCHASES': { category: 'cancel', note: 'Credit card interest! Pay off before statement close' },
  'Interest on Purchases': { category: 'cancel', note: 'Credit card interest — should be $0' },
};

// Merchants that are NOT subscriptions (shopping/groceries/dining)
const NOT_SUBSCRIPTIONS = [
  'Costco', 'Instacart', 'Publix', 'Kroger', 'Kroger Fuel', 'Target', 'Amazon',
  'The Home Depot', 'PetSmart', 'Poshmark', 'Marshalls', 'Kohl\'s', 'Wayfair',
  'Chick-fil-A', 'Uber Eats', 'The Human Bean', 'California Hand Wash',
  'Venmo', 'North Point Community Ch', 'Transit North Point Community Church',
  'ACH Transaction', 'CAPITAL ONE MOBILE PMT', 'NBS', 'AMC Theatres',
  'Gc Dwr Auto', 'Sinsa Beauty', 'Thryv Medical', 'Sugar Hill Spine',
  'Ketone-iq', 'Im8 Health', 'Rho Nutrition', 'Nutrition Depot',
  'Transparent Labs', 'Ellaola', 'Swoosh', 'All Stars Performing',
  'Paymentus Corp',
];

export default async function SubscriptionsPage() {
  const supabase = createServerSupabaseClient();

  const { data: transactions } = await supabase
    .from('transactions')
    .select('amount, merchant_name, date')
    .is('deleted_at', null)
    .gt('amount', 0)
    .lt('amount', 500);

  const txns = transactions ?? [];

  // Find recurring merchants (2+ charges across 2+ months)
  const merchantMap = new Map<string, { charges: number; total: number; avg: number; months: Set<string>; lastSeen: string }>();
  
  for (const tx of txns) {
    const name = tx.merchant_name || 'Unknown';
    const month = tx.date.substring(0, 7);
    const existing = merchantMap.get(name) || { charges: 0, total: 0, avg: 0, months: new Set(), lastSeen: '' };
    existing.charges += 1;
    existing.total += Number(tx.amount);
    existing.months.add(month);
    if (tx.date > existing.lastSeen) existing.lastSeen = tx.date;
    merchantMap.set(name, existing);
  }

  // Filter to recurring only
  const recurring = Array.from(merchantMap.entries())
    .filter(([name, data]) => data.charges >= 2 && data.months.size >= 2)
    .filter(([name]) => !NOT_SUBSCRIPTIONS.some(ns => name.includes(ns)))
    .map(([name, data]) => {
      const monthlyAvg = data.total / data.months.size;
      const known = KNOWN_SUBSCRIPTIONS[name];
      const category = known?.category || 'review';
      const note = known?.note || 'Unknown recurring charge — investigate';
      return { name, ...data, monthlyAvg, category, note };
    })
    .sort((a, b) => b.monthlyAvg - a.monthlyAvg);

  const keepSubs = recurring.filter(s => s.category === 'keep');
  const reviewSubs = recurring.filter(s => s.category === 'review');
  const cancelSubs = recurring.filter(s => s.category === 'cancel');

  const totalMonthly = recurring.reduce((sum, s) => sum + s.monthlyAvg, 0);
  const keepTotal = keepSubs.reduce((sum, s) => sum + s.monthlyAvg, 0);
  const reviewTotal = reviewSubs.reduce((sum, s) => sum + s.monthlyAvg, 0);
  const cancelTotal = cancelSubs.reduce((sum, s) => sum + s.monthlyAvg, 0);

  const fmt = (n: number) => formatCurrency(Math.round(n * 100) / 100);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Subscription Audit</h1>
        <p className="text-sm text-muted-foreground">
          Auto-detected recurring charges across all accounts
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground uppercase">Total Recurring</p>
            <p className="text-2xl font-bold mt-1">{fmt(totalMonthly)}/mo</p>
            <p className="text-xs text-muted-foreground">{fmt(totalMonthly * 12)}/year</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-green-600 uppercase">Keep</p>
            <p className="text-2xl font-bold mt-1 text-green-700">{fmt(keepTotal)}/mo</p>
            <p className="text-xs text-muted-foreground">{keepSubs.length} services</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-yellow-600 uppercase">Review</p>
            <p className="text-2xl font-bold mt-1 text-yellow-700">{fmt(reviewTotal)}/mo</p>
            <p className="text-xs text-muted-foreground">{reviewSubs.length} services</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-red-600 uppercase">Cancel</p>
            <p className="text-2xl font-bold mt-1 text-red-700">{fmt(cancelTotal)}/mo</p>
            <p className="text-xs text-muted-foreground">{cancelSubs.length} items</p>
          </CardContent>
        </Card>
      </div>

      {/* Potential savings */}
      {(cancelTotal + reviewTotal * 0.5) > 50 && (
        <div className="rounded-lg border border-green-300 bg-white p-4">
          <p className="text-sm text-gray-900">
            <strong>Potential savings:</strong> Canceling flagged items saves {fmt(cancelTotal)}/mo ({fmt(cancelTotal * 12)}/yr). 
            If you cut half the "Review" items, that is another {fmt(reviewTotal * 0.5)}/mo ({fmt(reviewTotal * 0.5 * 12)}/yr).
            Total potential: <strong>{fmt(cancelTotal + reviewTotal * 0.5)}/mo</strong>.
          </p>
        </div>
      )}

      {/* Cancel section */}
      {cancelSubs.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
              <CardTitle className="text-red-600">Cancel These</CardTitle>
            </div>
            <CardDescription>Charges you should eliminate</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {cancelSubs.map(sub => (
                <div key={sub.name} className="flex flex-col gap-1 rounded-lg border border-red-200 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{sub.name}</p>
                    <p className="text-xs text-muted-foreground">{sub.note}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-red-600 tabular-nums">{fmt(sub.monthlyAvg)}/mo</p>
                    <p className="text-xs text-muted-foreground">Last: {sub.lastSeen}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Review section */}
      {reviewSubs.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5 text-yellow-600" />
              <CardTitle className="text-yellow-600">Review These</CardTitle>
            </div>
            <CardDescription>Recurring charges worth questioning</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {reviewSubs.map(sub => (
                <div key={sub.name} className="flex flex-col gap-1 rounded-lg border border-yellow-200 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{sub.name}</p>
                    <p className="text-xs text-muted-foreground">{sub.note}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-yellow-700 tabular-nums">{fmt(sub.monthlyAvg)}/mo</p>
                    <p className="text-xs text-muted-foreground">{sub.charges}x over {sub.months.size} months</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Keep section */}
      {keepSubs.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <CardTitle className="text-green-600">Keep</CardTitle>
            </div>
            <CardDescription>Subscriptions providing clear value</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {keepSubs.map(sub => (
                <div key={sub.name} className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">{sub.name}</p>
                    <p className="text-xs text-muted-foreground">{sub.note}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold tabular-nums">{fmt(sub.monthlyAvg)}/mo</p>
                    <p className="text-xs text-muted-foreground">{sub.charges}x over {sub.months.size} months</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
