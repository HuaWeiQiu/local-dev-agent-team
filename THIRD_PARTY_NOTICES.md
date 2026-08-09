# Third-Party Notices

Agent Team is licensed under the MIT License. Its desktop bundle includes a
pinned official Node.js runtime so customers do not need to install Node.js
separately.

## Node.js

- Version: 24.19.0
- Source: <https://nodejs.org/dist/v24.19.0/>
- License: MIT and bundled third-party notices

The desktop preparation script verifies the official `SHASUMS256.txt` entry
before extracting the runtime. The complete Node.js `LICENSE` file is copied
into the application resources as `runtime/licenses/NODE-LICENSE`.

## Lucide

The application interface uses Lucide icons, and the application icon is based
on the Lucide `Bot` icon.

Lucide is available under the ISC License:

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
USE OR PERFORMANCE OF THIS SOFTWARE.

Some interface icons are derived from Feather Icons and remain available under
the MIT License, Copyright (c) 2013-present Cole Bemis.

JavaScript and Rust dependency licenses remain available from `pnpm-lock.yaml`
and `src-tauri/Cargo.lock`. Release automation should generate a complete
machine-readable dependency license inventory before public binary releases.
