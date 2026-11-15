import { useState } from "react";
export function Updates({
  close,
  message,
}: {
  close: () => void;
  message: (value: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [candidate, setCandidate] = useState<{
      version: string;
      sourceSha: string;
    } | null>(null),
    [staged, setStaged] = useState<{
      version: string;
      canInstall: boolean;
    } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      message((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-label="可靠更新"
        aria-modal="true"
      >
        <div className="modal-heading">
          <h2>检查更新</h2>
          <button onClick={close} disabled={busy}>
            关闭
          </button>
        </div>
        {window.desktop ? (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStaged(null);
                  setCandidate(await window.desktop!.checkUpdate());
                })
              }
            >
              检查签名更新
            </button>
            {candidate && (
              <>
                <p>
                  版本 {candidate.version} · 源码{" "}
                  {candidate.sourceSha.slice(0, 12)}
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setStaged(await window.desktop!.stageUpdate());
                      message("更新包已校验");
                    })
                  }
                >
                  下载并校验
                </button>
              </>
            )}
            {staged &&
              (staged.canInstall ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.desktop!.installUpdate();
                    })
                  }
                >
                  安装并重启
                </button>
              ) : (
                <p>请前往客户端下载页获取安装包。</p>
              ))}
          </>
        ) : (
          <p>当前环境不支持在线检查更新。</p>
        )}
      </section>
    </div>
  );
}
