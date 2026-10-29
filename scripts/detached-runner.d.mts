export type ProcessIdentity = { pid: number; ppid: number; pgid: number; birth: string };
export function digest(bytes: string | Buffer): string;
export function processes(): (ProcessIdentity & { state: string })[];
export function same(a?: ProcessIdentity, b?: ProcessIdentity): boolean;
export function save(path: string, value: unknown): void;

export function failureDetails(error: unknown, stage: string): { stage: string; type?: string; code?: string; exit_code?: number; signal?: string; killed?: boolean };
