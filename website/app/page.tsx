import { AsciiLogo } from "./components/AsciiLogo";

export default function Home() {
  return (
    <main className="page-shell">
      <section className="hero" aria-labelledby="hero-title">
        <AsciiLogo className="hero-logo" decorative glitch />

        <h1 id="hero-title">Git Worktree MCP</h1>
        <p className="hero-lede">Clean worktrees for coding agents. Local, small, and safe to inspect.</p>

        <a
          aria-label="Open GitHub repository"
          className="github-link"
          href="https://github.com/Zabau11/orchestrator"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
              clipRule="evenodd"
              d="M12 2C6.48 2 2 6.59 2 12.25c0 4.52 2.87 8.36 6.84 9.72.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.35 1.11 2.92.85.09-.67.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.34 9.34 0 0 1 12 7.01c.85 0 1.7.12 2.5.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.08 10.08 0 0 0 22 12.25C22 6.59 17.52 2 12 2Z"
              fillRule="evenodd"
            />
          </svg>
        </a>
      </section>

      <section className="docs-section" id="install" aria-labelledby="install-title">
        <h2 id="install-title">Installation</h2>
        <p>Install the Groveyard MCP package in the repository where agents should work.</p>
        <pre className="command-line">
          <code>npm install @groveyard/mcp</code>
          <span className="copy-icon" aria-hidden="true" />
        </pre>
      </section>

      <section className="docs-section" aria-labelledby="usage-title">
        <h2 id="usage-title">Usage</h2>
        <p>Ask your agent to use Groveyard. The server returns the workflow context it needs to stay safe.</p>
        <pre className="code-block">
          <code>
            <span className="token-muted">You:</span>
            {"\n"}
            <span className="token-string">"Create a Groveyard session for the auth refactor."</span>
            {"\n\n"}
            <span className="token-muted">Groveyard gives the agent:</span>
            {"\n"}
            <span className="token-key">sessionId</span>     which session to use
            {"\n"}
            <span className="token-key">worktreePath</span>  where edits are allowed
            {"\n"}
            <span className="token-key">nextSteps</span>     read, edit, test, diff, report
            {"\n"}
            <span className="token-key">guardrails</span>    scoped files + approved commands
            {"\n"}
            <span className="token-key">checklist</span>     status, diff, commit or cleanup
          </code>
        </pre>
      </section>

      <footer className="site-footer">
        <AsciiLogo className="footer-logo" decorative glitch />
      </footer>
    </main>
  );
}
