import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const querySchema = z.object({
  ticker: z.string().min(1).max(10).regex(/^[A-Z0-9.]+$/),
});

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse({ ticker: searchParams.get('ticker') });
    if (!parsed.success) {
      throw new ValidationError('Invalid ticker symbol');
    }

    // Phase 5: Fetch from FMP API
    return NextResponse.json({ error: 'Not yet implemented.' }, { status: 501 });
  } catch (error) {
    logger.error('Market fundamentals error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
