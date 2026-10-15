import { useEffect, useRef, useState } from "react";
import { request, getConfig, openExternal } from "./platform";
import { parseProject } from "./project";
import type { Editor } from "./engine";
import { priceLabel, usageLabel, type ModelPrice, type UsageReceipt } from "./usage";

type Grants = { sync: boolean; ai: boolean; bot: boolean };
type Session = { token: string; name: string; grants: Grants };
// Session stays in memory; no Chat token or service credential enters a project,
// localStorage, recovery record, or native installation package.
let session: Session | null = null;
let cloudETag: string | null = null;
let pending: string | null = null;

export function Connections({
  editor,
  adopt,
  close,
  message,
}: {
  editor: Editor;
  adopt: (content: string) => Promise<boolean>;
  close: () => void;
  message: (value: string, error?: boolean) => void;
}) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState(session);
  const [waiting, setWaiting] = useState(!!pending);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [botToken, setBotToken] = useState("");
  const [models, setModels] = useState<ModelPrice[]>([]);
  const [usage, setUsage] = useState<UsageReceipt[]>([]);
  const aiRequest = useRef<{ prompt: string; id: string } | null>(null);
  const mounted = useRef(true);
  const operation = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      message((error as Error).message, true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void getConfig()
      .then(setConfig)
      .catch((e) => message(e.message, true));
    return () => {
      mounted.current = false;
    };
  }, [message]);
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request("auth/poll", "POST", {
          requestId: pending,
        });
        if (cancelled) return;
        if (result.session) {
          session = result.session;
          pending = null;
          cloudETag = null;
          setCurrent(session);
          setWaiting(false);
        } else timer = setTimeout(poll, 2000);
      } catch (error) {
        if (!cancelled) {
          setWaiting(false);
          message((error as Error).message, true);
        }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiting, message]);
  useEffect(() => {
    if (!current) { setModels([]); setUsage([]); return; }
    let cancelled = false;
    const load = async () => {
      const records = await request("ai/usage", "GET", undefined, current.token);
      if (!cancelled) setUsage(records.data);
      if (current.grants.ai) {
        const catalog = await request("ai/models", "GET", undefined, current.token);
        if (!cancelled) setModels(catalog.data);
      }
    };
    void load().catch(() => {});
    const timer = setInterval(() => void load().catch(() => {}), 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [current]);
  const changeGrant = (key: keyof Grants, value: boolean) =>
    void operation(async () => {
      const grants = { ...session!.grants, [key]: value };
      await request("grants", "PUT", grants, session!.token);
      session = { ...session!, grants };
      setCurrent(session);
      if (!value && key === "bot") setBotToken("");
    });
  return (
    <div className="modal-backdrop">
      <section
        className="modal connections"
        role="dialog"
        aria-modal="true"
        aria-label="账户与连接"
      >
        <div className="modal-heading">
          <h2>账户与连接</h2>
          <button onClick={close} disabled={busy}>
            关闭
          </button>
        </div>
        <p>本地编辑和自动恢复始终可离线使用。在线功能由你逐项开启。</p>
        {!current ? (
          <>
            <button
              className="primary"
              disabled={busy || waiting || !config["ecosystem.url"]}
              onClick={() =>
                void operation(async () => {
                  const result = await request("auth/begin", "POST");
                  pending = result.requestId;
                  try {
                    await openExternal(result.authorizeUrl);
                    setWaiting(true);
                  } catch (e) {
                    await request("auth/cancel", "POST", {
                      requestId: pending,
                    });
                    pending = null;
                    throw e;
                  }
                })
              }
            >
              用 Chat 授权登录
            </button>
            {(waiting || pending) && (
              <button
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await request("auth/cancel", "POST", {
                      requestId: pending,
                    });
                    pending = null;
                    setWaiting(false);
                  })
                }
              >
                取消授权
              </button>
            )}
            {!config["ecosystem.url"] && <p>在线服务尚未开通。</p>}
          </>
        ) : (
          <>
            <p>已登录：{current.name}</p>
            {(["sync", "ai", "bot"] as const).map((key, i) => (
              <label className="grant" key={key}>
                <input
                  type="checkbox"
                  checked={current.grants[key]}
                  disabled={busy}
                  onChange={(event) => changeGrant(key, event.target.checked)}
                />
                {["账户项目同步", "TokenHub AI 建议", "Bot 项目操作与下载"][i]}
              </label>
            ))}
            <div className="connection-actions">
              <button
                disabled={busy || !current.grants.sync}
                onClick={() =>
                  void operation(async () => {
                    if (cloudETag === null) {
                      const remote = await request(
                        "project",
                        "GET",
                        undefined,
                        current.token,
                      );
                      if (remote.content)
                        throw new Error(
                          "账户已有项目，请先下载云端版本；下载前不会覆盖云端。",
                        );
                      cloudETag = remote.etag;
                    }
                    const result = await request(
                      "project",
                      "PUT",
                      { content: editor.serialize() },
                      current.token,
                      cloudETag!,
                    );
                    cloudETag = result.etag;
                    message("项目已同步到当前账户");
                  })
                }
              >
                上传当前项目
              </button>
              <button
                disabled={busy || !current.grants.sync}
                onClick={() =>
                  void operation(async () => {
                    const result = await request(
                      "project",
                      "GET",
                      undefined,
                      current.token,
                    );
                    if (!result.content) throw new Error("账户尚无同步项目");
                    parseProject(result.content);
                    if (await adopt(result.content)) cloudETag = result.etag;
                  })
                }
              >
                下载云端项目
              </button>
              <button
                disabled={busy || !current.grants.bot}
                onClick={() =>
                  void operation(async () => {
                    const result = await request(
                      "bot/token",
                      "POST",
                      undefined,
                      current.token,
                    );
                    setBotToken(result.token);
                  })
                }
              >
                生成 Bot 授权
              </button>
            </div>
            {botToken && (
              <label className="form-label">
                Bot 专用令牌（1 小时；关闭 Bot 权限立即撤销）
                <input
                  readOnly
                  value={botToken}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
            )}
            <p>
              Bot
              可对已同步项目改名、调整图层显隐/不透明度和下载。撤销同步后云端项目会删除。
            </p>
            {current.grants.ai && <div aria-label="AI 模型价格">
              {models.length ? models.map((model) => <p key={model.id}>
                {priceLabel(model)}
                <br />输入 / 输出每百万 token：{model.input_fen_per_million == null ? "待配置" : model.input_fen_per_million / 100} / {model.output_fen_per_million == null ? "待配置" : model.output_fen_per_million / 100} {model.currency ?? ""}
              </p>) : <p>模型价格待确认</p>}
            </div>}
            <label className="form-label">
              AI 建议（只发送输入文字）
              <textarea
                value={prompt}
                maxLength={4000}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !current.grants.ai || !prompt.trim()}
              onClick={() =>
                void operation(async () => {
                  if (aiRequest.current?.prompt !== prompt)
                    aiRequest.current = { prompt, id: crypto.randomUUID() };
                  try {
                    const result = await request("ai/text", "POST", { prompt, request_id: aiRequest.current.id }, current.token);
                    setAnswer(result.text);
                    aiRequest.current = null;
                  } finally {
                    const records = await request("ai/usage", "GET", undefined, current.token);
                    setUsage(records.data);
                  }
                })
              }
            >
              获取 TokenHub 建议
            </button>
            <details>
              <summary>用量与实扣（{usage.length} 条）</summary>
              {usage.map((value) => <p key={`${value.hub}/${value.request_id}`}>
                {value.model} · {usageLabel(value)}<br />{value.hub} / {value.request_id}
              </p>)}
            </details>
            {answer && (
              <>
                <p className="ai-answer">{answer}</p>
                <button
                  disabled={busy}
                  onClick={() => {
                    try {
                      editor.addText({ x: 40, y: 40 }, answer.slice(0, 10000));
                      message("AI 文字已添加为可撤销图层");
                    } catch (e) {
                      message((e as Error).message, true);
                    }
                  }}
                >
                  添加为文字图层
                </button>
              </>
            )}
            <button
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  const result = await request(
                    "session",
                    "DELETE",
                    undefined,
                    current.token,
                  );
                  session = null;
                  cloudETag = null;
                  setCurrent(null);
                  setBotToken("");
                  setAnswer("");
                  aiRequest.current = null;
                  message(
                    result.chatRevoked === false
                      ? "本应用会话及在线权限已撤销。Chat 暂未确认撤销，请到账户中心查看。"
                      : "账户会话及在线权限已撤销",
                  );
                })
              }
            >
              退出并撤销全部在线权限
            </button>
          </>
        )}
        <div className="connection-actions">
          {(["support.url", "downloads.url", "bot.url"] as const).map(
            (key, i) => (
              <button
                key={key}
                disabled={!config[key]}
                onClick={() =>
                  void operation(async () => {
                    await openExternal(config[key]);
                  })
                }
              >
                {["统一支持", "五端下载", "打开 Bot"][i]}
              </button>
            ),
          )}
        </div>
      </section>
    </div>
  );
}
