// Stands in for the `server-only` import marker inside a Lambda bundle.
//
// `server-only` is not an npm package here - Next resolves it internally with a
// build-time alias, and its entire job is to make a client bundle fail loudly if
// it ever pulls in server code. esbuild has no such alias, so bundling any
// module under lib/ for Lambda dies at "Could not resolve 'server-only'".
//
// A Lambda IS the server, so the marker has nothing to guard and an empty
// module is the honest translation. This mirrors azure/harness/.server-only-shim.js,
// which solved the same problem for the tsx harnesses.
export {};
