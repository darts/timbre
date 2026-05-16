import { RotateCcw } from "lucide-react";
import { ModelParam } from "@/lib/schema";
import { cn } from "@/lib/utils";

interface ParamControlsProps {
  schema: ModelParam[];
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
  onResetKey: (key: string) => void;
  disabled?: boolean;
}

export function ParamControls({ schema, values, onChange, onResetKey, disabled = false }: ParamControlsProps) {
  if (schema.length === 0) return null;
  return (
    <div className={cn("space-y-4", disabled && "opacity-60")}>
      {schema.map((p) => {
        const value = values[p.key] ?? p.default;
        const isDefault = value === p.default;
        return (
          <div key={p.key}>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-zinc-300">{p.label}</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  className={cn(
                    "input w-20 px-2 py-1 text-xs text-right",
                    disabled && "cursor-not-allowed",
                  )}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={value}
                  disabled={disabled}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    onChange(p.key, clamp(v, p.min, p.max));
                  }}
                />
                <button
                  type="button"
                  className="btn-ghost px-1.5 py-1 disabled:opacity-30"
                  title="Reset to default"
                  disabled={disabled || isDefault}
                  onClick={() => onResetKey(p.key)}
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
            </div>
            <input
              type="range"
              min={p.min}
              max={p.max}
              step={p.step}
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(p.key, Number(e.target.value))}
              className={cn(
                "w-full accent-indigo-500",
                disabled && "cursor-not-allowed",
              )}
            />
            {p.help && (
              <p className="mt-1 text-[11px] text-zinc-500 leading-snug">{p.help}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
