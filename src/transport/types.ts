export type TransportKind = "local" | "wsl" | "wsl-windows-host" | "ssh";

export type PlatformId = "linux" | "darwin" | "win32";

export interface HostInfo {
  platform: PlatformId;
  homeDir: string;
  env: Record<string, string | undefined>;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly label: string;
  readonly canExec: boolean;
  host(): Promise<HostInfo>;
  exists(filePath: string): Promise<boolean>;
  readTextFile(filePath: string): Promise<string>;
  readBinaryFile(filePath: string): Promise<Uint8Array>;
  listDir(dirPath: string): Promise<DirEntry[] | null>;
  glob(pattern: string): Promise<string[]>;
  exec?(argv: string[]): Promise<ExecResult>;
}
