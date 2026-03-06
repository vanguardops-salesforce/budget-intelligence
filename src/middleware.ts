import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/mfa-setup', '/mfa-verify'];
const API_PUBLIC_PATHS = ['/api/plaid/webhook'];

function setSecurityHeaders(response: NextResponse): void {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' https://*.supabase.co https://cdn.plaid.com https://production.plaid.com https://sandbox.plaid.com https://api.openai.com; " +
      "frame-src https://cdn.plaid.com; " +
      "img-src 'self' data: blob:; "
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let Next.js static assets and favicon through
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  // Security headers on every response
  setSecurityHeaders(response);

  // Webhook endpoint has its own auth (signature verification) — skip session check
  if (API_PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return response;
  }

  // Cron endpoints verify CRON_SECRET in the route handler — skip session check here
  if (pathname.startsWith('/api/sync/')) {
    return response;
  }

  // Create Supabase client with cookie handling for middleware
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          setSecurityHeaders(response);
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: '', ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          setSecurityHeaders(response);
          response.cookies.set({ name, value: '', ...options });
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Not authenticated and trying to access protected route
  if (!user && !isPublicPath) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirectTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated user on login page — redirect to dashboard
  if (user && pathname === '/login') {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // For authenticated users on protected routes, check MFA status
  if (user && !isPublicPath && !pathname.startsWith('/api/')) {
    const { data: factors } = await supabase.auth.mfa.listFactors();

    // No TOTP enrolled — must set up MFA first
    if (!factors || factors.totp.length === 0) {
      if (pathname !== '/mfa-setup') {
        return NextResponse.redirect(new URL('/mfa-setup', request.url));
      }
      return response;
    }

    // TOTP enrolled but not yet verified this session
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== 'aal2') {
      if (pathname !== '/mfa-verify') {
        return NextResponse.redirect(new URL('/mfa-verify', request.url));
      }
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
