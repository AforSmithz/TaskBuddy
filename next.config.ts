import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root - silences the multi-lockfile inference warning.
  turbopack: {
    root: __dirname,
  },

  // Emits.next/standalone: a self-contained server.js plus only the node_modules the server
  // actually reaches. This is what the Lambda Web Adapter runs.
  //
  // Not an adapter, because the installed Next 16.2.6 docs put it plainly: "To run Next.js, your
  // platform needs a Node.js server. That's it. A single next start process handles every Next.js
  // feature correctly." Standalone plus the adapter runs exactly that process, so those features
  // work by construction rather than by an adapter re-implementing them.
  //
  // It also keeps the package small enough to matter: the full node_modules tree is ~400 MB, the
  // standalone trace a fraction of that, and Lambda's unzipped limit is 250 MB.
  output: "standalone",

  // `sharp` is the one runtime dependency the docs call out for Image
  // Optimization. Nothing in this app uses next/image today, so it is
  // deliberately absent - if an <Image> is ever added, add sharp with it or
  // optimization silently falls back and slows every image request.

  // Server Actions behind a CDN: without this every single one is refused.
  //
  // Next compares the browser's Origin against the forwarded host to stop cross-site Server
  // Action invocations, and behind CloudFront those are never the same string. CloudFront has to
  // use AllViewerExceptHostHeader (a function URL routes on Host, so the viewer's Host can't be
  // forwarded), which means the origin sees:
  //
  //   x-forwarded-host: <id>.lambda-url.ap-southeast-1.on.aws
  //   origin:           <id>.cloudfront.net
  //
  // and refuses with "Invalid Server Actions request". The browser gets an opaque "Something went
  // wrong" from the error boundary with the real reason only in the function's logs, so it reads
  // like a broken action rather than a rejected one. Measured live 2026-08-19.
  //
  // From the environment rather than hardcoded: the CloudFront domain is a deploy-time output,
  // and a custom domain will need adding too. It's a CSRF allowlist, so exact hosts only.
  experimental: {
    serverActions: {
      allowedOrigins: (process.env.TASKBUDDY_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    },
  },

  // NO `eslint` KEY. Next 16 removed it along with `next lint`; leaving one in
  // place fails the build with "Unrecognized key(s) in object: 'eslint'". Lint
  // is a separate `pnpm lint` step now.
};

export default nextConfig;
