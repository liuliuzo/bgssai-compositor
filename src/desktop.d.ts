export interface OpenedFile {
  name: string;
  kind: "project" | "image";
  data: string;
  token?: string;
}
export interface DesktopBridge {
  openFile(kind: "document" | "image"): Promise<OpenedFile | null>;
  adoptProject(token: string): Promise<void>;
  saveProject(
    name: string,
    content: string,
    saveAs: boolean,
  ): Promise<{ name: string; path: string } | null>;
  exportImage(
    name: string,
    data: string,
    format: "png" | "jpeg",
  ): Promise<{ path: string } | null>;
  readClipboard(): Promise<string | null>;
  setDirty(value: boolean): void;
  setTitle(value: string): void;
  resetProjectPath(): void;
  confirmClose(): void;
  getInfo(): Promise<{ version: string; channel: string }>;
  readRecovery(): Promise<{ content: string; writtenAt: number } | null>;
  writeRecovery(content: string): Promise<number>;
  clearRecovery(): Promise<void>;
  getConnections(): Promise<Record<string, string>>;
  requestConnection(request: {
    route: string;
    method: string;
    body?: unknown;
    token?: string;
    etag?: string;
  }): Promise<any>;
  openExternal(url: string): Promise<void>;
  checkUpdate(): Promise<{ version: string; sourceSha: string }>;
  stageUpdate(): Promise<{ version: string; canInstall: boolean }>;
  installUpdate(): Promise<void>;
  updateResult(): Promise<{
    status: string;
    version?: string;
    reason?: string;
    at: number;
  } | null>;
  updateHealthy(): Promise<void>;
  onAction(callback: (action: string) => void): () => void;
}
declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}
