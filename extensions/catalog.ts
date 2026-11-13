/**
 * Model catalog wiring.
 *
 * `lib/sync.mjs` keeps models.json equal to what the model host serves. This module decides when
 * to run it and makes a running session notice the result:
 *
 * - Every Pi start, including the short probes T3 Code runs to fill its model picker, refreshes a
 *   catalog older than `refreshSeconds`. T3's own provider refresh therefore drives discovery.
 * - A running session reloads its model registry when models.json changes, so a model another
 *   process discovered can be selected without restarting the thread.
 */
import { watch, type FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODELS_FILE, syncCatalog } from "../lib/sync.mjs";

const STATUS_KEY = "pi-t3-agent";

export default async function catalog(pi: ExtensionAPI, directory: string) {
  // Bounded, so an unreachable host cannot hold up T3's discovery probe.
  let last = await syncCatalog(directory, { timeoutMs: 4000 });
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;

  const report = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, last.status === "stale" ? "Model host unreachable. Using the last known models." : undefined);
  };
  const reloadRegistry = (ctx: ExtensionContext) => ctx.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
  const sync = (ctx: ExtensionContext, force: boolean) => {
    running ??= syncCatalog(directory, { force })
      .then(async (result: typeof last) => {
        last = result;
        if (result.status === "synced" && result.changed) await reloadRegistry(ctx);
        report(ctx);
      })
      .finally(() => { running = undefined; });
    return running;
  };

  pi.on("session_start", async (_event, ctx) => {
    watcher?.close();
    // The registry was built before this extension ran its first sync.
    await reloadRegistry(ctx);
    try {
      // Watch the directory: an atomic replace gives the file a new inode.
      watcher = watch(directory, { persistent: false }, (_change, file) => {
        if (file !== MODELS_FILE) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => void reloadRegistry(ctx), 200);
      });
      watcher.on("error", () => undefined);
    } catch { /* Without a watcher the registry still reloads at each session start and /pi-sync. */ }
    report(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    // Never delay a turn for metadata. The result applies to the next one.
    void sync(ctx, false);
  });
  pi.on("session_shutdown", () => {
    clearTimeout(debounce);
    watcher?.close();
    watcher = undefined;
  });

  pi.registerCommand("pi-sync", {
    description: "Ask the model host for its current models now",
    handler: async (_args, ctx) => {
      await running;
      await sync(ctx, true);
      const { status, state } = last;
      ctx.ui.notify(
        status === "synced"
          ? `${state.count} model${state.count === 1 ? "" : "s"} from the ${state.source === "juiced" ? "Juiced catalog" : "host's model list"}. Refresh the Pi provider in T3 Code settings to update its picker.`
          : status === "stale" ? `${state.error} The last known models are still in use.`
          : "Model sync is not configured. Run this package's setup.mjs.",
        status === "synced" ? "info" : "warning",
      );
    },
  });

  return {
    describe: () => {
      const { status, state } = last;
      if (status === "unconfigured") return "model sync not configured";
      if (status === "disabled") return "model sync off";
      const when = state.lastSuccess ? new Date(state.lastSuccess).toISOString() : "never";
      const estimated = state.estimated?.length ? `; context size is a guess for ${state.estimated.join(", ")}` : "";
      return `${state.count ?? 0} models, last synced ${when}${state.error ? ` (${state.error})` : ""}${estimated}`;
    },
  };
}
