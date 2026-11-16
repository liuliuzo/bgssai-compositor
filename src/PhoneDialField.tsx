import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DEFAULT_DIAL_CODE,
  findDialEntry,
  nationalMaxLength,
  nationalPlaceholder,
  toDialItems,
} from "./phoneDial";

export interface PhoneDialFieldProps {
  dialCode: string;
  onDialCodeChange: (dialCode: string) => void;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  dialAriaLabel?: string;
}

export function PhoneDialField({
  dialCode,
  onDialCodeChange,
  value,
  onChange,
  disabled = false,
  ariaLabel = "手机号",
  dialAriaLabel = "国家或地区区号",
}: PhoneDialFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const normalizedDial = dialCode || DEFAULT_DIAL_CODE;
  const activeEntry = useMemo(
    () => findDialEntry(normalizedDial),
    [normalizedDial],
  );
  const items = useMemo(() => toDialItems(query), [query]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="phone-dial-field" ref={containerRef}>
      <div className="phone-dial-combo">
        <button
          type="button"
          className="phone-dial-trigger"
          aria-label={dialAriaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => {
            setQuery("");
            setOpen((prev) => !prev);
          }}
        >
          <span className="phone-dial-iso">{activeEntry.iso}</span>
          <span className="phone-dial-code">{activeEntry.dial}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open && (
          <div
            className="phone-dial-popover"
            role="listbox"
            aria-label="选择国家或地区区号"
          >
            <input
              type="search"
              className="phone-dial-search"
              aria-label="搜索区号或国家地区"
              placeholder="搜索 +86 / CN / 中国"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="phone-dial-list">
              {items.length ? (
                items.map((item) => (
                  <button
                    key={`${item.iso}-${item.dial}`}
                    type="button"
                    role="option"
                    aria-selected={item.dial === normalizedDial}
                    className={`phone-dial-option${
                      item.dial === normalizedDial ? " active" : ""
                    }`}
                    onClick={() => {
                      onDialCodeChange(item.dial);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <span className="phone-dial-option-iso">{item.iso}</span>
                    <span className="phone-dial-option-name">{item.name}</span>
                    <span className="phone-dial-option-dial">{item.dial}</span>
                  </button>
                ))
              ) : (
                <div className="phone-dial-empty">无匹配区号</div>
              )}
            </div>
          </div>
        )}
      </div>
      <input
        type="tel"
        className="phone-dial-input"
        aria-label={ariaLabel}
        inputMode="tel"
        disabled={disabled}
        maxLength={nationalMaxLength(normalizedDial)}
        placeholder={nationalPlaceholder(normalizedDial)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
