export type ProcessIdentity = { pid: number; ppid: number; pgid: number; birth: string };
export type ProcessRow = ProcessIdentity & { state: string };
export type ProcessTable = { source: 'ps' | 'sysctl'; read(): ProcessRow[]; interval: number };
export function digest(bytes: string | Buffer): string;
export function parseSysctlTable(text: string): ProcessRow[];
export function sysctlTable(python: string): ProcessRow[];
export function resolvePython(launcher?: string): string;
export function selectProcessTable(forced?: string): ProcessTable;
export function processTable(): ProcessTable;
export function processes(): ProcessRow[];
export function same(a?: ProcessIdentity, b?: ProcessIdentity): boolean;
export function track(table: ProcessRow[], observed: Map<number, ProcessRow>): ProcessRow[];
export function save(path: string, value: unknown): void;

export function failureDetails(error: unknown, stage: string): { stage: string; type?: string; code?: string; exit_code?: number; signal?: string; killed?: boolean };

export class BoundedOutput {
  constructor(path: string, limit: number);
  truncated: boolean;
  append(chunk: Buffer): void;
  flush(): void;
}
