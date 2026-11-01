// Minimal Chrome DevTools Protocol client for the E2E runner.
// Uses Node's global `fetch` / `WebSocket` (Node >= 22), no dependencies.

export type PageTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};

export type PageProblem = { kind: "exception" | "console.error"; text: string };

type CDPResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
};

type CDPEvent = { method: string; params: unknown };

type RemoteObject = { value?: unknown; description?: string };

type EvaluateResult = {
  result?: RemoteObject;
  exceptionDetails?: { text?: string; exception?: RemoteObject };
};

export type CDPSession = {
  evaluate: <T extends unknown>(expression: string) => Promise<T>;
  /** Page.bringToFront — raises/focuses the window so macOS doesn't occlude it. */
  bringToFront: () => Promise<void>;
  /** console.error / uncaught exceptions logged on the page since `since`. */
  problems: PageProblem[];
  /** Incremented on every `Page.loadEventFired` (Vite full reload, Cmd+R ...). */
  loadCount: () => number;
  lastLoadAt: () => number;
  isClosed: () => boolean;
  close: () => void;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isResponse = (msg: unknown): msg is CDPResponse =>
  isObject(msg) && typeof msg.id === "number";

const isEvent = (msg: unknown): msg is CDPEvent => isObject(msg) && typeof msg.method === "string";

const isPageTarget = (value: unknown): value is PageTarget =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.type === "string" &&
  typeof value.url === "string" &&
  typeof value.webSocketDebuggerUrl === "string";

export const listPageTargets = async (port: number): Promise<PageTarget[]> => {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return [];
  return body.filter(isPageTarget).filter((t) => t.type === "page");
};

const describeRemoteObject = (obj: unknown): string => {
  if (!isObject(obj)) return "";
  if (obj.value !== undefined)
    return typeof obj.value === "string" ? obj.value : JSON.stringify(obj.value);
  return typeof obj.description === "string" ? obj.description : "";
};

// Runtime.enable replays console messages buffered before we attached, so
// anything older than the session start is ignored (it belongs to an earlier
// page load, e.g. one discarded by a Vite dep-optimization reload).
const toProblem = (event: CDPEvent, since: number): PageProblem | undefined => {
  if (!isObject(event.params)) return undefined;
  const { params } = event;
  const timestamp = typeof params.timestamp === "number" ? params.timestamp : Date.now();
  if (timestamp < since) return undefined;
  if (event.method === "Runtime.consoleAPICalled") {
    if (params.type !== "error" || !Array.isArray(params.args)) return undefined;
    return { kind: "console.error", text: params.args.map(describeRemoteObject).join(" ") };
  }
  if (event.method === "Runtime.exceptionThrown") {
    const details = isObject(params.exceptionDetails) ? params.exceptionDetails : {};
    const text =
      describeRemoteObject(details.exception) || `${details.text ?? "unknown exception"}`;
    return { kind: "exception", text };
  }
  return undefined;
};

const extractValue = <T extends unknown>(result: unknown): T => {
  const evaluated = result as EvaluateResult;
  if (evaluated.exceptionDetails) {
    const reason =
      describeRemoteObject(evaluated.exceptionDetails.exception) ||
      evaluated.exceptionDetails.text ||
      "evaluate failed";
    throw new Error(reason);
  }
  return evaluated.result?.value as T;
};

export const connectCDP = (wsURL: string): Promise<CDPSession> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsURL);
    const pending = new Map<number, (msg: CDPResponse) => void>();
    const problems: PageProblem[] = [];
    const since = Date.now();
    // Local mutable counters: plain `let` is clearer than a slot object here.
    let nextID = 0;
    let loads = 0;
    let lastLoadAt = 0;
    let closed = false;

    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      new Promise((res, rej) => {
        if (closed) {
          rej(new Error(`CDP socket closed (${method})`));
          return;
        }
        nextID += 1;
        pending.set(nextID, (msg) => {
          if (msg.error) {
            rej(new Error(`${method}: ${msg.error.message}`));
            return;
          }
          res(msg.result);
        });
        ws.send(JSON.stringify({ id: nextID, method, params }));
      });

    const handleEvent = (event: CDPEvent): void => {
      if (event.method === "Page.loadEventFired") {
        loads += 1;
        lastLoadAt = Date.now();
        return;
      }
      const problem = toProblem(event, since);
      if (problem) problems.push(problem);
    };

    ws.addEventListener("message", (ev) => {
      const msg: unknown = JSON.parse(`${ev.data}`);
      if (isResponse(msg)) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        return;
      }
      if (isEvent(msg)) handleEvent(msg);
    });

    ws.addEventListener("close", () => {
      closed = true;
      for (const settle of pending.values())
        settle({ id: -1, error: { message: "socket closed" } });
      pending.clear();
    });

    ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${wsURL}`)));

    ws.addEventListener("open", async () => {
      try {
        await send("Runtime.enable");
        await send("Page.enable");
        resolve({
          bringToFront: async () => {
            await send("Page.bringToFront");
          },
          evaluate: async <T extends unknown>(expression: string) =>
            extractValue<T>(
              await send("Runtime.evaluate", {
                expression,
                awaitPromise: true,
                returnByValue: true,
              }),
            ),
          problems,
          loadCount: () => loads,
          lastLoadAt: () => lastLoadAt,
          isClosed: () => closed,
          close: () => ws.close(),
        });
      } catch (err) {
        reject(err);
      }
    });
  });
