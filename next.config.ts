import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root - silences the multi-lockfile inference warning.
  turbopack: {
    root: __dirname,
  },

  // Emits `.next/standalone`: a self-contained `server.js` plus only the
  // node_modules the server actually reaches. This is what the AWS Lambda Web
  // Adapter runs.
  //
  // WHY THIS AND NOT AN ADAPTER. The installed Next 16.2.6 docs
  // (node_modules/next/dist/docs/01-app/02-guides/deploying-to-platforms.md)
  // put it plainly: "To run Next.js, your platform needs a Node.js server.
  // That's it. A single `next start` process handles every Next.js feature
  // correctly: Server Components, ISR, PPR, Cache Components, Server Actions,
  // Proxy, and after()." Standalone plus the adapter runs exactly that process,
  // so those features work by construction rather than by an adapter
  // re-implementing them.
  //
  // It also keeps the deployment package small enough to matter: the full
  // node_modules tree is ~400 MB, the standalone trace is a fraction of that,
  // and Lambda's unzipped limit is 250 MB.
  output: "standalone",

  // `sharp` is the one runtime dependency the docs call out for Image
  // Optimization. Nothing in this app uses next/image today, so it is
  // deliberately absent - if an <Image> is ever added, add sharp with it or
  // optimization silently falls back and slows every image request.

  // NO `eslint` KEY. Next 16 removed it along with `next lint`; leaving one in
  // place fails the build with "Unrecognized key(s) in object: 'eslint'". Lint
  // is a separate `pnpm lint` step now.
};

export default nextConfig;
