const terminalLine = document.querySelector("[data-terminal-line]");
const copyButton = document.querySelector(".copy-button");
const commandStrip = document.querySelector(".command-strip");

const commands = [
  "groveyard connect",
  "groveyard doctor --repo .",
  "create_session taskName=\"fix auth flow\"",
  "run_command_profile profile=\"typecheck\"",
  "commit_session message=\"Fix auth flow\"",
];

let commandIndex = 0;
let characterIndex = 0;
let deleting = false;

function tickTerminal() {
  if (!terminalLine) {
    return;
  }

  const command = commands[commandIndex];
  terminalLine.textContent = command.slice(0, characterIndex);

  if (!deleting && characterIndex < command.length) {
    characterIndex += 1;
    window.setTimeout(tickTerminal, 48);
    return;
  }

  if (!deleting && characterIndex === command.length) {
    deleting = true;
    window.setTimeout(tickTerminal, 1200);
    return;
  }

  if (deleting && characterIndex > 0) {
    characterIndex -= 1;
    window.setTimeout(tickTerminal, 24);
    return;
  }

  deleting = false;
  commandIndex = (commandIndex + 1) % commands.length;
  window.setTimeout(tickTerminal, 280);
}

async function copyInstallCommand() {
  if (!copyButton || !commandStrip) {
    return;
  }

  const text = commandStrip.getAttribute("data-copy-text") ?? "";
  await navigator.clipboard.writeText(text);
  copyButton.textContent = "copied";
  window.setTimeout(() => {
    copyButton.textContent = "copy";
  }, 1400);
}

copyButton?.addEventListener("click", () => {
  copyInstallCommand().catch(() => {
    if (copyButton) {
      copyButton.textContent = "select";
    }
  });
});

tickTerminal();
