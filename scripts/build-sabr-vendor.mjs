// Rebuild the browser SABR protocol bundle from a hash-verified upstream archive.
// Usage: node scripts/build-sabr-vendor.mjs SOURCE_ARCHIVE DEPENDENCY_NODE_MODULES
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const commit = '96d1418984d00ac2797a1dafe4625d1368b5b9aa';
const archiveSHA256 = '63091266e32cddc3ea08266f44b7ca2690a19325a687fd701f6a56667375f640';
const archiveURL = `https://codeload.github.com/LuanRT/googlevideo/tar.gz/${commit}`;
const versions = { esbuild: '0.25.12', '@bufbuild/protobuf': '2.16.0' };
const dependencyArtifacts = {
  esbuild: {
    url: 'https://registry.npmjs.org/esbuild/-/esbuild-0.25.12.tgz',
    integrity: 'sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg=='
  },
  '@bufbuild/protobuf': {
    url: 'https://registry.npmjs.org/@bufbuild/protobuf/-/protobuf-2.16.0.tgz',
    integrity: 'sha512-FWa0sPlqYGJgpTs6OxBRcL/AW4JT0OIO+W1ajerluoTVh8CV0B7XM1qsNCRgnkSCkRCgOICKHRQlY17jrsm0+Q=='
  }
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const [archiveArg, dependenciesArg] = process.argv.slice(2);
if (!archiveArg || !dependenciesArg) throw new Error('Usage: node scripts/build-sabr-vendor.mjs SOURCE_ARCHIVE DEPENDENCY_NODE_MODULES');
const archive = await realpath(resolve(archiveArg)), dependencies = await realpath(resolve(dependenciesArg));
if (sha256(await readFile(archive)) !== archiveSHA256) throw new Error('Upstream source archive SHA-256 does not match the pinned source');
for (const [name, expected] of Object.entries(versions)) {
  const pkg = JSON.parse(await readFile(resolve(dependencies, name, 'package.json'), 'utf8'));
  if (pkg.version !== expected) throw new Error(`Expected ${name}@${expected}, found ${pkg.version}`);
}
const { build } = await import(pathToFileURL(resolve(dependencies, 'esbuild/lib/main.js')).href);
const staging = await mkdtemp(resolve(tmpdir(), 'kage-sabr-build-'));
const destination = resolve(dirname(fileURLToPath(import.meta.url)), '../extension/vendor/googlevideo');
try {
  execFileSync('tar', ['-xzf', archive, '-C', staging]);
  const source = await realpath(resolve(staging, `googlevideo-${commit}`));
  await mkdir(destination, { recursive: true });
  const result = await build({
    absWorkingDir: source,
    stdin: {
      contents: [
        "export { SabrStream } from './src/core/SabrStream.ts';",
        "export { EnabledTrackTypes, buildSabrFormat } from './src/utils/formatUtils.ts';",
        "export { VideoPlaybackAbrRequest } from './src/utils/Protos.ts';",
        "export { Logger } from './src/utils/Logger.ts';"
      ].join('\n'),
      resolveDir: source,
      sourcefile: 'kage-sabr-entry.ts',
      loader: 'ts'
    },
    nodePaths: [dependencies],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    globalName: 'KageSabrProtocol',
    footer: { js: 'globalThis.KageSabrProtocol = KageSabrProtocol;' },
    platform: 'browser',
    target: 'chrome111',
    legalComments: 'eof',
    metafile: true,
    banner: { js: `/*! GoogleVideo ${commit}; Copyright (c) 2024 LuanRT; MIT.\n * Includes @bufbuild/protobuf ${versions['@bufbuild/protobuf']}; Apache-2.0 AND BSD-3-Clause.\n * See LICENSE and THIRD-PARTY-NOTICES.txt in this directory. */` }
  });
  const output = result.outputFiles[0].contents;
  const code = new TextDecoder().decode(output);
  if (/\beval\s*\(|\bnew\s+Function\b|\bimport\s*\(/.test(code)) throw new Error('Unexpected dynamic code execution in browser bundle');
  await writeFile(resolve(destination, 'sabr.js'), output);
  await copyFile(resolve(source, 'LICENSE'), resolve(destination, 'LICENSE'));
  // The npm distribution keeps its license notices in source headers rather
  // than standalone license files. Preserve those headers and the full Apache
  // license text without requiring a separate download during the rebuild.
  const protobufRoot = resolve(dependencies, '@bufbuild/protobuf');
  const binarySource = await readFile(resolve(protobufRoot, 'dist/esm/wire/binary-encoding.js'), 'utf8');
  const apacheCopyright = binarySource.split('\n').find(line => line.startsWith('// Copyright '))?.slice(3);
  const varintSource = await readFile(resolve(protobufRoot, 'dist/esm/wire/varint.js'), 'utf8');
  const bsdNotice = varintSource.split('/**', 1)[0].split('\n')
    .map(line => line.startsWith('// ') ? line.slice(3) : line === '//' ? '' : line).join('\n').trimEnd();
  if (!apacheCopyright || !binarySource.includes('Licensed under the Apache License, Version 2.0')
      || !bsdNotice.includes('Redistribution and use in source and binary forms')
      || !bsdNotice.includes('Copyright 2008 Google Inc.')) throw new Error('Dependency license headers changed');
  const notices = `@bufbuild/protobuf ${versions['@bufbuild/protobuf']}\n${apacheCopyright}\nLicense: Apache-2.0 AND BSD-3-Clause\nSource: https://github.com/bufbuild/protobuf-es/tree/v${versions['@bufbuild/protobuf']}\n\n${canonicalApacheLicense()}\n\nBSD-3-Clause notice from bundled wire/varint.js:\n\n${bsdNotice}\n`;
  await writeFile(resolve(destination, 'THIRD-PARTY-NOTICES.txt'), notices);
  const inputs = [];
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    if (name.endsWith('kage-sabr-entry.ts')) continue;
    const absolute = await realpath(resolve(source, name));
    if (!absolute.startsWith(source + sep) && !absolute.startsWith(dependencies + sep))
      throw new Error('Unexpected bundle input outside source and dependency roots');
    const path = absolute.startsWith(source + sep)
      ? `googlevideo/${relative(source, absolute).split(sep).join('/')}`
      : `dependencies/${relative(dependencies, absolute).split(sep).join('/')}`;
    inputs.push({ path, sha256: sha256(await readFile(absolute)) });
  }
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await writeFile(resolve(destination, 'provenance.json'), JSON.stringify({
    upstream: 'https://github.com/LuanRT/googlevideo', commit, archiveURL, archiveSHA256,
    dependencies: versions, dependencyArtifacts, bundleSHA256: sha256(output), bundleBytes: output.byteLength,
    inputs
  }, null, 2) + '\n');
  console.log(`Built ${output.byteLength} bytes; SHA-256 ${sha256(output)}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

// Canonical Apache License 2.0 text, retained for npm packages that ship only
// per-file Apache notices. The dependency copyright is read from its sources.
function canonicalApacheLicense() {
  return `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2021-2026 Buf Technologies, Inc.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
`;
}
