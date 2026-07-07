import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Groveyard - Safe worktrees for coding agents",
  description:
    "Groveyard is an MCP server and CLI that gives coding agents safe Git worktree sessions, scoped commands, diffs, and cleanup.",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
