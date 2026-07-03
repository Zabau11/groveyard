export type AgentOutputParser = {
  push: (chunk: string) => void;
  flush: () => void;
};

type ParserInput = {
  adapterName: string;
  command: string;
  onActivity: (activity: string) => void;
};

type JsonObject = Record<string, unknown>;

export function createAgentOutputParser(input: ParserInput): AgentOutputParser {
  const adapterName = input.adapterName.toLowerCase();
  const command = input.command.toLowerCase();

  if (adapterName === "codex" || command.includes("codex exec --json")) {
    return createLineParser((line) => describeCodexJsonLine(line), input.onActivity);
  }

  if (adapterName === "claude" || command.includes("claude")) {
    return createLineParser(describeClaudeTextLine, input.onActivity);
  }

  if (adapterName === "cursor" || command.includes("cursor-agent") || command.includes("cursor ")) {
    return createLineParser(describeCursorTextLine, input.onActivity);
  }

  return createNoopParser();
}

function createLineParser(describeLine: (line: string) => string | undefined, onActivity: (activity: string) => void): AgentOutputParser {
  let buffer = "";
  let lastActivity = "";

  function emit(activity: string | undefined): void {
    if (!activity || activity === lastActivity) {
      return;
    }

    lastActivity = activity;
    onActivity(activity);
  }

  function parseLine(line: string): void {
    emit(describeLine(line));
  }

  return {
    push(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        parseLine(line);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        parseLine(buffer);
      }
      buffer = "";
    },
  };
}

function createNoopParser(): AgentOutputParser {
  return {
    push(): void {},
    flush(): void {},
  };
}

function describeCodexJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  try {
    return describeCodexEvent(JSON.parse(trimmed) as JsonObject);
  } catch {
    return undefined;
  }
}

function describeCodexEvent(event: JsonObject): string | undefined {
  const type = stringValue(event.type) ?? stringValue(event.event) ?? "";
  const item = objectValue(event.item);
  const payload = objectValue(event.payload);
  const data = objectValue(event.data);
  const merged = [item, payload, data, event].filter(Boolean) as JsonObject[];
  const text = firstString(merged, ["text", "message", "content", "summary", "delta"]);
  const command = firstString(merged, ["command", "cmd"]);
  const path = firstString(merged, ["path", "file", "file_path", "target"]);
  const name = firstString(merged, ["name", "tool", "tool_name"]);
  const lowerType = type.toLowerCase();

  if (path && /(patch|edit|file|write|change)/.test(lowerType)) {
    return `editing ${path}`;
  }

  if (command) {
    return `running ${shortenCommand(command)}`;
  }

  if (name && /(tool|call|exec|command)/.test(lowerType)) {
    return `using ${name}`;
  }

  if (text && /(message|assistant|reason|status|turn)/.test(lowerType)) {
    return shortenText(text);
  }

  if (lowerType.includes("started")) {
    return "starting";
  }

  if (lowerType.includes("completed") || lowerType.includes("finished")) {
    return "finishing";
  }

  return undefined;
}

function describeClaudeTextLine(line: string): string | undefined {
  return describeCommonTextLine(line, "Claude");
}

function describeCursorTextLine(line: string): string | undefined {
  return describeCommonTextLine(line, "Cursor");
}

function describeCommonTextLine(line: string, agentLabel: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const commandMatch = trimmed.match(/^(?:\$|>|Running:?|run:) ?(.+)$/i);
  if (commandMatch?.[1]) {
    return `running ${shortenCommand(commandMatch[1])}`;
  }

  const fileMatch = trimmed.match(/((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|css|html))/i);
  if (fileMatch?.[1]) {
    if (/(edit|write|update|modify|patch|change)/i.test(trimmed)) {
      return `editing ${fileMatch[1]}`;
    }

    if (/(read|inspect|open|look)/i.test(trimmed)) {
      return `inspecting ${fileMatch[1]}`;
    }

    return `working with ${fileMatch[1]}`;
  }

  if (/(thinking|planning|analyzing|analysing)/i.test(trimmed)) {
    return `${agentLabel} is planning`;
  }

  if (/(test|typecheck|build|lint)/i.test(trimmed)) {
    return "running checks";
  }

  return undefined;
}

function firstString(objects: JsonObject[], keys: string[]): string | undefined {
  for (const object of objects) {
    for (const key of keys) {
      const value = stringValue(object[key]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function shortenCommand(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > 70 ? `${compact.slice(0, 67)}...` : compact;
}

function shortenText(text: string): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
}
