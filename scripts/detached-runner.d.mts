export type ProcessIdentity = { pid: number; ppid: number; pgid: number; birth: string };
export function digest(bytes: string | Buffer): string;
export function processes(): ProcessIdentity[];
export function same(a?: ProcessIdentity, b?: ProcessIdentity): boolean;
export function save(path: string, value: unknown): void;
