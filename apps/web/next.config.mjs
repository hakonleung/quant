/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  transpilePackages: ['@quant/shared', '@quant/ui'],
  webpack: (config) => {
    // Allow `import './foo.js'` to resolve to `./foo.ts` / `./foo.tsx`
    // — required when `verbatimModuleSyntax` (CLAUDE.md §1.2) forces
    // `.js` specifiers in TypeScript source.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
