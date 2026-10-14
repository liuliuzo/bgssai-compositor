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
                <p>当前平台请从五端下载入口安装。保留上一版用于回滚。</p>
              ))}
          </>
        ) : (
          <p>
            iOS / Android
            通过系统商店或已签名安装包更新；本地项目与恢复记录不随版本更改。
          </p>
        )}
        <p>
          Windows
          安装版升级后会检查新版本启动，安装失败或启动检查超时会自动安装上一版。
        </p>
      </section>
    </div>
  );
}
