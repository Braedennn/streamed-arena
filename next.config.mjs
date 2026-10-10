const mobileBuild = process.env.BUILD_MOBILE === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output:
    process.env.BUILD_STANDALONE === '1' ? 'standalone' : mobileBuild ? 'export' : undefined,
  distDir:
    process.env.BUILD_STANDALONE === '1' ? '.next-standalone' : mobileBuild ? '.next-mobile' : '.next',
  trailingSlash: mobileBuild ? true : undefined,
  images: {
    unoptimized: mobileBuild,
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080],
    imageSizes: [16, 32, 48, 64, 96, 128, 192, 256, 384],
    minimumCacheTTL: 3600,
    remotePatterns: [
      { protocol: 'https', hostname: 'streamed.pk', pathname: '/api/images/**' },
      { protocol: 'https', hostname: 'streamed.st', pathname: '/api/images/**' },
      { protocol: 'https', hostname: '**.espncdn.com', pathname: '/**' },
    ],
  },
};

export default nextConfig;
