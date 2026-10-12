"use client";

import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import type { Mode } from "../domain/types";
import type { ActionMap, ActionName, ActionResult } from "./actions";
import { LiveClient, type DispatchClient } from "./client";
import { PreviewEngine } from "./preview-engine";

interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  text: string;
  simulated?: boolean;
}

interface Ctx {
  client: DispatchClient;
  mode: Mode;
  base: string; // route prefix: "/preview" or "/desk"
  version: number;
  refresh: () => void;
  run: <K extends ActionName>(name: K, input: ActionMap[K]["input"], opts?: { quiet?: boolean }) => Promise<ActionResult<ActionMap[K]["output"]>>;
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

const DispatchContext = createContext<Ctx | null>(null);

export function DispatchProvider({ mode, children }: { mode: Mode; children: ReactNode }) {
  const [client] = useState<DispatchClient>(() => (mode === "preview" ? new PreviewEngine() : new LiveClient()));
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.tone === "error" ? 9000 : 5000);
  }, []);

  const run = useCallback<Ctx["run"]>(
    async (name, input, opts) => {
      const result = await client.run(name, input);
      if (result.ok) {
        if (!opts?.quiet && result.message) toast({ tone: "success", text: result.message, simulated: result.simulated });
      } else if (!opts?.quiet) {
        toast({ tone: "error", text: result.error.message });
      }
      refresh();
      return result;
    },
    [client, refresh, toast],
  );

  const value = useMemo<Ctx>(
    () => ({ client, mode, base: mode === "preview" ? "/preview" : "/desk", version, refresh, run, toasts, toast, dismiss }),
    [client, mode, version, refresh, run, toasts, toast, dismiss],
  );
  return <DispatchContext.Provider value={value}>{children}</DispatchContext.Provider>;
}

export function useDispatch(): Ctx {
  const ctx = useContext(DispatchContext);
  if (!ctx) throw new Error("useDispatch must be used inside DispatchProvider");
  return ctx;
}

// Loads a view and reloads it whenever an action completes. Keeps showing the
// previous data while refreshing so the page doesn't flash.
export function useView<T>(load: (c: DispatchClient) => Promise<T>, deps: unknown[] = []) {
  const { client, version } = useDispatch();
  const key = JSON.stringify([version, ...deps]);
  const [state, setState] = useState<{ data: T | null; error: string | null; key: string | null }>({ data: null, error: null, key: null });
  const doLoad = useEffectEvent(() => load(client));

  useEffect(() => {
    let cancelled = false;
    doLoad().then(
      (data) => !cancelled && setState({ data, error: null, key }),
      (e: unknown) => !cancelled && setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Something went wrong loading this page.", key })),
    );
    return () => {
      cancelled = true;
    };
  }, [key, client]);

  return { data: state.data, error: state.error, loading: state.key !== key };
}
