# Third-party inventory and notices

No T3 Code or production T3 Chat source, assets or dependencies were copied into this repository. All authored source and synthetic fixture text were created here. The built library externalizes React; the separate Chat server browser assets include the React runtime listed below.

The checked-in `package-lock.json` identifies direct packages and the full transitive development tree. Relevant runtime and direct package metadata read from that lock during this revision:

| Package | Locked version | Role | Declared license |
| --- | --- | --- | --- |
| react | 19.3.0 | browser runtime; peer/example/test development | MIT |
| react-dom | 19.3.0 | browser runtime; peer/example/test development | MIT |
| scheduler | 0.28.0 | React DOM runtime dependency | MIT |
| react-markdown | 10.1.0 | safe default Markdown rendering | MIT |
| remark-gfm | 4.0.1 | Markdown tables and other GFM syntax | MIT |
| @testing-library/react | 16.3.3 | test development | MIT |
| @types/node | 24.19.2 | development types | MIT |
| @types/react | 19.3.0 | development types | MIT |
| @types/react-dom | 19.3.0 | development types | MIT |
| @vitejs/plugin-react | 5.2.0 | example/build development | MIT |
| jsdom | 27.4.0 | test development | MIT |
| typescript | 5.9.3 | build development | Apache-2.0 |
| vite | 7.3.7 | example/build development | MIT |
| vitest | 5.0.3 | test development | MIT |

This table records lockfile metadata; it does not imply that development-only tools are part of the server bundle. The repository's MIT LICENSE carries the project's copyright line.

## Required notice for the bundled React runtime

The Chat server browser assets include React 19.3.0, React DOM 19.3.0, and Scheduler 0.28.0. The locked package archives declare MIT and contain identical `LICENSE` files. Their complete copyright and permission notice is reproduced here; this file is included in the Chat server release archive.

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Required notices for Markdown rendering

The bundled Markdown renderer and GFM plugin declare MIT licenses. Their complete notices are reproduced below; this file is included in the Chat server release archive.

The MIT License (MIT)

Copyright (c) Espen Hovlandsdal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

(The MIT License)

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
