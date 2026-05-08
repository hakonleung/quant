/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
    // Per-route automatic tree-shaking for libraries that ship a flat
    // barrel entry. Chakra v3's barrel re-exports the entire component
    // surface, and react-query's barrel pulls devtools-adjacent code
    // alongside hooks; both ship hundreds of KB the app doesn't use.
    // Next 14's `optimizePackageImports` rewrites these to deep paths
    // at build time so unused exports drop out of the chunk.
    optimizePackageImports: [
      '@chakra-ui/react',
      '@tanstack/react-query',
      '@tanstack/react-virtual',
    ],
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
