"use client";

import { useCallback, useEffect, useState } from "react";

type CopyCommandProps = {
  command: string;
};

function copyWithFallback(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

export function CopyCommand({ command }: CopyCommandProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copyCommand = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
      } else if (!copyWithFallback(command)) {
        throw new Error("Copy command failed");
      }

      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }, [command]);

  useEffect(() => {
    if (status === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => setStatus("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [status]);

  return (
    <pre className="command-line">
      <code>{command}</code>
      <button
        aria-label={status === "copied" ? "Copied install command" : "Copy install command"}
        className="copy-icon"
        onClick={copyCommand}
        title={status === "copied" ? "Copied" : "Copy"}
        type="button"
      >
        <span className="copy-state" aria-live="polite">
          {status === "copied" ? "Copied" : status === "failed" ? "Failed" : ""}
        </span>
      </button>
    </pre>
  );
}
