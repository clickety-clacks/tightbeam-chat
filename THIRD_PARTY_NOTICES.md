# Third-party inventory and notices

No T3 Code or production T3 Chat source, assets or dependencies were copied into this repository. All authored source and synthetic fixture text were created here. The built library externalizes React; it does not bundle a T3 runtime.

The checked-in `package-lock.json` identifies direct packages and the full transitive development tree. Direct package metadata read from that lock during this revision:

| Package | Locked version | Role | Declared license |
| --- | --- | --- | --- |
| react | 19.3.0 | peer; example/test development | MIT |
| react-dom | 19.3.0 | peer; example/test development | MIT |
| @testing-library/react | 16.3.3 | test development | MIT |
| @types/node | 24.19.2 | development types | MIT |
| @types/react | 19.3.0 | development types | MIT |
| @types/react-dom | 19.3.0 | development types | MIT |
| @vitejs/plugin-react | 5.2.0 | example/build development | MIT |
| jsdom | 27.4.0 | test development | MIT |
| typescript | 5.9.3 | build development | Apache-2.0 |
| vite | 7.3.7 | example/build development | MIT |
| vitest | 5.0.3 | test development | MIT |

This is an inventory of lockfile metadata, not a claim that every transitive notice or the product's final MIT copyright line has been cleared. Review the exact dependency tree and distributed output for any further notice obligation before public release. No `LICENSE` file is generated until the authorized copyright-holder text is known.
