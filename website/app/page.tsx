import { AsciiLogo } from "./components/AsciiLogo";
import { CopyCommand } from "./components/CopyCommand";

export default function Home() {
  return (
    <main className="page-shell">
      <section className="hero" aria-label="Groveyard">
        <AsciiLogo className="hero-logo" glitch />

        <p className="hero-lede">Safe, disposable Git workspaces for coding agents.</p>

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

      <section className="docs-section" id="setup" aria-labelledby="setup-title">
        <h2 id="setup-title">Setup</h2>
        <p>Run the latest Groveyard release from the repository where your coding agent works. Groveyard detects your coding app, configures its MCP connection and native instructions, then verifies that everything is ready.</p>
        <CopyCommand command="npx -y @groveyard/mcp@latest setup" />
        <pre className="code-block">
          <code>
            <span className="token-muted">$</span> npx -y @groveyard/mcp@latest setup
            {"\n"}
            <span className="token-key">✓</span> Found repository
            {"\n"}
            <span className="token-key">✓</span> Detected coding app
            {"\n"}
            <span className="token-key">✓</span> Installed Groveyard MCP
            {"\n"}
            <span className="token-key">✓</span> Added agent instructions
            {"\n"}
            <span className="token-key">✓</span> Verified connection
            {"\n\n"}
            <span className="token-string">Groveyard is ready. Restart your coding app, then give your agent a task.</span>
          </code>
        </pre>
      </section>

      <section className="docs-section" aria-labelledby="clients-title">
        <h2 id="clients-title">Works with your coding app</h2>
        <p>Groveyard supports Codex, Claude Code, VS Code/Copilot, Cursor, Gemini CLI, OpenCode, Claude Desktop, and other MCP clients.</p>
      </section>

      <section className="docs-section" aria-labelledby="usage-title">
        <h2 id="usage-title">Usage</h2>
        <p>Ask your agent to make a change. Groveyard creates or adopts an isolated workspace, keeps your main checkout clean, and validates the handoff.</p>
        <pre className="code-block">
          <code>
            <span className="token-muted">You:</span>
            {"\n"}
            <span className="token-string">Fix the authentication timeout. Run the tests.</span>
            {"\n\n"}
            <span className="token-muted">Agent:</span>
            {"\n"}
            <span className="token-key">✓</span> Groveyard session started
            {"\n"}
            <span className="token-key">✓</span> Working in an isolated workspace
            {"\n"}
            <span className="token-key">✓</span> Validation passed
            {"\n"}
            <span className="token-key">✓</span> Changes ready to merge
          </code>
        </pre>
      </section>

      <section className="docs-section" aria-labelledby="lifecycle-title">
        <h2 id="lifecycle-title">A complete task lifecycle</h2>
        <p>Start a session, work inside the returned workspace, validate the result, then finish or clean up when the task is done.</p>
        <pre className="code-block">
          <code>
            <span className="token-muted">start_session</span>  →  <span className="token-muted">session_status</span>  →  <span className="token-muted">validate_session</span>
            {"\n"}
            <span className="token-muted">finish_session</span> →  <span className="token-muted">cleanup_session</span>
          </code>
        </pre>
      </section>

      <footer className="site-footer">
        <AsciiLogo className="footer-logo" decorative glitch />
      </footer>
    </main>
  );
}
