/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
  // Force all pages to render dynamically
  output: 'standalone',
};

export default nextConfig;
