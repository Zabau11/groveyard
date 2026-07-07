"use client";

import { useEffect, useState } from "react";
import { AsciiLogo } from "./AsciiLogo";

export function Header() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const updateHeader = () => {
      setIsScrolled(window.scrollY > 72);
    };

    updateHeader();
    window.addEventListener("scroll", updateHeader, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateHeader);
    };
  }, []);

  return (
    <header className={`site-header${isScrolled ? " is-scrolled" : ""}`}>
      <a className="brand-mark" href="#top" aria-label="Groveyard home">
        <AsciiLogo className="brand-logo" decorative />
      </a>
      <nav className="site-nav" aria-label="Primary">
        <a href="#advantages">Advantages</a>
        <a href="#uses">Uses</a>
        <a href="#setup">Setup</a>
      </nav>
      <div className="social-links">
        <a className="social-link" href="https://github.com/Zabau11/orchestrator" aria-label="Groveyard on GitHub">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.36 6.84 9.72.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.22-3.37-1.22-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1.01.07 1.54 1.06 1.54 1.06.89 1.57 2.34 1.12 2.91.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.75-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.94c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.41.2 2.46.1 2.72.64.71 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.38-.01 2.49-.01 2.82 0 .27.18.59.69.49A10.18 10.18 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"
            />
          </svg>
        </a>
        <a className="social-link npm-link" href="https://www.npmjs.com/package/@groveyard/mcp" aria-label="Groveyard MCP on npm">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M2 7h20v10H12v-2h-2v2H2V7Zm2 8h2V9H4v6Zm4 0h2V9H8v6Zm6 0h2V9h-4v6h2v-4h2v4Zm4 0h2V9h-2v6Z" />
          </svg>
        </a>
      </div>
    </header>
  );
}
