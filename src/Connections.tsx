import { useEffect, useRef, useState } from "react";
import {
  request,
  getConfig,
  openExternal,
  formatServiceError,
} from "./platform";
import { parseProject } from "./project";
import type { Editor } from "./engine";

export type Grants = { sync: boolean; ai: boolean; bot: boolean };
export type Session = {
  token: string;
  name: string;
  user_id?: string;
  auth_channel?: string;
  grants: Grants;
};
export type ModelItem = {
  id: string;
  model_id: string;
  display_name: string;
  region: string;
};

const FALLBACK_MODELS: ModelItem[] = [
  {
    id: "qwen-plus",
    model_id: "qwen-plus",
    display_name: "Qwen Plus (CN)",
    region: "cn",
  },
  {
    id: "deepseek-v3",
    model_id: "deepseek-v3",
    display_name: "DeepSeek V3 (CN)",
    region: "cn",
  },
  {
    id: "gpt-4o-mini",
    model_id: "gpt-4o-mini",
    display_name: "GPT-4o Mini (Global)",
    region: "global",
  },
  {
    id: "claude-3-5-sonnet",
    model_id: "claude-3-5-sonnet",
    display_name: "Claude 3.5 Sonnet (Global)",
    region: "global",
  },
];

// Session stays in memory; no service credential enters a project,
// localStorage, recovery record, or native installation package.
let session: Session | null = null;
let cloudETag: string | null = null;
let pending: string | null = null;

export function getActiveSession(): Session | null {
  return session;
}

export function Connections({
  editor,
  adopt,
  close,
  message,
  openSupport,
}: {
  editor: Editor;
  adopt: (content: string) => Promise<boolean>;
  close: () => void;
  message: (value: string, error?: boolean) => void;
  openSupport?: () => void;
}) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState(session);
  const [waiting, setWaiting] = useState(!!pending);
  const [busy, setBusy] = useState(false);
  const [authChannel, setAuthChannel] = useState<
    | "chat"
    | "local"
    | "verification_code"
    | "wechat"
    | "alipay"
    | "douyin"
    | "baidu"
  >("chat");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [models, setModels] = useState<ModelItem[]>(FALLBACK_MODELS);
  const [selectedModel, setSelectedModel] = useState<string>("qwen-plus");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [botToken, setBotToken] = useState("");
  const mounted = useRef(true);
  const operation = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      message(formatServiceError((error as Error).message), true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void getConfig()
      .then((loaded) => {
        if (!mounted.current) return;
        setConfig(loaded);
        if (loaded["ecosystem.url"]) {
          void request("ai/models", "GET", undefined, session?.token)
            .then((catalog) => {
              if (!mounted.current) return;
              if (Array.isArray(catalog?.models) && catalog.models.length > 0) {
                setModels(catalog.models);
                setSelectedModel(
                  catalog.default_model ?? catalog.models[0].model_id,
                );
              }
            })
            .catch(() => {});
        }
      })
      .catch((e) => message(formatServiceError(e.message), true));
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
          request_id: pending,
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
          message(formatServiceError((error as Error).message), true);
        }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiting, message]);
  const changeGrant = (key: keyof Grants, value: boolean) =>
    void operation(async () => {
      const grants = { ...session!.grants, [key]: value };
      await request("grants", "PUT", grants, session!.token);
      session = { ...session!, grants };
      setCurrent(session);
      if (!value && key === "bot") setBotToken("");
    });
  const adoptSession = (nextSession: Session) => {
    session = nextSession;
    pending = null;
    cloudETag = null;
    setCurrent(nextSession);
    setWaiting(false);
  };
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
            <label className="form-label">
              登录方式
              <select
                aria-label="登录方式"
                value={authChannel}
                disabled={busy || waiting}
                onChange={(e) =>
                  setAuthChannel(e.target.value as typeof authChannel)
                }
              >
                <option value="chat">Chat 授权登录 (PKCE)</option>
                <option value="local">本地账号密码登录 / 注册</option>
                <option value="verification_code">手机 / 邮箱验证码登录</option>
                <option value="wechat">微信登录 (wechat)</option>
                <option value="alipay">支付宝登录 (alipay)</option>
                <option value="douyin">抖音登录 (douyin)</option>
                <option value="baidu">百度登录 (baidu)</option>
              </select>
            </label>
            {authChannel === "local" && (
              <>
                <label className="form-label">
                  账号（用户名 / 邮箱 / 手机号）
                  <input
                    aria-label="登录账号"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                </label>
                <label className="form-label">
                  密码
                  <input
                    aria-label="登录密码"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <div className="connection-actions">
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !config["ecosystem.url"] ||
                      !identifier.trim() ||
                      password.length < 6
                    }
                    onClick={() =>
                      void operation(async () => {
                        const result = await request("auth/login", "POST", {
                          username: identifier.trim(),
                          password,
                        });
                        adoptSession(result.session);
                        message("本地账号登录成功");
                      })
                    }
                  >
                    账号登录
                  </button>
                  <button
                    disabled={
                      busy ||
                      !config["ecosystem.url"] ||
                      !identifier.trim() ||
                      password.length < 6
                    }
                    onClick={() =>
                      void operation(async () => {
                        const result = await request("auth/register", "POST", {
                          username: identifier.trim(),
                          password,
                        });
                        adoptSession(result.session);
                        message("账号注册并登录成功");
                      })
                    }
                  >
                    注册新账号
                  </button>
                </div>
              </>
            )}
            {authChannel === "verification_code" && (
              <>
                <label className="form-label">
                  手机号或邮箱
                  <input
                    aria-label="验证码接收目标"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                </label>
                <label className="form-label">
                  验证码
                  <input
                    aria-label="验证码"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                  />
                </label>
                <div className="connection-actions">
                  <button
                    disabled={
                      busy || !config["ecosystem.url"] || !identifier.trim()
                    }
                    onClick={() =>
                      void operation(async () => {
                        const result = await request("auth/code/send", "POST", {
                          target: identifier.trim(),
                        });
                        setChallengeId(result.challenge_id);
                        message("验证码已发送");
                      })
                    }
                  >
                    发送验证码
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !config["ecosystem.url"] ||
                      !identifier.trim() ||
                      !verifyCode.trim()
                    }
                    onClick={() =>
                      void operation(async () => {
                        const result = await request(
                          "auth/code/login",
                          "POST",
                          {
                            challenge_id: challengeId,
                            target: identifier.trim(),
                            code: verifyCode.trim(),
                          },
                        );
                        adoptSession(result.session);
                        message("验证码登录成功");
                      })
                    }
                  >
                    验证码登录
                  </button>
                </div>
              </>
            )}
            {(authChannel === "wechat" ||
              authChannel === "alipay" ||
              authChannel === "douyin" ||
              authChannel === "baidu") && (
              <button
                className="primary"
                disabled={busy || waiting || !config["ecosystem.url"]}
                onClick={() =>
                  void operation(async () => {
                    const result = await request(
                      `auth/oauth/${authChannel}/authorize`,
                      "POST",
                    );
                    pending = result.request_id ?? result.requestId;
                    setWaiting(true);
                  })
                }
              >
                发起第三方 OAuth 授权 ({authChannel})
              </button>
            )}
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
                {
                  [
                    "账户项目同步",
                    "AI 模型服务建议",
                    "Bot / MCP 项目操作与下载",
                  ][i]
                }
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
                Bot / MCP 专用令牌（1 小时；关闭 Bot 权限立即撤销）
                <input
                  readOnly
                  value={botToken}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
            )}
            <p>
              Bot / MCP
              支持项目新建、列表、读取、资产导入导出、破坏性编辑预览确认和撤销回滚。撤销同步后云端项目会删除。
            </p>
            <label className="form-label">
              AI 模型选择
              <select
                aria-label="AI 模型选择"
                value={selectedModel}
                disabled={busy || !current.grants.ai}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {models.map((item) => (
                  <option
                    key={item.model_id ?? item.id}
                    value={item.model_id ?? item.id}
                  >
                    {item.display_name} ({item.region})
                  </option>
                ))}
              </select>
            </label>
            <label className="form-label">
              AI 建议（只发送输入文字与所选受控模型）
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
                  const result = await request(
                    "ai/text",
                    "POST",
                    { prompt, model: selectedModel },
                    current.token,
                  );
                  setAnswer(result.text);
                })
              }
            >
              获取 AI 模型服务建议
            </button>
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
            <div className="connection-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    const result = await request(
                      "auth/logout",
                      "POST",
                      {},
                      current.token,
                    );
                    session = null;
                    cloudETag = null;
                    setCurrent(null);
                    setBotToken("");
                    setAnswer("");
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
              {openSupport && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => openSupport()}
                >
                  在线客服会话与工单
                </button>
              )}
            </div>
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
