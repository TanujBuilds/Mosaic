# Third-party notices

Audited baseline: 16 November 2026 (America/Los_Angeles), source commit `a23bae40d733fd711075ca798f83fbe9cc5ac633`, tree `49f2b66d21c53950eff6127daf68e2ae2819a5d7`. This index describes the source preview and the locally accepted Darwin arm64 beta184/185 candidates. It does not announce a published installer. The exact bindings and open distribution findings are in [Distribution provenance](docs/DISTRIBUTION_PROVENANCE.md).

Mosaic's own source remains under its existing [MIT license](LICENSE), copyright (c) 2026 Tanuj Patel. Third-party software and fonts retain their own copyrights, terms and disclaimers. A package's declared license is metadata, not a grant covering every embedded component. This index does not replace the complete license texts or establish blanket redistribution clearance.

## Node 24.22.3 release inputs

Archives built with Node 24.22.3 carry the supplemental runtime notices and their index under `payload/runtime/notices/`. Both Node runtimes retain the complete upstream top-level `LICENSE`. The remainder of this document records the dated beta184/185 audit and its evidence.

## Production lock as of Beta .220

Compared with the lock audited below, the 95 production installation locations are the same. Hono is now **4.13.19** and `@hono/node-server` is **2.1.11**. The Beta .220 payload carries both MIT licenses at the same locations shown below. Hono still carries the credited `Simplify` declaration, and the supplemental notices preserve that credit and the available type-fest terms. See the [current lockfile](package-lock.json) for exact dependency integrity pins and the [supplemental notice index](distribution/notices/INDEX.md) for attribution provenance.

## Where the complete notices are

Paths beginning with `payload/` below describe the extracted candidate archive; they are not files in a source-only checkout.

| Material | Physically included notice |
| --- | --- |
| Mosaic source and C supervisor | `payload/LICENSE` |
| Ordinary coordinator Node | `payload/runtime/NODE-LICENSE` |
| Separate patched check Node | `payload/runtime/check-artifact/NODE-LICENSE` |
| Production npm packages | Complete package notices listed below, plus retained source headers; `payload/runtime/DEPENDENCY-LICENSES.txt` indexes license filenames |
| Nunito font in the source dashboard | [src/harness/dashboard/nunito-OFL.txt](src/harness/dashboard/nunito-OFL.txt); font and notice are absent from these terminal archives |

Both Node notice copies are the complete 157,609-byte upstream top-level `LICENSE`, SHA-256 `5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace`. They include Node's MIT notice, copyright Node.js contributors/Joyent, and the upstream third-party sections. Preserve the entire files, including disclaimers and any referenced terms. Additional source-level notice applicability remains an open finding below.

## Production npm packages in Beta .184 and .185

The only direct production dependency is `@modelcontextprotocol/sdk` 1.32.2 (MIT; copyright (c) 2024 Anthropic, PBC). Its dependency tree is separately enumerated: 95 installation locations, 92 distinct name/version pairs. All 95 locations and their included root notices are present in both accepted archives. Repeated `content-type` 2.1.0 rows identify distinct nested copies under body-parser, express, negotiator and type-is.

The table follows the exact [package-lock.json](package-lock.json), SHA-256 `a390331015b970a682124187f756224994c019f93007b411b16ce6ef6a2e0cb6`. That lock records each registry tarball URL, integrity value and dependency edge. MIT applies at 85 locations, ISC at seven, BSD-3-Clause at two and BSD-2-Clause at one. The table lists complete notice locations, not substitute license wording: retain each original copyright, permission, condition and disclaimer. BSD non-endorsement clauses and any additional file-level terms remain applicable where stated.

| Package | Version | Declared terms | Included complete notice, relative to `payload/runtime/` |
| --- | --- | --- | --- |
| `@hono/node-server` | 2.1.5 | MIT | `node_modules/@hono/node-server/LICENSE` |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | `node_modules/@modelcontextprotocol/sdk/LICENSE` |
| `accepts` | 2.0.0 | MIT | `node_modules/accepts/LICENSE` |
| `ajv` | 8.20.0 | MIT | `node_modules/ajv/LICENSE` |
| `ajv-formats` | 3.0.1 | MIT | `node_modules/ajv-formats/LICENSE` |
| `body-parser` | 2.4.0 | MIT | `node_modules/body-parser/LICENSE` |
| `content-type` | 2.1.0 | MIT | `node_modules/body-parser/node_modules/content-type/LICENSE` |
| `bytes` | 3.1.2 | MIT | `node_modules/bytes/LICENSE` |
| `call-bind-apply-helpers` | 1.0.2 | MIT | `node_modules/call-bind-apply-helpers/LICENSE` |
| `call-bound` | 1.0.4 | MIT | `node_modules/call-bound/LICENSE` |
| `content-disposition` | 2.0.1 | MIT | `node_modules/content-disposition/LICENSE` |
| `content-type` | 1.0.5 | MIT | `node_modules/content-type/LICENSE` |
| `cookie` | 0.7.2 | MIT | `node_modules/cookie/LICENSE` |
| `cookie-signature` | 1.2.2 | MIT | `node_modules/cookie-signature/LICENSE` |
| `cors` | 2.8.6 | MIT | `node_modules/cors/LICENSE` |
| `cross-spawn` | 7.0.6 | MIT | `node_modules/cross-spawn/LICENSE` |
| `debug` | 4.4.3 | MIT | `node_modules/debug/LICENSE` |
| `depd` | 2.0.0 | MIT | `node_modules/depd/LICENSE` |
| `dunder-proto` | 1.0.1 | MIT | `node_modules/dunder-proto/LICENSE` |
| `ee-first` | 1.1.1 | MIT | `node_modules/ee-first/LICENSE` |
| `encodeurl` | 2.0.0 | MIT | `node_modules/encodeurl/LICENSE` |
| `es-define-property` | 1.0.1 | MIT | `node_modules/es-define-property/LICENSE` |
| `es-errors` | 1.3.0 | MIT | `node_modules/es-errors/LICENSE` |
| `es-object-atoms` | 1.1.2 | MIT | `node_modules/es-object-atoms/LICENSE` |
| `escape-html` | 1.0.3 | MIT | `node_modules/escape-html/LICENSE` |
| `etag` | 1.8.1 | MIT | `node_modules/etag/LICENSE` |
| `eventsource` | 3.0.7 | MIT | `node_modules/eventsource/LICENSE` |
| `eventsource-parser` | 3.1.1 | MIT | `node_modules/eventsource-parser/LICENSE` |
| `express` | 5.3.0 | MIT | `node_modules/express/LICENSE` |
| `express-rate-limit` | 8.7.1 | MIT | `node_modules/express-rate-limit/license` |
| `content-type` | 2.1.0 | MIT | `node_modules/express/node_modules/content-type/LICENSE` |
| `fast-deep-equal` | 3.1.3 | MIT | `node_modules/fast-deep-equal/LICENSE` |
| `fast-uri` | 3.1.9 | BSD-3-Clause | `node_modules/fast-uri/LICENSE` |
| `finalhandler` | 2.1.1 | MIT | `node_modules/finalhandler/LICENSE` |
| `forwarded` | 0.2.0 | MIT | `node_modules/forwarded/LICENSE` |
| `fresh` | 2.0.0 | MIT | `node_modules/fresh/LICENSE` |
| `function-bind` | 1.1.2 | MIT | `node_modules/function-bind/LICENSE` |
| `get-intrinsic` | 1.3.0 | MIT | `node_modules/get-intrinsic/LICENSE` |
| `get-proto` | 1.0.1 | MIT | `node_modules/get-proto/LICENSE` |
| `gopd` | 1.2.0 | MIT | `node_modules/gopd/LICENSE` |
| `has-symbols` | 1.1.0 | MIT | `node_modules/has-symbols/LICENSE` |
| `hasown` | 2.0.4 | MIT | `node_modules/hasown/LICENSE` |
| `hono` | 4.13.14 | MIT | `node_modules/hono/LICENSE` |
| `http-errors` | 2.0.1 | MIT | `node_modules/http-errors/LICENSE` |
| `iconv-lite` | 0.7.3 | MIT | `node_modules/iconv-lite/LICENSE` |
| `inherits` | 2.0.4 | ISC | `node_modules/inherits/LICENSE` |
| `ip-address` | 10.7.5 | MIT | `node_modules/ip-address/LICENSE` |
| `ipaddr.js` | 1.9.1 | MIT | `node_modules/ipaddr.js/LICENSE` |
| `is-promise` | 4.0.0 | MIT | `node_modules/is-promise/LICENSE` |
| `isexe` | 2.0.0 | ISC | `node_modules/isexe/LICENSE` |
| `jose` | 6.2.13 | MIT | `node_modules/jose/LICENSE.md` |
| `json-schema-traverse` | 1.0.0 | MIT | `node_modules/json-schema-traverse/LICENSE` |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause | `node_modules/json-schema-typed/LICENSE.md` |
| `math-intrinsics` | 1.1.0 | MIT | `node_modules/math-intrinsics/LICENSE` |
| `media-typer` | 1.1.1 | MIT | `node_modules/media-typer/LICENSE` |
| `merge-descriptors` | 2.0.0 | MIT | `node_modules/merge-descriptors/license` |
| `mime-db` | 1.54.0 | MIT | `node_modules/mime-db/LICENSE` |
| `mime-types` | 3.0.2 | MIT | `node_modules/mime-types/LICENSE` |
| `ms` | 2.1.3 | MIT | `node_modules/ms/license.md` |
| `negotiator` | 1.1.0 | MIT | `node_modules/negotiator/LICENSE` |
| `content-type` | 2.1.0 | MIT | `node_modules/negotiator/node_modules/content-type/LICENSE` |
| `object-assign` | 4.1.1 | MIT | `node_modules/object-assign/license` |
| `object-inspect` | 1.13.4 | MIT | `node_modules/object-inspect/LICENSE` |
| `on-finished` | 2.4.2 | MIT | `node_modules/on-finished/LICENSE` |
| `once` | 1.4.0 | ISC | `node_modules/once/LICENSE` |
| `parseurl` | 1.3.3 | MIT | `node_modules/parseurl/LICENSE` |
| `path-key` | 3.1.1 | MIT | `node_modules/path-key/license` |
| `path-to-regexp` | 8.4.2 | MIT | `node_modules/path-to-regexp/LICENSE` |
| `pkce-challenge` | 5.0.1 | MIT | `node_modules/pkce-challenge/LICENSE` |
| `proxy-addr` | 2.0.8 | MIT | `node_modules/proxy-addr/LICENSE` |
| `qs` | 6.17.0 | BSD-3-Clause | `node_modules/qs/LICENSE.md` |
| `range-parser` | 1.3.0 | MIT | `node_modules/range-parser/LICENSE` |
| `raw-body` | 3.0.2 | MIT | `node_modules/raw-body/LICENSE` |
| `require-from-string` | 2.0.2 | MIT | `node_modules/require-from-string/license` |
| `router` | 2.2.0 | MIT | `node_modules/router/LICENSE` |
| `safer-buffer` | 2.1.2 | MIT | `node_modules/safer-buffer/LICENSE` |
| `send` | 1.2.1 | MIT | `node_modules/send/LICENSE` |
| `serve-static` | 2.2.1 | MIT | `node_modules/serve-static/LICENSE` |
| `setprototypeof` | 1.2.0 | ISC | `node_modules/setprototypeof/LICENSE` |
| `shebang-command` | 2.0.0 | MIT | `node_modules/shebang-command/license` |
| `shebang-regex` | 3.0.0 | MIT | `node_modules/shebang-regex/license` |
| `side-channel` | 1.1.1 | MIT | `node_modules/side-channel/LICENSE` |
| `side-channel-list` | 1.0.1 | MIT | `node_modules/side-channel-list/LICENSE` |
| `side-channel-map` | 1.0.1 | MIT | `node_modules/side-channel-map/LICENSE` |
| `side-channel-weakmap` | 1.0.2 | MIT | `node_modules/side-channel-weakmap/LICENSE` |
| `statuses` | 2.0.2 | MIT | `node_modules/statuses/LICENSE` |
| `toidentifier` | 1.0.1 | MIT | `node_modules/toidentifier/LICENSE` |
| `type-is` | 2.1.0 | MIT | `node_modules/type-is/LICENSE` |
| `content-type` | 2.1.0 | MIT | `node_modules/type-is/node_modules/content-type/LICENSE` |
| `unpipe` | 1.0.0 | MIT | `node_modules/unpipe/LICENSE` |
| `vary` | 1.1.2 | MIT | `node_modules/vary/LICENSE` |
| `which` | 2.0.2 | ISC | `node_modules/which/LICENSE` |
| `wrappy` | 1.0.2 | ISC | `node_modules/wrappy/LICENSE` |
| `zod` | 4.6.7 | MIT | `node_modules/zod/LICENSE` |
| `zod-to-json-schema` | 3.25.2 | ISC | `node_modules/zod-to-json-schema/LICENSE` |

`@cfworker/json-schema` is an optional SDK peer absent from this lock and these archives. It is not counted as installed. Development-only `playwright` and `playwright-core` 1.64.1 are Apache-2.0 and are absent, along with Chromium/FFmpeg and the separate offline demo input archive. Redistributing development/browser inputs requires their own notices and distribution review; they are not covered by the production table.

## Embedded attributions and questions

The generated dependency-license index lists 95 package-root license files. It does not index every embedded source notice. Preserve these shipped files as well:

- Hono's `node_modules/hono/dist/helper/css/common.js` and its `dist/cjs/` counterpart credit goober, copyright (c) 2019 Cristian Bote, under MIT. Its `dist/types/jsx/intrinsic-elements.d.ts` credits React, copyright (c) Meta Platforms, Inc. and affiliates, under MIT. These headers are separate from Hono's own copyright.
- Hono's `node_modules/hono/dist/types/utils/types.d.ts` credits `sindresorhus/type-fest` without identifying a version or a separate license grant at that credit. Determine the exact borrowed source and applicable terms before treating this embedded attribution as resolved. No type-fest license is inferred from Hono's MIT metadata.
- `node_modules/iconv-lite/lib/index.d.ts` retains Microsoft Corporation's copyright and MIT reference. `node_modules/fast-uri/test/uri-js.test.js` retains Gary Court's 2011 copyright and its own two-condition redistribution text. The latter ships even though it is a dependency test file.
- `node_modules/json-schema-typed/LICENSE.md` includes the JSON Schema documentation authors and IETF Trust wording across multiple drafts as well as its source copyright. Preserve that entire multi-author notice.
- `node_modules/cross-spawn/lib/util/escape.js` describes an algorithm based on `https://qntm.org/cmd`. Zod's `src/v4/core/regexes.ts` and compiled copies reference Stack Overflow question 106179. Those references do not identify an exact borrowed revision/answer or settle its terms. Determine whether additional attribution or permission is required; a reference alone does not establish copying or infringement.
- The upstream `pkce-challenge` 5.0.1 MIT file contains `Copyright (c) 2019` with no holder following it. The file is preserved verbatim; the audit does not invent a holder.

These are attribution/provenance findings, not a determination that every file's terms are satisfied by a package-root license. The release owner must resolve missing or ambiguous grants and include any required additional complete notices. A copied notice alone is not proof of permission from its holder.

## Node.js and its bundled material

The coordinator and the patched check runtime are distinct binaries based on Node 24.22.0. Both retain the same full upstream top-level license. Its 44 third-party sections name Acorn, c-ares, merve, ittapi, amaro, swc, ICU, libuv, LIEF, llhttp, corepack, undici, postject, OpenSSL, Punycode.js, V8, SipHash, zlib, simdjson, simdutf, ada, minimatch, npm, GYP, inspector_protocol, jinja2, markupsafe, cpplint.py, gypi_to_gn.py, gtest, nghttp2, large_pages, caja, brotli, zstd, HdrHistogram, node-heapdump, rimraf, uvwasi, ngtcp2, nghttp3, node-fs-extra, on-exit-leak-free, sonic-boom. This is an index of notice sections, not a claim that all listed build tools, fixtures or components are linked into either binary.

The text includes more than MIT: BSD/ISC, Apache-2.0, Unicode/ICU data terms, zlib-style terms, Blue Oak 1.0.0 (minimatch), Artistic 2.0 (npm), and other component-specific wording. ICU's source/build-tool terms must not be reduced to a blanket runtime license label. V8 explicitly refers readers to additional `LICENSE` files in source subdirectories. The pinned upstream source archive is the reference for those additional materials; all its subdirectory licenses are not physically copied into these beta archives. Establish their applicability to the shipped binaries and add required material before distribution clearance. The [runtime provenance](docs/DISTRIBUTION_PROVENANCE.md) records this open question and the exact source/patch pins.

### Additional fdlibm notice

A concrete notice gap affects the accepted archives: the pinned Node source contains `deps/v8/LICENSE.fdlibm` and the fdlibm-derived `deps/v8/src/base/ieee754.cc`, whose object compilation appears in the retained check-runtime build log. Neither complete notice below occurs in the shipped top-level Node license. This document preserves both complete source notices for future inclusion. It does not retrofit beta184/185 or settle other V8 subdirectory notice applicability. The same source notice issue must also be evaluated for the official coordinator binary; this audit has no upstream object/link attestation for that binary.

Complete `deps/v8/LICENSE.fdlibm` (250 bytes, SHA-256 `e7115e18444dae09d17f361ddc365fb1d342640fe500796209c63f7c80dfae10`):

```text
Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.

Developed at SunSoft, a Sun Microsystems, Inc. business.
Permission to use, copy, modify, and distribute this
software is freely granted, provided that this notice
is preserved.
```

Complete opening notice from `deps/v8/src/base/ieee754.cc`, including the modification credit (the V8 project terms remain in the full Node license):

```text
// The following is adapted from fdlibm (http://www.netlib.org/fdlibm).
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
//
// The original source code covered by the above license above has been
// modified significantly by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.
```

The pinned V8 source contains 24 license/notice files, of which 19 do not repeat completely in the top-level Node license after lowercasing and removing every character outside ASCII letters and digits. This comparison identifies review material; it does not prove every source/tool/test license is a binary obligation. Other source notices include utf8-decoder, fp16, rapidhash and Strongtalk. Evaluate exact compiled applicability and preserve required additional texts before qualification; no LGPL-linked runtime conclusion follows merely from a glibc source license appearing in the V8 tree.

## Nunito source asset

The source dashboard contains [Nunito](src/harness/dashboard/nunito.ttf), embedded font version 3.602. Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito); the embedded designer/manufacturer credit is Vernon Adams. The complete [SIL Open Font License 1.1](src/harness/dashboard/nunito-OFL.txt) accompanies it. Keep the copyright and license with redistributions; the license includes restrictions on selling the font by itself, modified reserved font names, and endorsement. The font remains under OFL. This source asset is outside the terminal package closure audited here.

## Future archives

The immutable beta184/185 candidates contain the original notices described above. They contain neither this new index nor `docs/DISTRIBUTION_PROVENANCE.md`. A separately owned builder change must include both documents and any additional notices found necessary, regenerate inventories/fingerprints for final bytes, and repeat the distribution audit. No license, runtime, dependency, builder or accepted archive was changed by this documentation audit.
