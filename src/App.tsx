import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Brush,
  Check,
  ChevronDown,
  Circle,
  Copy,
  Crop,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FilePlus2,
  FolderOpen,
  Hand,
  HelpCircle,
  ImagePlus,
  Layers3,
  LockKeyhole,
  Maximize,
  Minus,
  MousePointer2,
  Palette,
  Pipette,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Scan,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  Undo2,
  UnlockKeyhole,
  X,
  ZoomIn,
  FlipHorizontal2,
  FlipVertical2,
} from "lucide-react";
import {
  Editor,
  corners,
  geometry,
  type Layer,
  type Selection,
  type Tool,
} from "./engine";
import {
  BLENDS,
  FONTS,
  checkDimensions,
  type Point,
  type TextContent,
} from "./project";
import type { OpenedFile } from "./desktop";
import { recovery, type Recovery } from "./recovery";
import {
  native,
  platformName,
  saveNative,
  request,
  formatServiceError,
} from "./platform";
import { Connections, getActiveSession } from "./Connections";
import { Updates } from "./Updates";
import { parseProject } from "./project";

const editor = new Editor();
if (native) editor.memoryBudget = 320 * 1024 * 1024;
const TOOLS: { id: Tool; name: string; key: string; icon: typeof Brush }[] = [
  { id: "move", name: "移动", key: "V", icon: MousePointer2 },
  { id: "select", name: "矩形选区", key: "M", icon: Scan },
  { id: "brush", name: "画笔", key: "B", icon: Brush },
  { id: "eraser", name: "橡皮擦", key: "E", icon: Eraser },
  { id: "rectangle", name: "矩形", key: "U", icon: Square },
  { id: "ellipse", name: "椭圆", key: "O", icon: Circle },
  { id: "text", name: "文字", key: "T", icon: Type },
  { id: "eyedropper", name: "吸管", key: "I", icon: Pipette },
  { id: "hand", name: "抓手", key: "H", icon: Hand },
];
type Modal =
  | "new"
  | "export"
  | "help"
  | "connections"
  | "updates"
  | "support"
  | null;
type Gesture = {
  type: Tool | "scale";
  start: Point;
  previous: Point;
  layer?: Layer;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  scrollX: number;
  scrollY: number;
  clientX: number;
  clientY: number;
};
function download(name: string, content: string, type: string) {
  const url = content.startsWith("data:")
    ? content
    : URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function readFile(file: File): Promise<OpenedFile> {
  if (file.size > 128 * 1024 * 1024)
    return Promise.reject(new Error("文件超过 128 MB。"));
  if (file.name.toLowerCase().endsWith(".bgcomp"))
    return file
      .text()
      .then((data) => ({ name: file.name, kind: "project", data }));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        name: file.name,
        kind: "image",
        data: reader.result as string,
      });
    reader.onerror = () => reject(new Error("无法读取文件。"));
    reader.readAsDataURL(file);
  });
}
function Button({
  children,
  title,
  onClick,
  disabled,
  className = "",
}: {
  children: ReactNode;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function NumberField({
  label,
  value,
  onCommit,
  min = -100000,
  max = 100000,
  disabled = false,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value]);
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        value={draft}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const number = draft.trim() ? Number(draft) : NaN;
          if (Number.isFinite(number)) {
            const next = Math.min(max, Math.max(min, number));
            if (next !== value) onCommit(next);
            setDraft(String(Math.round(next * 100) / 100));
          } else setDraft(String(value));
        }}
      />
    </label>
  );
}
function Thumbnail({ layer, revision }: { layer: Layer; revision: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, 44, 36);
    const scale = Math.min(44 / layer.canvas.width, 36 / layer.canvas.height);
    context.drawImage(
      layer.canvas,
      (44 - layer.canvas.width * scale) / 2,
      (36 - layer.canvas.height * scale) / 2,
      layer.canvas.width * scale,
      layer.canvas.height * scale,
    );
  }, [layer, revision]);
  return <canvas ref={ref} width="44" height="36" className="thumbnail" />;
}
function TextProperties({
  layer,
  safe,
}: {
  layer: Layer;
  safe: (fn: () => void) => void;
}) {
  const text = layer.text!;
  const [value, setValue] = useState(text.value);
  useEffect(() => setValue(text.value), [text.value]);
  const update = (patch: Partial<TextContent>) =>
    safe(() => editor.updateText(patch));
  return (
    <div className="text-properties">
      <textarea
        aria-label="文字内容"
        value={value}
        maxLength={10000}
        disabled={layer.locked}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value !== text.value) update({ value });
        }}
      />
      <div className="two-fields">
        <select
          aria-label="字体"
          value={text.font}
          disabled={layer.locked}
          onChange={(e) =>
            update({ font: e.target.value as TextContent["font"] })
          }
        >
          {FONTS.map((font) => (
            <option key={font}>{font}</option>
          ))}
        </select>
        <NumberField
          label="字号"
          value={text.size}
          min={1}
          max={512}
          disabled={layer.locked}
          onCommit={(size) => update({ size })}
        />
      </div>
      <div className="text-options">
        <label>
          文字颜色{" "}
          <input
            type="color"
            aria-label="文字颜色"
            value={text.color}
            disabled={layer.locked}
            onChange={(e) => update({ color: e.target.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={text.bold}
            disabled={layer.locked}
            onChange={(e) => update({ bold: e.target.checked })}
          />{" "}
          粗体
        </label>
        <Button
          onClick={() => safe(() => editor.rasterize())}
          disabled={layer.locked}
        >
          栅格化
        </Button>
      </div>
    </div>
  );
}

function SupportModal({
  close,
  message,
}: {
  close: () => void;
  message: (value: string, error?: boolean) => void;
}) {
  const active = getActiveSession();
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<
    { session_id: string; subject: string; status: string }[]
  >([]);
  const [messages, setMessages] = useState<
    { message_id: string; sender_role: string; content: string }[]
  >([]);
  const [tickets, setTickets] = useState<
    { ticket_id: string; subject: string; status: string }[]
  >([]);

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const [sessRes, msgRes, tktRes] = await Promise.all([
        request("support/sessions", "GET", undefined, active.token),
        request("support/messages", "GET", undefined, active.token),
        request("support/tickets", "GET", undefined, active.token),
      ]);
      setSessions(Array.isArray(sessRes?.sessions) ? sessRes.sessions : []);
      setMessages(Array.isArray(msgRes?.messages) ? msgRes.messages : []);
      setTickets(Array.isArray(tktRes?.tickets) ? tktRes.tickets : []);
      if (!sessionId && sessRes?.sessions?.[0]?.session_id) {
        setSessionId(sessRes.sessions[0].session_id);
      }
    } catch (error) {
      message(formatServiceError((error as Error).message), true);
    }
  }, [active, message, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runSupport = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (error) {
      message(formatServiceError((error as Error).message), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        className="modal connections"
        role="dialog"
        aria-modal="true"
        aria-label="客服与工单"
      >
        <div className="modal-heading">
          <h2>在线客服会话与工单 (product_code=compositor)</h2>
          <button onClick={close} disabled={busy}>
            关闭
          </button>
        </div>
        {!active ? (
          <p>请先在“账户与连接”中登录账户，以创建受隔离保护的客服会话与工单。</p>
        ) : (
          <>
            <label className="form-label">
              咨询或工单主题
              <input
                aria-label="客服主题"
                value={subject}
                maxLength={200}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label className="form-label">
              咨询消息内容
              <textarea
                aria-label="客服消息内容"
                value={content}
                maxLength={4000}
                onChange={(e) => setContent(e.target.value)}
              />
            </label>
            <div className="connection-actions">
              <button
                className="primary"
                disabled={busy || !subject.trim()}
                onClick={() =>
                  void runSupport(async () => {
                    const created = await request(
                      "support/sessions",
                      "POST",
                      {
                        subject: subject.trim(),
                        initial_message: content.trim(),
                      },
                      active.token,
                    );
                    setSessionId(created.session_id);
                    setContent("");
                    message("客服会话已建立");
                  })
                }
              >
                新建客服会话
              </button>
              <button
                disabled={busy || !content.trim()}
                onClick={() =>
                  void runSupport(async () => {
                    await request(
                      "support/messages",
                      "POST",
                      {
                        session_id: sessionId || undefined,
                        content: content.trim(),
                      },
                      active.token,
                    );
                    setContent("");
                    message("客服消息已发送");
                  })
                }
              >
                发送会话消息
              </button>
              <button
                disabled={busy || !subject.trim() || !content.trim()}
                onClick={() =>
                  void runSupport(async () => {
                    await request(
                      "support/tickets",
                      "POST",
                      {
                        session_id: sessionId || undefined,
                        subject: subject.trim(),
                        content: content.trim(),
                      },
                      active.token,
                    );
                    setContent("");
                    message("客服工单已提交");
                  })
                }
              >
                提交客服工单
              </button>
            </div>
            <p>
              当前会话数：{sessions.length} | 消息数：{messages.length} | 工单数：
              {tickets.length}
            </p>
          </>
        )}
      </section>
    </div>
  );
}

export function App() {
  const revision = useSyncExternalStore(editor.subscribe, editor.getRevision);
  const [welcome, setWelcome] = useState(true);
  const [modal, setModal] = useState<Modal>(null);
  const [zoom, setZoom] = useState(0.6);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [working, setWorking] = useState(false);
  const [panel, setPanel] = useState<"layers" | "history">("layers");
  const [newName, setNewName] = useState("未命名");
  const [newWidth, setNewWidth] = useState(1600);
  const [newHeight, setNewHeight] = useState(1000);
  const [background, setBackground] = useState("transparent");
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [quality, setQuality] = useState(92);
  const [exportBg, setExportBg] = useState("#ffffff");
  const [confirm, setConfirm] = useState<
    ((answer: "save" | "discard" | "cancel") => void) | null
  >(null);
  const [draftShape, setDraftShape] = useState<Selection | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [version, setVersion] = useState("0.1.0");
  const [recoveryOffer, setRecoveryOffer] = useState<Recovery | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState("自动恢复准备中");
  const lastRecovery = useRef<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const artboard = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileMode = useRef<"document" | "image">("document");
  const gesture = useRef<Gesture | null>(null);
  const actionLock = useRef(false);
  const draggedLayer = useRef<string>("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = editor.selected;
  const currentTool = TOOLS.find((tool) => tool.id === editor.tool)!;

  const message = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 7000 : 3500);
  }, []);
  const safe = useCallback(
    (fn: () => void) => {
      if (editor.busy || actionLock.current) return;
      try {
        fn();
      } catch (error) {
        message((error as Error).message, true);
      }
    },
    [message],
  );
  const run = useCallback(
    async (fn: () => Promise<void> | void) => {
      if (actionLock.current || editor.busy || gesture.current) return;
      actionLock.current = true;
      setWorking(true);
      try {
        await fn();
      } catch (error) {
        message((error as Error).message, true);
      } finally {
        actionLock.current = false;
        setWorking(false);
      }
    },
    [message],
  );
  const fit = useCallback(() => {
    const bounds = stage.current?.getBoundingClientRect();
    if (bounds)
      setZoom(
        Math.max(
          0.05,
          Math.min(
            2,
            (bounds.width - 140) / editor.width,
            (bounds.height - 140) / editor.height,
          ),
        ),
      );
  }, []);
  const showDocument = useCallback(() => {
    setWelcome(false);
    requestAnimationFrame(fit);
  }, [fit]);
  const save = useCallback(
    async (saveAs = false) => {
      const json = editor.serialize();
      if (window.desktop) {
        const result = await window.desktop.saveProject(
          editor.name,
          json,
          saveAs,
        );
        if (!result) return false;
        editor.markSaved(json);
        message(`项目已保存：${result.name}`);
      } else {
        if (native) await saveNative(editor.name, json, "bgcomp");
        else download(`${editor.name}.bgcomp`, json, "application/json");
        editor.markSaved(json);
        message("项目已下载");
      }
      await recovery.clear();
      lastRecovery.current = null;
      setAutosaveStatus("项目已保存");
      return true;
    },
    [message],
  );
  const guard = useCallback(async () => {
    if (!editor.dirty) return true;
    const answer = await new Promise<"save" | "discard" | "cancel">((resolve) =>
      setConfirm(() => resolve),
    );
    setConfirm(null);
    if (answer === "cancel") return false;
    return answer === "save" ? save() : true;
  }, [save]);
  const openFile = useCallback(
    async (file: OpenedFile, asLayer: boolean) => {
      if (asLayer) {
        if (file.kind !== "image")
          throw new Error("项目文件请通过“打开”读取。");
        await editor.importImage(file.data, file.name);
        setWelcome(false);
        message("图像已添加为新图层");
        return;
      }
      if (!(await guard())) return;
      if (file.kind === "project") {
        await editor.load(file.data);
        if (window.desktop && file.token)
          await window.desktop.adoptProject(file.token);
        else window.desktop?.resetProjectPath();
      } else {
        await editor.openImage(file.data, file.name);
        window.desktop?.resetProjectPath();
      }
      await recovery.clear();
      lastRecovery.current = null;
      showDocument();
      message(`已打开 ${file.name}`);
    },
    [guard, message, showDocument],
  );
  const chooseFile = useCallback(
    async (kind: "document" | "image") => {
      if (window.desktop) {
        const result = await window.desktop.openFile(kind);
        if (result) await openFile(result, kind === "image");
      } else {
        fileMode.current = kind;
        fileInput.current?.click();
      }
    },
    [openFile],
  );
  const action = useCallback(
    (name: string) => {
      if (!recoveryReady) {
        message("正在检查自动恢复，请稍候");
        return;
      }
      if (
        (recoveryOffer && !["help", "connections", "updates"].includes(name))
      ) {
        message("请先恢复或丢弃上次的自动恢复项目");
        return;
      }
      void run(async () => {
        switch (name) {
          case "new":
            setModal("new");
            break;
          case "open":
            await chooseFile("document");
            break;
          case "import":
            await chooseFile("image");
            break;
          case "save":
            await save();
            break;
          case "save-as":
            await save(true);
            break;
          case "export":
            setModal("export");
            break;
          case "undo":
            await editor.undo();
            break;
          case "redo":
            await editor.redo();
            break;
          case "duplicate":
            editor.duplicate();
            break;
          case "deselect":
            editor.selection = null;
            editor.notify();
            break;
          case "fit":
            fit();
            break;
          case "actual-size":
            setZoom(1);
            break;
          case "help":
            setModal("help");
            break;
          case "connections":
            setModal("connections");
            break;
          case "updates":
            setModal("updates");
            break;
          case "close":
            if (await guard()) window.desktop?.confirmClose();
            break;
          case "demo":
            if (await guard()) {
              editor.demo();
              await recovery.clear();
              lastRecovery.current = null;
              window.desktop?.resetProjectPath();
              showDocument();
            }
            break;
          case "paste": {
            const image = await window.desktop?.readClipboard();
            if (image) {
              await editor.importImage(image, "剪贴板图像");
              setWelcome(false);
            } else message("剪贴板中没有图像");
            break;
          }
        }
      });
    },
    [
      chooseFile,
      fit,
      guard,
      message,
      run,
      save,
      showDocument,
      recoveryReady,
      recoveryOffer,
    ],
  );

  useEffect(() => {
    let active = true;
    void recovery
      .read()
      .then((value) => {
        if (value) parseProject(value.content);
        if (active) {
          setRecoveryOffer(value);
          setRecoveryReady(true);
          setAutosaveStatus(value ? "发现可恢复项目" : "自动恢复已就绪");
        }
      })
      .catch((error) => {
        if (active) {
          setRecoveryReady(true);
          setAutosaveStatus("恢复读取失败，请手动保存");
          message(error.message, true);
        }
      });
    void window.desktop
      ?.updateHealthy()
      .catch((error) => message(error.message, true));
    void window.desktop
      ?.updateResult()
      .then((result) => {
        if (result?.status === "rolled-back" || result?.status === "failed")
          message(
            `更新${result.status === "rolled-back" ? "已回滚" : "失败"}：${result.reason}`,
            true,
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [message]);
  useEffect(() => {
    if (!recoveryReady || recoveryOffer || welcome) return;
    let active = true;
    const flush = async () => {
      const snapshot = editor.snapshot;
      if (
        !editor.dirty ||
        !snapshot ||
        snapshot === lastRecovery.current ||
        editor.busy ||
        actionLock.current ||
        gesture.current
      )
        return;
      try {
        const at = await recovery.write(snapshot);
        if (active) {
          lastRecovery.current = snapshot;
          setAutosaveStatus(
            `已自动恢复保存 ${new Date(at).toLocaleTimeString()}`,
          );
        }
      } catch (error) {
        if (active) {
          setAutosaveStatus("自动恢复失败，请手动保存");
          message((error as Error).message, true);
        }
      }
    };
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), 1500);
    };
    schedule();
    const unsubscribe = editor.subscribe(schedule);
    const interval = setInterval(() => void flush(), 10000);
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      active = false;
      unsubscribe();
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [recoveryReady, recoveryOffer, welcome, message]);

  useEffect(() => {
    window.desktop?.setDirty(editor.dirty);
    window.desktop?.setTitle(`${editor.dirty ? "● " : ""}${editor.name}`);
  }, [revision]);
  useEffect(() => window.desktop?.onAction(action), [action]);
  useEffect(() => {
    void window.desktop
      ?.getInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {});
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (canvas.current && !welcome) editor.render(canvas.current);
  }, [revision, welcome]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const editable =
        event.target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) ||
          event.target.isContentEditable);
      if (event.key === "Escape") {
        if (confirm) {
          confirm("cancel");
          return;
        }
        setModal(null);
        editor.selection = null;
        editor.notify();
        return;
      }
      if (
        editable ||
        modal ||
        confirm ||
        working ||
        editor.busy ||
        gesture.current
      )
        return;
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        const map: Record<string, string> = {
          n: "new",
          o: event.shiftKey ? "import" : "open",
          s: event.shiftKey ? "save-as" : "save",
          e: "export",
          z: event.shiftKey ? "redo" : "undo",
          y: "redo",
          j: "duplicate",
          d: "deselect",
          "0": "fit",
          "1": "actual-size",
        };
        if (map[key] && (!window.desktop || key === "y")) {
          event.preventDefault();
          action(map[key]);
        }
        return;
      }
      const tool = TOOLS.find(
        (entry) => entry.key.toLowerCase() === event.key.toLowerCase(),
      );
      if (tool) {
        event.preventDefault();
        editor.tool = tool.id;
        editor.notify();
        return;
      }
      if (event.key === "[" || event.key === "]") {
        editor.brushSize = Math.max(
          1,
          Math.min(500, editor.brushSize + (event.key === "[" ? -5 : 5)),
        );
        editor.notify();
      }
      if (event.key === "Delete") {
        event.preventDefault();
        safe(() =>
          editor.selection ? editor.clearSelection() : editor.remove(),
        );
      }
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
          event.key,
        ) &&
        editor.tool === "move" &&
        !welcome
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        safe(() =>
          editor.patch(
            {
              x:
                editor.selected.x +
                (event.key === "ArrowLeft"
                  ? -step
                  : event.key === "ArrowRight"
                    ? step
                    : 0),
              y:
                editor.selected.y +
                (event.key === "ArrowUp"
                  ? -step
                  : event.key === "ArrowDown"
                    ? step
                    : 0),
            },
            "移动图层",
          ),
        );
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    const onPaste = (event: ClipboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA"].includes(event.target.tagName) ||
          event.target.isContentEditable)
      )
        return;
      if (modal || confirm || working) return;
      const file = [...(event.clipboardData?.files ?? [])].find((entry) =>
        entry.type.startsWith("image/"),
      );
      if (file) {
        event.preventDefault();
        void run(async () => openFile(await readFile(file), true));
      } else if (window.desktop) {
        event.preventDefault();
        action("paste");
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("paste", onPaste);
    };
  }, [action, confirm, modal, openFile, run, safe, welcome, working]);
  useEffect(() => {
    const target = stage.current;
    if (!target) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        setZoom((value) =>
          Math.min(4, Math.max(0.05, value * (event.deltaY > 0 ? 0.9 : 1.1))),
        );
      }
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
  }, []);

  function position(event: ReactPointerEvent): Point {
    const bounds = artboard.current!.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / zoom,
      y: (event.clientY - bounds.top) / zoom,
    };
  }
  function clamped(p: Point): Point {
    return {
      x: Math.max(0, Math.min(editor.width, p.x)),
      y: Math.max(0, Math.min(editor.height, p.y)),
    };
  }
  function box(a: Point, b: Point, square = false): Selection {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if (square) {
      const size = Math.min(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx) * size;
      dy = Math.sign(dy) * size;
    }
    return {
      x: Math.min(a.x, a.x + dx),
      y: Math.min(a.y, a.y + dy),
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  }
  function startGesture(event: ReactPointerEvent, scale = false) {
    if (
      event.button !== 0 ||
      working ||
      editor.busy ||
      modal ||
      confirm ||
      welcome
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const point = position(event);
    const type = scale ? "scale" : spaceHeld ? "hand" : editor.tool;
    try {
      if (type === "eyedropper") {
        const p = clamped(point);
        const rgba = canvas
          .current!.getContext("2d")!
          .getImageData(
            Math.min(editor.width - 1, Math.floor(p.x)),
            Math.min(editor.height - 1, Math.floor(p.y)),
            1,
            1,
          ).data;
        editor.color = `#${[...rgba.slice(0, 3)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
        editor.notify();
        return;
      }
      if (type === "text") {
        editor.addText(clamped(point));
        return;
      }
      if (type === "move" && !scale) {
        const hit = editor.hit(point);
        if (hit && !event.shiftKey) editor.select(hit.id);
      }
      const layer = editor.selected;
      if (["move", "scale", "brush", "eraser"].includes(type) && layer.locked)
        throw new Error("请先解锁图层。");
      if (type === "brush" || type === "eraser")
        editor.paint(
          point,
          point,
          type === "eraser",
          event.pointerType === "pen" ? Math.max(0.05, event.pressure) : 1,
        );
      gesture.current = {
        type,
        start: ["select", "rectangle", "ellipse"].includes(type)
          ? clamped(point)
          : point,
        previous: point,
        layer,
        x: layer.x,
        y: layer.y,
        scaleX: layer.scaleX,
        scaleY: layer.scaleY,
        scrollX: stage.current!.scrollLeft,
        scrollY: stage.current!.scrollTop,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (type === "select") {
        editor.selection = null;
        editor.notify();
      }
    } catch (error) {
      gesture.current = null;
      message((error as Error).message, true);
    }
  }
  function moveGesture(event: ReactPointerEvent) {
    const point = position(event);
    setPointer(point);
    const drag = gesture.current;
    if (!drag) return;
    try {
      if (drag.type === "hand") {
        stage.current!.scrollLeft =
          drag.scrollX - (event.clientX - drag.clientX);
        stage.current!.scrollTop =
          drag.scrollY - (event.clientY - drag.clientY);
      } else if (drag.type === "move") {
        editor.patch(
          {
            x: Math.round(drag.x + point.x - drag.start.x),
            y: Math.round(drag.y + point.y - drag.start.y),
          },
          "移动图层",
          true,
        );
      } else if (drag.type === "scale") {
        const layer = drag.layer!;
        const center = {
          x: drag.x + (layer.canvas.width * drag.scaleX) / 2,
          y: drag.y + (layer.canvas.height * drag.scaleY) / 2,
        };
        const original = Math.hypot(
          drag.start.x - center.x,
          drag.start.y - center.y,
        );
        const ratio =
          Math.hypot(point.x - center.x, point.y - center.y) /
          Math.max(1, original);
        const scaleX = Math.max(0.01, Math.min(100, drag.scaleX * ratio));
        const scaleY = Math.max(0.01, Math.min(100, drag.scaleY * ratio));
        editor.patch(
          {
            scaleX,
            scaleY,
            x: center.x - (layer.canvas.width * scaleX) / 2,
            y: center.y - (layer.canvas.height * scaleY) / 2,
          },
          "缩放图层",
          true,
        );
      } else if (drag.type === "brush" || drag.type === "eraser") {
        const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
        const points = events.length ? events : [event.nativeEvent];
        const bounds = artboard.current!.getBoundingClientRect();
        for (const next of points) {
          const p = {
            x: (next.clientX - bounds.left) / zoom,
            y: (next.clientY - bounds.top) / zoom,
          };
          editor.paint(
            drag.previous,
            p,
            drag.type === "eraser",
            next.pointerType === "pen" ? Math.max(0.05, next.pressure) : 1,
          );
          drag.previous = p;
        }
      } else if (["select", "rectangle", "ellipse"].includes(drag.type))
        setDraftShape(box(drag.start, clamped(point), event.shiftKey));
      drag.previous = point;
    } catch (error) {
      message((error as Error).message, true);
      endGesture(event);
    }
  }
  function endGesture(event: ReactPointerEvent) {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = null;
    try {
      if (drag.type === "select") {
        const selection = box(
          drag.start,
          clamped(position(event)),
          event.shiftKey,
        );
        editor.selection =
          selection.width > 0 && selection.height > 0 ? selection : null;
        editor.notify();
      } else if (drag.type === "rectangle" || drag.type === "ellipse")
        editor.shape(
          box(drag.start, clamped(position(event)), event.shiftKey),
          drag.type === "ellipse",
        );
      else if (["move", "scale", "brush", "eraser"].includes(drag.type))
        editor.commit(
          {
            move: "移动图层",
            scale: "缩放图层",
            brush: "画笔",
            eraser: "橡皮擦",
          }[drag.type as "move" | "scale" | "brush" | "eraser"],
        );
    } catch (error) {
      message((error as Error).message, true);
    }
    setDraftShape(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const selection = draftShape ?? editor.selection;
  const handles = corners(selected);
  const layerDisabled = selected.locked || working || editor.busy;
  const cursor =
    spaceHeld || editor.tool === "hand"
      ? "grab"
      : editor.tool === "move"
        ? "default"
        : "crosshair";
  const fieldChange = (patch: Partial<Layer>) =>
    safe(() => editor.patch(patch, "变换图层"));
  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    update: (value: number) => void,
  ) => (
    <label className="slider-row">
      <span>
        {label}
        <output>
          {value > 0 ? "+" : ""}
          {Math.round(value)}
        </output>
      </span>
      <input
        type="range"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        disabled={layerDisabled}
        onChange={(e) => safe(() => update(Number(e.target.value)))}
        onPointerUp={() => safe(() => editor.commit("调整颜色"))}
        onKeyUp={() => safe(() => editor.commit("调整颜色"))}
        onBlur={() => safe(() => editor.commit("调整颜色"))}
      />
    </label>
  );

  const documentActionDisabled = working || !recoveryReady || Boolean(recoveryOffer);
  return (
    <div className="app" aria-busy={working || editor.busy || !recoveryReady}>
      <header className="topbar">
        <div className="brand">
          <Layers3 size={23} />
          <span>
            compositor<small>BGSSAI · {platformName}</small>
          </span>
        </div>
        <div className="header-actions">
          <Button onClick={() => action("new")} disabled={documentActionDisabled}>
            <FilePlus2 size={16} />
            新建
          </Button>
          <Button onClick={() => action("open")} disabled={documentActionDisabled}>
            <FolderOpen size={16} />
            打开
          </Button>
          <span className="divider" />
          <Button
            title="撤销 (Ctrl+Z)"
            onClick={() => action("undo")}
            disabled={!editor.canUndo || working}
          >
            <Undo2 size={17} />
          </Button>
          <Button
            title="重做 (Ctrl+Shift+Z)"
            onClick={() => action("redo")}
            disabled={!editor.canRedo || working}
          >
            <Redo2 size={17} />
          </Button>
        </div>
        <div className="header-end">
          <Button title="账户与连接" onClick={() => action("connections")}>
            连接
          </Button>
          <Button title="检查更新" onClick={() => action("updates")}>
            更新
          </Button>
          <Button title="使用说明" onClick={() => action("help")}>
            <HelpCircle size={17} />
          </Button>
          <Button onClick={() => action("save")} disabled={working || welcome}>
            <Save size={16} />
            保存项目
          </Button>
          <Button
            className="primary"
            onClick={() => action("export")}
            disabled={working || welcome}
          >
            <Download size={16} />
            导出图像
          </Button>
        </div>
      </header>
      <div className="recovery-status" role="status">
        {autosaveStatus}
        {recoveryOffer && (
          <>
            <span> · {new Date(recoveryOffer.writtenAt).toLocaleString()}</span>
            <Button
              disabled={working}
              onClick={() =>
                void run(async () => {
                  if (!(await guard())) return;
                  await editor.load(recoveryOffer.content, false);
                  window.desktop?.resetProjectPath();
                  lastRecovery.current = recoveryOffer.content;
                  setRecoveryOffer(null);
                  setAutosaveStatus("项目已恢复，请保存到正式项目文件");
                  showDocument();
                })
              }
            >
              恢复上次项目
            </Button>
            <Button
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await recovery.clear();
                  setRecoveryOffer(null);
                  lastRecovery.current = null;
                  setAutosaveStatus("自动恢复已就绪");
                })
              }
            >
              丢弃恢复项目
            </Button>
          </>
        )}
      </div>
      <div className="optionsbar">
        <span className="tool-name">
          <currentTool.icon size={15} />
          {currentTool.name}
        </span>
        <span className="divider" />
        {["brush", "eraser"].includes(editor.tool) ? (
          <>
            <label>
              大小{" "}
              <input
                aria-label="画笔大小"
                type="range"
                value={editor.brushSize}
                min={1}
                max={500}
                onChange={(e) => {
                  editor.brushSize = Number(e.target.value);
                  editor.notify();
                }}
              />
              <output>{editor.brushSize} px</output>
            </label>
            <label>
              不透明度{" "}
              <input
                aria-label="画笔不透明度"
                type="range"
                value={editor.brushOpacity * 100}
                min={1}
                max={100}
                onChange={(e) => {
                  editor.brushOpacity = Number(e.target.value) / 100;
                  editor.notify();
                }}
              />
              <output>{Math.round(editor.brushOpacity * 100)}%</output>
            </label>
          </>
        ) : editor.tool === "select" ? (
          <>
            <span>拖动创建选区 · Shift 等比</span>
            <Button
              onClick={() =>
                safe(() => {
                  editor.crop();
                  fit();
                })
              }
              disabled={!editor.selection || welcome}
            >
              <Crop size={14} />
              裁切画布
            </Button>
            <Button
              onClick={() => {
                editor.selection = null;
                editor.notify();
              }}
            >
              取消选区
            </Button>
          </>
        ) : (
          <span className="tool-hint">
            {editor.tool === "move"
              ? "拖动移动 · 四角缩放 · Shift 保持当前图层 · 方向键微调"
              : editor.tool === "text"
                ? "点击画布添加文字，在右侧编辑内容与样式"
                : editor.tool === "hand"
                  ? "拖动平移画布 · 任意工具按住空格切换抓手"
                  : editor.tool === "eyedropper"
                    ? "点击画布采样颜色"
                    : "拖动绘制 · Shift 等比"}
          </span>
        )}
        <div className="options-end">
          <span className="local-dot" />
          本地工作空间
        </div>
      </div>
      <main className="editor-layout">
        <nav className="toolrail" aria-label="编辑工具">
          {TOOLS.map(({ id, name, key, icon: Icon }) => (
            <Button
              key={id}
              title={`${name} (${key})`}
              className={`tool-button ${editor.tool === id ? "active" : ""}`}
              onClick={() => {
                editor.tool = id;
                editor.notify();
              }}
              disabled={working}
            >
              <Icon size={19} />
            </Button>
          ))}
          <div className="rail-spacer" />
          <label className="color-swatch" title="前景色">
            <input
              type="color"
              aria-label="前景色"
              value={editor.color}
              onChange={(e) => {
                editor.color = e.target.value;
                editor.notify();
              }}
            />
            <span style={{ background: editor.color }} />
          </label>
          <Button title="使用说明" onClick={() => action("help")}>
            <HelpCircle size={18} />
          </Button>
        </nav>
        <section className="document-area">
          <div className="document-tab">
            <span className={editor.dirty ? "dirty-dot" : "doc-dot"} />
            <span>{welcome ? "开始创作" : `${editor.name}.bgcomp`}</span>
            {!welcome && (
              <small>
                {editor.width} × {editor.height}
              </small>
            )}
            <div className="tab-end">
              <Button
                title="导入图像为图层 (Ctrl+Shift+O)"
                onClick={() => action("import")}
                disabled={documentActionDisabled}
              >
                <ImagePlus size={15} />
                导入图像
              </Button>
            </div>
          </div>
          <div
            className={`workspace ${draggingFile ? "file-hover" : ""}`}
            ref={stage}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDraggingFile(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setDraggingFile(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDraggingFile(false);
              const file = e.dataTransfer.files[0];
              if (file)
                void run(async () =>
                  openFile(
                    await readFile(file),
                    !welcome && !file.name.toLowerCase().endsWith(".bgcomp"),
                  ),
                );
            }}
          >
            {welcome ? (
              <div className="welcome">
                <div className="welcome-art">
                  <div className="art-frame frame-back" />
                  <div className="art-frame frame-front">
                    <span className="art-sun" />
                    <span className="art-hill hill-back" />
                    <span className="art-hill hill-front" />
                    <span className="art-caption">
                      MAKE ROOM
                      <br />
                      FOR IDEAS.
                    </span>
                  </div>
                  <span className="art-badge">
                    <Layers3 size={16} />
                    每一层，都是可能。
                  </span>
                </div>
                <p className="eyebrow">YOUR NEXT GREAT IMAGE STARTS HERE</p>
                <h1>让灵感，自由成像。</h1>
                <p className="welcome-copy">
                  从一张图片或一块空白画布开始。
                  <br />
                  组合图层、勾勒细节，创作属于你的画面。
                </p>
                <div className="welcome-actions">
                  <Button className="primary" onClick={() => action("new")} disabled={documentActionDisabled}>
                    <Plus size={17} />
                    创建画布
                  </Button>
                  <Button onClick={() => action("open")} disabled={documentActionDisabled}>
                    <FolderOpen size={17} />
                    打开图像或项目
                  </Button>
                </div>
                <button className="demo-link" onClick={() => action("demo")} disabled={documentActionDisabled}>
                  打开示例，探索图层 <span>↗</span>
                </button>
                <p className="welcome-foot">
                  支持 PNG / JPEG / WebP / BMP · 拖放图片即可开始
                </p>
              </div>
            ) : (
              <div
                className="canvas-field"
                style={{
                  width: `max(100%, ${editor.width * zoom + 160}px)`,
                  height: `max(100%, ${editor.height * zoom + 140}px)`,
                }}
              >
                <div
                  className="artboard"
                  ref={artboard}
                  style={{
                    width: editor.width * zoom,
                    height: editor.height * zoom,
                    cursor,
                  }}
                  onPointerDown={(e) => startGesture(e)}
                  onPointerMove={moveGesture}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                  onPointerLeave={() => {
                    if (!gesture.current) setPointer(null);
                  }}
                >
                  <canvas
                    ref={canvas}
                    aria-label="图像画布"
                    className="image-canvas"
                    width={editor.width}
                    height={editor.height}
                  />
                  <svg
                    className="overlays"
                    width={editor.width * zoom}
                    height={editor.height * zoom}
                    viewBox={`0 0 ${editor.width} ${editor.height}`}
                    overflow="visible"
                  >
                    {editor.tool === "move" &&
                      selected.visible &&
                      !selected.locked && (
                        <>
                          <polygon
                            points={handles
                              .map((p) => `${p.x},${p.y}`)
                              .join(" ")}
                            className="transform-outline"
                            style={{ strokeWidth: 1 / zoom }}
                          />
                          {handles.map((p, i) => (
                            <rect
                              key={i}
                              x={p.x - 4 / zoom}
                              y={p.y - 4 / zoom}
                              width={8 / zoom}
                              height={8 / zoom}
                              className="transform-handle"
                              style={{ strokeWidth: 1 / zoom }}
                              onPointerDown={(e) => startGesture(e, true)}
                              onPointerMove={moveGesture}
                              onPointerUp={endGesture}
                              onPointerCancel={endGesture}
                            />
                          ))}
                        </>
                      )}
                    {selection && (
                      <rect
                        x={selection.x}
                        y={selection.y}
                        width={selection.width}
                        height={selection.height}
                        rx={
                          editor.tool === "ellipse" && draftShape
                            ? selection.width / 2
                            : 0
                        }
                        className="selection-outline"
                        style={{
                          strokeWidth: 1.5 / zoom,
                          strokeDasharray: `${5 / zoom} ${4 / zoom}`,
                        }}
                      />
                    )}
                    {pointer &&
                      !gesture.current &&
                      ["brush", "eraser"].includes(editor.tool) && (
                        <circle
                          cx={pointer.x}
                          cy={pointer.y}
                          r={editor.brushSize / 2}
                          className="brush-cursor"
                          style={{ strokeWidth: 1 / zoom }}
                        />
                      )}
                  </svg>
                </div>
              </div>
            )}
            {draggingFile && (
              <div className="drop-overlay">
                <ImagePlus size={34} />
                <strong>松开以导入图像</strong>
                <span>
                  {welcome ? "图像将创建新文档" : "图像将添加为新图层"}
                </span>
              </div>
            )}
          </div>
          <div className="canvas-status">
            <span>
              {working || editor.busy
                ? "正在处理…"
                : welcome
                  ? "准备就绪"
                  : `${editor.width} × ${editor.height} px · RGB / 8 位`}
            </span>
            {pointer && !welcome && (
              <span className="coordinates">
                X {Math.round(pointer.x)} · Y {Math.round(pointer.y)}
              </span>
            )}
            <div className="zoom-controls">
              <Button
                title="缩小"
                onClick={() => setZoom(Math.max(0.05, zoom / 1.2))}
              >
                <Minus size={14} />
              </Button>
              <select
                aria-label="缩放比例"
                value={Math.round(zoom * 100)}
                onChange={(e) => setZoom(Number(e.target.value) / 100)}
              >
                {[
                  ...new Set([
                    5,
                    10,
                    25,
                    50,
                    75,
                    100,
                    150,
                    200,
                    400,
                    Math.round(zoom * 100),
                  ]),
                ]
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}%
                    </option>
                  ))}
              </select>
              <Button
                title="放大"
                onClick={() => setZoom(Math.min(4, zoom * 1.2))}
              >
                <Plus size={14} />
              </Button>
              <Button title="适合窗口 (Ctrl+0)" onClick={fit}>
                <Maximize size={14} />
              </Button>
            </div>
          </div>
        </section>
        <aside className="inspector" aria-label="图层与属性">
          <div className="inspector-heading">
            <SlidersHorizontal size={15} />
            <span>图层属性</span>
            <small>{selected.text ? "文字" : "像素"}</small>
          </div>
          <div className="properties-scroll">
            <div className="layer-name-row">
              <input
                aria-label="图层名称"
                key={`${selected.id}:${selected.name}`}
                defaultValue={selected.name}
                maxLength={200}
                disabled={layerDisabled}
                onBlur={(e) => {
                  if (e.target.value !== selected.name)
                    safe(() =>
                      editor.patch(
                        { name: e.target.value.trim() || "图层" },
                        "重命名图层",
                      ),
                    );
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <Button
                title={selected.locked ? "解锁图层" : "锁定图层"}
                onClick={() =>
                  safe(() =>
                    editor.patch({ locked: !selected.locked }, "锁定图层"),
                  )
                }
              >
                {selected.locked ? (
                  <LockKeyhole size={15} />
                ) : (
                  <UnlockKeyhole size={15} />
                )}
              </Button>
            </div>
            <div className="section-label">
              变换<span>PX</span>
            </div>
            <div className="transform-grid">
              <NumberField
                label="X"
                value={selected.x}
                disabled={layerDisabled}
                onCommit={(x) => fieldChange({ x })}
              />
              <NumberField
                label="Y"
                value={selected.y}
                disabled={layerDisabled}
                onCommit={(y) => fieldChange({ y })}
              />
              <NumberField
                label="宽度"
                value={selected.canvas.width * selected.scaleX}
                min={selected.canvas.width * 0.01}
                max={selected.canvas.width * 100}
                disabled={layerDisabled}
                onCommit={(width) =>
                  fieldChange({ scaleX: width / selected.canvas.width })
                }
              />
              <NumberField
                label="高度"
                value={selected.canvas.height * selected.scaleY}
                min={selected.canvas.height * 0.01}
                max={selected.canvas.height * 100}
                disabled={layerDisabled}
                onCommit={(height) =>
                  fieldChange({ scaleY: height / selected.canvas.height })
                }
              />
              <NumberField
                label="旋转"
                value={selected.rotation}
                min={-360}
                max={360}
                disabled={layerDisabled}
                onCommit={(rotation) => fieldChange({ rotation })}
              />
              <div className="flip-buttons">
                <Button
                  title="水平翻转"
                  onClick={() => fieldChange({ flipX: !selected.flipX })}
                  disabled={layerDisabled}
                >
                  <FlipHorizontal2 size={15} />
                </Button>
                <Button
                  title="垂直翻转"
                  onClick={() => fieldChange({ flipY: !selected.flipY })}
                  disabled={layerDisabled}
                >
                  <FlipVertical2 size={15} />
                </Button>
              </div>
            </div>
            {selected.text && (
              <TextProperties key={selected.id} layer={selected} safe={safe} />
            )}
            <details className="adjustments">
              <summary>
                <Palette size={14} />
                颜色与滤镜
                <ChevronDown size={13} />
              </summary>
              <div>
                {slider(
                  "亮度",
                  selected.adjustments.brightness,
                  -100,
                  100,
                  (brightness) => editor.adjust({ brightness }, true),
                )}
                {slider(
                  "对比度",
                  selected.adjustments.contrast,
                  -100,
                  100,
                  (contrast) => editor.adjust({ contrast }, true),
                )}
                {slider(
                  "饱和度",
                  selected.adjustments.saturation,
                  -100,
                  200,
                  (saturation) => editor.adjust({ saturation }, true),
                )}
                {slider("模糊", selected.adjustments.blur, 0, 50, (blur) =>
                  editor.adjust({ blur }, true),
                )}
                <Button
                  onClick={() =>
                    safe(() =>
                      editor.adjust({
                        brightness: 0,
                        contrast: 0,
                        saturation: 0,
                        blur: 0,
                      }),
                    )
                  }
                  disabled={layerDisabled}
                >
                  <RotateCcw size={12} />
                  重置调整
                </Button>
              </div>
            </details>
          </div>
          <div className="panel-tabs">
            <button
              className={panel === "layers" ? "selected" : ""}
              onClick={() => setPanel("layers")}
            >
              图层 <small>{editor.layers.length}</small>
            </button>
            <button
              className={panel === "history" ? "selected" : ""}
              onClick={() => setPanel("history")}
            >
              历史记录
            </button>
            <Button
              title="新建图层"
              onClick={() =>
                safe(() => {
                  editor.addBlank();
                  setWelcome(false);
                })
              }
              disabled={working}
            >
              <Plus size={16} />
            </Button>
          </div>
          {panel === "layers" ? (
            <>
              <div className="layer-compositing">
                <select
                  aria-label="混合模式"
                  value={selected.blend}
                  disabled={layerDisabled}
                  onChange={(e) =>
                    safe(() =>
                      editor.patch(
                        { blend: e.target.value as Layer["blend"] },
                        "混合模式",
                      ),
                    )
                  }
                >
                  {BLENDS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <label>
                  不透明度{" "}
                  <output>{Math.round(selected.opacity * 100)}%</output>
                </label>
                <input
                  aria-label="图层不透明度"
                  type="range"
                  min={0}
                  max={100}
                  value={selected.opacity * 100}
                  disabled={layerDisabled}
                  onChange={(e) =>
                    safe(() =>
                      editor.patch(
                        { opacity: Number(e.target.value) / 100 },
                        "图层不透明度",
                        true,
                      ),
                    )
                  }
                  onPointerUp={() => safe(() => editor.commit("图层不透明度"))}
                  onKeyUp={() => safe(() => editor.commit("图层不透明度"))}
                  onBlur={() => safe(() => editor.commit("图层不透明度"))}
                />
              </div>
              <div className="layer-list" aria-label="图层列表">
                {[...editor.layers].reverse().map((layer) => (
                  <div
                    key={layer.id}
                    className={`layer-row ${layer.id === selected.id ? "active" : ""} ${!layer.visible ? "hidden" : ""}`}
                    data-layer-id={layer.id}
                    draggable={!layer.locked && !working}
                    onDragStart={() => {
                      draggedLayer.current = layer.id;
                    }}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes("Files"))
                        e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      safe(() => editor.moveTo(draggedLayer.current, layer.id));
                      draggedLayer.current = "";
                    }}
                  >
                    <Button
                      title={
                        layer.visible
                          ? `隐藏 ${layer.name}`
                          : `显示 ${layer.name}`
                      }
                      onClick={() =>
                        safe(() => {
                          editor.select(layer.id);
                          editor.patch(
                            { visible: !layer.visible },
                            "切换可见性",
                          );
                        })
                      }
                    >
                      {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </Button>
                    <button
                      className="layer-select"
                      aria-label={`选择图层 ${layer.name}`}
                      onClick={() => {
                        if (!working && !editor.busy) editor.select(layer.id);
                      }}
                    >
                      <Thumbnail layer={layer} revision={revision} />
                      <span>
                        {layer.name}
                        <small>{layer.text ? "文字图层" : "像素图层"}</small>
                      </span>
                    </button>
                    {layer.locked && (
                      <LockKeyhole size={12} className="layer-lock" />
                    )}
                  </div>
                ))}
              </div>
              <div className="layer-footer">
                <Button
                  title="复制图层 (Ctrl+J)"
                  onClick={() => action("duplicate")}
                  disabled={working}
                >
                  <Copy size={15} />
                </Button>
                <Button
                  title="向下合并"
                  onClick={() => safe(() => editor.mergeDown())}
                  disabled={
                    layerDisabled || editor.layers.indexOf(selected) === 0
                  }
                >
                  <Layers3 size={15} />
                </Button>
                <span />
                <Button
                  title="上移图层"
                  onClick={() => safe(() => editor.reorder(1))}
                  disabled={layerDisabled}
                >
                  <ArrowUp size={15} />
                </Button>
                <Button
                  title="下移图层"
                  onClick={() => safe(() => editor.reorder(-1))}
                  disabled={layerDisabled}
                >
                  <ArrowDown size={15} />
                </Button>
                <Button
                  title="删除图层"
                  onClick={() => safe(() => editor.remove())}
                  disabled={layerDisabled || editor.layers.length === 1}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </>
          ) : (
            <div className="history-list">
              {editor.history.map((entry, index) => (
                <button
                  key={`${index}:${entry.label}`}
                  className={
                    index === editor.historyIndex
                      ? "current"
                      : index > editor.historyIndex
                        ? "future"
                        : ""
                  }
                  onClick={() => void run(() => editor.restore(index))}
                >
                  <span>
                    {index === editor.historyIndex ? (
                      <Check size={13} />
                    ) : (
                      <span className="history-dot" />
                    )}
                  </span>
                  {entry.label}
                  <small>{index + 1}</small>
                </button>
              ))}
              <p>最多保留 30 步；大项目自动减少历史记录以节省内存。</p>
            </div>
          )}
        </aside>
      </main>
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <HelpCircle size={17} /> : <Check size={17} />}
          <span>{toast.text}</span>
          <Button title="关闭通知" onClick={() => setToast(null)}>
            <X size={14} />
          </Button>
        </div>
      )}
      {modal === "connections" && (
        <Connections
          editor={editor}
          close={() => setModal(null)}
          message={message}
          adopt={async (content) => {
            if (!(await guard())) return false;
            await editor.load(content, false);
            window.desktop?.resetProjectPath();
            await recovery.clear();
            lastRecovery.current = null;
            setModal(null);
            showDocument();
            message("已下载云端项目，请保存到本地");
            return true;
          }}
        />
      )}
      {modal === "updates" && (
        <Updates close={() => setModal(null)} message={message} />
      )}
      {((modal && modal !== "connections" && modal !== "updates") ||
        confirm) && (
        <div className="modal-backdrop">
          <section
            className={`modal ${modal === "help" ? "help-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              confirm
                ? "保存更改"
                : modal === "new"
                  ? "新建画布"
                  : modal === "export"
                    ? "导出图像"
                    : "使用说明"
            }
          >
            <div className="modal-heading">
              <h2>
                {confirm
                  ? "保存当前更改？"
                  : modal === "new"
                    ? "从空白开始。"
                    : modal === "export"
                      ? "准备好分享你的作品。"
                      : "你的创作工作台。"}
              </h2>
              <Button
                title="关闭对话框"
                onClick={() => (confirm ? confirm("cancel") : setModal(null))}
              >
                <X size={18} />
              </Button>
            </div>
            {confirm ? (
              <>
                <p>
                  “{editor.name}”有尚未保存的更改。保存后可以继续编辑每个图层。
                </p>
                <div className="modal-actions">
                  <Button onClick={() => confirm("cancel")}>取消</Button>
                  <Button onClick={() => confirm("discard")}>不保存</Button>
                  <Button className="primary" onClick={() => confirm("save")}>
                    保存并继续
                  </Button>
                </div>
              </>
            ) : modal === "new" ? (
              <>
                <p className="modal-subtitle">为你的下一张作品，留一块空间。</p>
                <label className="form-label">
                  文档名称
                  <input
                    aria-label="文档名称"
                    autoFocus
                    value={newName}
                    maxLength={200}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </label>
                <div className="presets">
                  {[
                    ["横向", 1600, 1000],
                    ["方形", 1080, 1080],
                    ["竖向", 1080, 1920],
                  ].map(([label, width, height]) => (
                    <button
                      key={label}
                      className={
                        newWidth === width && newHeight === height
                          ? "active"
                          : ""
                      }
                      onClick={() => {
                        setNewWidth(Number(width));
                        setNewHeight(Number(height));
                      }}
                    >
                      {label}
                      <small>
                        {width} × {height}
                      </small>
                    </button>
                  ))}
                </div>
                <div className="two-fields">
                  <label className="form-label">
                    宽度 (px)
                    <input
                      aria-label="画布宽度"
                      type="number"
                      value={newWidth}
                      min={1}
                      max={8192}
                      onChange={(e) => setNewWidth(Number(e.target.value))}
                    />
                  </label>
                  <label className="form-label">
                    高度 (px)
                    <input
                      aria-label="画布高度"
                      type="number"
                      value={newHeight}
                      min={1}
                      max={8192}
                      onChange={(e) => setNewHeight(Number(e.target.value))}
                    />
                  </label>
                </div>
                <label className="form-label">
                  背景
                  <select
                    aria-label="画布背景"
                    value={background}
                    onChange={(e) => setBackground(e.target.value)}
                  >
                    <option value="transparent">透明</option>
                    <option value="#ffffff">白色</option>
                    <option value="#161819">深色</option>
                  </select>
                </label>
                <div className="modal-actions">
                  <span className="form-note">
                    RGB · 8 位 · 最高 1677 万像素
                  </span>
                  <Button
                    className="primary"
                    disabled={working}
                    onClick={() =>
                      void run(async () => {
                        checkDimensions(newWidth, newHeight);
                        if (!(await guard())) return;
                        editor.newDocument(
                          newName,
                          newWidth,
                          newHeight,
                          background,
                        );
                        await recovery.clear();
                        lastRecovery.current = null;
                        window.desktop?.resetProjectPath();
                        setModal(null);
                        showDocument();
                      })
                    }
                  >
                    <Plus size={16} />
                    创建画布
                  </Button>
                </div>
              </>
            ) : modal === "export" ? (
              <>
                <p className="modal-subtitle">将所有可见图层合成为一张图像。</p>
                <div className="export-summary">
                  <div>
                    <ImagePlus size={24} />
                  </div>
                  <span>
                    {editor.name}
                    <small>
                      {editor.width} × {editor.height} px
                    </small>
                  </span>
                </div>
                <label className="form-label">
                  格式
                  <select
                    aria-label="导出格式"
                    value={format}
                    onChange={(e) =>
                      setFormat(e.target.value as "png" | "jpeg")
                    }
                  >
                    <option value="png">PNG · 无损，保留透明区域</option>
                    <option value="jpeg">JPEG · 更小文件，适合分享</option>
                  </select>
                </label>
                {format === "jpeg" && (
                  <>
                    <label className="form-label">
                      JPEG 质量 · {quality}%
                      <input
                        aria-label="JPEG 质量"
                        type="range"
                        min={10}
                        max={100}
                        value={quality}
                        onChange={(e) => setQuality(Number(e.target.value))}
                      />
                    </label>
                    <label className="form-label">
                      透明区域填充色
                      <input
                        aria-label="导出背景色"
                        type="color"
                        value={exportBg}
                        onChange={(e) => setExportBg(e.target.value)}
                      />
                    </label>
                  </>
                )}
                <p className="export-note">
                  需要保留可编辑图层？请使用“保存项目”生成 .bgcomp 文件。
                </p>
                <div className="modal-actions">
                  <Button onClick={() => setModal(null)}>取消</Button>
                  <Button
                    className="primary"
                    disabled={working}
                    onClick={() =>
                      void run(async () => {
                        const data = editor.exportImage(
                          format,
                          quality / 100,
                          exportBg,
                        );
                        if (window.desktop) {
                          const result = await window.desktop.exportImage(
                            editor.name,
                            data,
                            format,
                          );
                          if (!result) return;
                        } else if (native)
                          await saveNative(editor.name, data, format);
                        else
                          download(
                            `${editor.name}.${format === "jpeg" ? "jpg" : "png"}`,
                            data,
                            `image/${format}`,
                          );
                        setModal(null);
                        message("图像已导出");
                      })
                    }
                  >
                    <Download size={16} />
                    导出图像
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="modal-subtitle">
                  BGSSAI Compositor {version} · {platformName}
                </p>
                <div className="help-grid">
                  <div>
                    <h3>文件与历史</h3>
                    {[
                      ["新建画布", "Ctrl N"],
                      ["打开项目或图像", "Ctrl O"],
                      ["导入为图层", "Ctrl Shift O"],
                      ["保存项目", "Ctrl S"],
                      ["另存项目", "Ctrl Shift S"],
                      ["导出图像", "Ctrl Shift E"],
                      ["撤销 / 重做", "Ctrl Z / Ctrl Shift Z"],
                      ["复制图层", "Ctrl J"],
                    ].map(([label, key]) => (
                      <p key={label}>
                        {label}
                        <kbd>{key}</kbd>
                      </p>
                    ))}
                  </div>
                  <div>
                    <h3>画布操作</h3>
                    {TOOLS.map((tool) => (
                      <p key={tool.id}>
                        {tool.name}
                        <kbd>{tool.key}</kbd>
                      </p>
                    ))}
                    <p>
                      画笔大小<kbd>[ / ]</kbd>
                    </p>
                    <p>
                      抓手 / 缩放<kbd>Space / Ctrl 滚轮</kbd>
                    </p>
                    <p>
                      适合窗口 / 100%<kbd>Ctrl 0 / Ctrl 1</kbd>
                    </p>
                  </div>
                </div>
                <div className="help-note">
                  图层列表支持拖动排序。矩形选区可以限制绘画范围，也可以裁切画布。文字图层可编辑，栅格化后可用画笔修改。PNG
                  导出保留透明，JPEG 将透明区域填为所选背景色。
                </div>
                <p className="help-limit">
                  首版不支持 PSD/PSB、RAW、图层蒙版和 CMYK；项目使用 .bgcomp
                  保存。参考 robbietilton/Compositor 的编辑工作流。
                </p>
                <div className="modal-actions">
                  <Button className="primary" onClick={() => setModal(null)}>
                    开始创作
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      <input
        ref={fileInput}
        hidden
        type="file"
        accept={
          fileMode.current === "image"
            ? ".png,.jpg,.jpeg,.webp,.bmp"
            : ".bgcomp,.png,.jpg,.jpeg,.webp,.bmp"
        }
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void run(async () =>
              openFile(await readFile(file), fileMode.current === "image"),
            );
          e.target.value = "";
        }}
      />
    </div>
  );
}
