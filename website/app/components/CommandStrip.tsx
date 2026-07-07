"use client";

import { useState } from "react";

const installCommand = "npm install -g @groveyard/mcp";

export function CommandStrip() {
  const [label, setLabel] = useState("copy");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
      setLabel("copied");
      window.setTimeout(() => setLabel("copy"), 1400);
    } catch {
      setLabel("select");
    }
  }

  return (
    <div className="command-strip">
      <code>{installCommand}</code>
      <button className="copy-button" type="button" aria-label="Copy install command" onClick={copyCommand}>
        {label}
      </button>
    </div>
  );
}
