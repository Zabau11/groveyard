import { CommandStrip } from "./components/CommandStrip";
import { Header } from "./components/Header";
import { AsciiLogo } from "./components/AsciiLogo";
import { TerminalDemo } from "./components/TerminalDemo";

const advantages = [
  {
    kicker: "Isolation",
    title: "Agents work in disposable branches",
    body: "Every task starts in a Git worktree with a tracked session id, branch, base branch, and cleanup path.",
  },
  {
    kicker: "Control",
    title: "Commands come from your config",
    body: "Run test, lint, build, or typecheck profiles without handing the agent arbitrary shell access.",
  },
  {
    kicker: "Review",
    title: "Status and diff are first-class",
    body: "The MCP flow pushes agents to inspect changed files before saying a task is done.",
  },
  {
    kicker: "Setup",
    title: "Connect detects local agent configs",
    body: "Groveyard finds Codex, Claude Desktop, and Cursor config locations, then asks before creating files.",
  },
];

const uses = [
  {
    title: "Parallel agent tasks",
    body: "Spin up independent sessions for bug fixes, refactors, and docs without dirtying your base checkout.",
  },
  {
    title: "Safe command execution",
    body: "Expose only named command profiles, then let the agent run the checks that matter for that repo.",
  },
  {
    title: "Cleaner review handoff",
    body: "Ask the agent for the session branch, diff, and commit SHA instead of hunting through a mixed tree.",
  },
];

const setupSteps = [
  ["01", "Install", "npm install -g @groveyard/mcp"],
  ["02", "Connect", "groveyard connect"],
  ["03", "Check repo", "groveyard doctor --repo ."],
  ["04", "Let the agent create a session", "create_session"],
];

export default function Home() {
  return (
    <>
      <Header />

      <main id="top">
        <section className="hero-section">
          <div className="hero-copy">
            <p className="eyebrow">MCP worktrees for coding agents</p>
            <h1>
              Groveyard
              {" "}
              <span>Clean branches for ambitious agents.</span>
            </h1>
            <p className="hero-lede">
              Spin up isolated workspaces where agents can explore, edit, test, diff, and commit without trampling your main checkout.
            </p>
            <CommandStrip />
            <div className="hero-actions">
              <a className="primary-link" href="#setup">
                Start a session
              </a>
              <a className="secondary-link" href="#advantages">
                See why it works
              </a>
            </div>
          </div>

          <TerminalDemo />
        </section>

        <section className="signal-band" aria-label="Groveyard summary">
          <div>
            <strong>1 command</strong>
            <span>detects agent configs</span>
          </div>
          <div>
            <strong>1 worktree</strong>
            <span>per coding task</span>
          </div>
          <div>
            <strong>0 shell</strong>
            <span>for command profiles</span>
          </div>
        </section>

        <section className="content-section split-section" id="advantages">
          <div>
            <p className="eyebrow">Advantages</p>
            <h2>Built for real repos, not demo prompts.</h2>
            <p>
              Groveyard gives an MCP-capable agent a predictable workspace and a narrow set of tools. The agent can create a session,
              inspect files, run configured checks, show a diff, and commit the work without touching your active tree.
            </p>
          </div>
          <div className="advantage-grid">
            {advantages.map((advantage) => (
              <article key={advantage.title}>
                <span className="card-kicker">{advantage.kicker}</span>
                <h3>{advantage.title}</h3>
                <p>{advantage.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="content-section workflow-section" id="uses">
          <div className="workflow-copy">
            <p className="eyebrow">Use cases</p>
            <h2>Let agents move faster while Git stays legible.</h2>
            <p>
              Use Groveyard when multiple coding agents, background tasks, or experiments need to work around the same repository without
              stomping on local changes.
            </p>
          </div>
          <div className="workflow-visual" aria-hidden="true">
            <svg viewBox="0 0 680 340">
              <defs>
                <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
                  <path d="M 28 0 L 0 0 0 28" />
                </pattern>
              </defs>
              <rect className="grid-fill" width="680" height="340" />
              <path className="trunk" d="M88 170H592" />
              <path className="branch branch-one" d="M210 170C250 102 312 82 392 92" />
              <path className="branch branch-two" d="M292 170C336 238 404 258 500 236" />
              <path className="branch branch-three" d="M392 170C430 128 478 116 548 126" />
              <g className="node main-node">
                <circle cx="88" cy="170" r="10" />
                <text x="68" y="204">
                  main
                </text>
              </g>
              <g className="node">
                <circle cx="392" cy="92" r="9" />
                <text x="338" y="70">
                  agent/refactor
                </text>
              </g>
              <g className="node">
                <circle cx="500" cy="236" r="9" />
                <text x="462" y="272">
                  agent/fix
                </text>
              </g>
              <g className="node">
                <circle cx="548" cy="126" r="9" />
                <text x="502" y="104">
                  agent/docs
                </text>
              </g>
              <g className="node main-node">
                <circle cx="592" cy="170" r="10" />
                <text x="560" y="204">
                  review
                </text>
              </g>
            </svg>
          </div>
          <div className="use-grid">
            {uses.map((use) => (
              <article key={use.title}>
                <h3>{use.title}</h3>
                <p>{use.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="content-section setup-section" id="setup">
          <div>
            <p className="eyebrow">Setup</p>
            <h2>Connect once. Work in sessions.</h2>
          </div>
          <div className="setup-grid">
            {setupSteps.map(([number, title, command]) => (
              <article className="setup-step" key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <code>{command}</code>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-meta">
          <span>Groveyard</span>
          <span>Safe Git worktree sessions for coding agents.</span>
        </div>
        <AsciiLogo className="footer-logo" glitch />
      </footer>
    </>
  );
}
