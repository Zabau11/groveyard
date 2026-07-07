"use client";

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

  return (
    <div className="terminal-stage" aria-label="Groveyard terminal demo">
      <div className="terminal-top">
        <span className="dot red" />
        <span className="dot yellow" />
        <span className="dot green" />
        <span className="terminal-title">groveyard session</span>
      </div>
      <div className="terminal-body">
        <AsciiLogo className="ascii-wordmark" decorative />
        <div className="terminal-feed" aria-live="polite">
          <p>
            <span className="prompt">$</span> <span>{command.slice(0, characterIndex)}</span>
            <span className="cursor" aria-hidden="true" />
          </p>
          <p className="feed-muted">worktree: sess_k41</p>
          <p className="feed-ok">read, edit, diff, test, commit</p>
        </div>
      </div>
    </div>
  );
}
