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
          <h2>可靠更新</h2>
          <button onClick={close} disabled={busy}>
            关闭
          </button>
        </div>
        <p>
          更新前保存项目。下载会验证发布签名、源码版本和
          SHA256，并保留当前版本安装包。
        </p>
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
                      message("更新包和回滚包均已校验");
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
                <p>当前运行模式请前往客户端下载页获取最新安装包，建议保留旧版安装程序以便回退。</p>
              ))}
          </>
        ) : (
          <p>
            便携版或离线环境可通过官方签名安装包升级；本地工程文件与自动恢复记录在升级后完整保留。
          </p>
        )}
        <p>
          Windows
          安装版升级后将自动校验新版本启动状态，若安装异常或启动超时会自动回退至上一稳定版本。
        </p>
      </section>
    </div>
  );
}
