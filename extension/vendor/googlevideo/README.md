# GoogleVideo SABR protocol bundle

`sabr.js` is a local browser IIFE built from the MIT-licensed
[GoogleVideo source](https://github.com/LuanRT/googlevideo) at commit
`96d1418984d00ac2797a1dafe4625d1368b5b9aa`. It exports
`globalThis.KageSabrProtocol` with `SabrStream`, `EnabledTrackTypes`,
`buildSabrFormat`, `VideoPlaybackAbrRequest`, and `Logger`.

The source commit includes the September 2026 SABR downloader rewrite. Its
package.json still says 4.1.1; the npm 4.1.1 release does not contain that rewrite.
Use the commit pin rather than substituting the npm package.

The only bundled runtime dependency is `@bufbuild/protobuf@2.16.0`, licensed under
Apache-2.0 AND BSD-3-Clause. `esbuild@0.25.12` is a build tool and is not bundled.
`LICENSE` preserves GoogleVideo's license. `THIRD-PARTY-NOTICES.txt` preserves the
dependency copyright and license text. `provenance.json` records the upstream
archive hash, dependency artifact integrity, each bundled input hash, and output
hash. No source patches are applied.

The bundle contains no dynamic imports, `eval`, `new Function`, remote script
loading, or Node.js runtime imports. `SabrStream` accepts an injected fetch
implementation; callers must enforce destination, request, response, total size,
time, cancellation, video identity, and complete media validation themselves.
The library's stream end and buffered range summary do not independently prove
that every audio segment is present. Disable library logging in the caller with
`Logger.getInstance().setLogLevels(0)` to keep playback addresses out of logs.

## Rebuild

Download the pinned source archive and prepare isolated build dependencies:

```sh
build_dir=$(mktemp -d)
curl -fsSL https://codeload.github.com/LuanRT/googlevideo/tar.gz/96d1418984d00ac2797a1dafe4625d1368b5b9aa -o "$build_dir/source.tgz"
npm install --prefix "$build_dir" --ignore-scripts --no-audit --no-fund esbuild@0.25.12 @bufbuild/protobuf@2.16.0
node scripts/build-sabr-vendor.mjs "$build_dir/source.tgz" "$build_dir/node_modules"
```

Run the final command from the repository root. The builder verifies the source
archive SHA-256 and exact dependency versions, creates a fresh temporary source
directory, bundles for Chromium 111+, checks for dynamic code execution, updates
the bundle, license and provenance, and removes its temporary extracted source.
The repository's package.json and installed dependencies are not changed.
