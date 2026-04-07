import { createRequire } from 'node:module';
export const RustServer = createRequire(import.meta.url)('./mi-rust.node');
