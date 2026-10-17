/**
 * Public Clerk Frontend API proxy configuration.
 *
 * The proxy URL is public configuration; only CLERK_SECRET_KEY stays server-side.
 * Clerk's production FAPI proxy expects requests to reach this URL and be
 * forwarded to frontend-api.clerk.dev with the three proxy headers.
 */
export const CLERK_PROXY_URL = 'https://tracefab.vercel.app/__clerk';
export const CLERK_FRONTEND_API_ORIGIN = 'https://frontend-api.clerk.dev';
export const CLERK_PROXY_PATH_QUERY = '__tracefab_clerk_path';
