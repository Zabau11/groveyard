"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

import { AsciiLogo } from "./AsciiLogo";

const commands = [
  'groveyard connect',
  'groveyard doctor --repo .',
  'create_session taskName="fix auth flow"',
  'run_command_profile profile="typecheck"',
  'commit_session message="Fix auth flow"',
];

export function TerminalDemo() {
  const [commandIndex, setCommandIndex] = useState(0);
  const [characterIndex, setCharacterIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [spotlight, setSpotlight] = useState({ x: 72, y: 48 });

  useEffect(() => {
    const command = commands[commandIndex] ?? commands[0];
    const delay = deleting ? 24 : characterIndex === command.length ? 1200 : 48;

    const timer = window.setTimeout(() => {
      if (!deleting && characterIndex < command.length) {
        setCharacterIndex((current) => current + 1);
        return;
      }

      if (!deleting && characterIndex === command.length) {
        setDeleting(true);
        return;
      }

      if (deleting && characterIndex > 0) {
        setCharacterIndex((current) => current - 1);
        return;
      }

      setDeleting(false);
      setCommandIndex((current) => (current + 1) % commands.length);
    }, delay);

    return () => window.clearTimeout(timer);
  }, [characterIndex, commandIndex, deleting]);

  const command = commands[commandIndex] ?? commands[0];
  const jumpToNextCommand = () => {
    setDeleting(false);
    setCharacterIndex(0);
    setCommandIndex((current) => (current + 1) % commands.length);
  };

  return (
    <div
      aria-label="Groveyard terminal demo"
      className="terminal-stage"
      onClick={jumpToNextCommand}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          jumpToNextCommand();
        }
      }}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSpotlight({
          x: Math.round(event.clientX - rect.left),
          y: Math.round(event.clientY - rect.top),
        });
      }}
      role="button"
      style={
        {
          "--terminal-spotlight-x": `${spotlight.x}px`,
          "--terminal-spotlight-y": `${spotlight.y}px`,
        } as CSSProperties
      }
      tabIndex={0}
    >
      <div className="terminal-top">
        <div className="window-controls" aria-hidden="true">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>
        <span className="terminal-title">groveyard session</span>
        <span className="terminal-badge">isolated</span>
      </div>
      <div className="terminal-body">
        <AsciiLogo className="ascii-wordmark" decorative />
        <div className="terminal-feed" aria-live="polite">
          <p className="terminal-command">
            <span className="prompt">$</span> <span>{command.slice(0, characterIndex)}</span>
            <span className="cursor" aria-hidden="true" />
          </p>
          <p className="feed-muted">
            <span>worktree</span>
            <strong>sess_k41</strong>
          </p>
          <p className="feed-ok">
            <span>allowed</span>
            <strong>read, edit, diff, test, commit</strong>
          </p>
        </div>
      </div>
    </div>
  );
}
