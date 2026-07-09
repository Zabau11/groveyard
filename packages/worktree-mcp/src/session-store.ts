import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type SessionRecord,
  type SessionRegistryData,
  newSessionRegistryData,
  sessionRegistrySchema,
  touchSession,
} from "./sessions.js";

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class DuplicateSessionError extends Error {
  constructor(sessionId: string) {
    super(`Session already exists: ${sessionId}`);
    this.name = "DuplicateSessionError";
  }
}

export class JsonSessionStore {
  constructor(private readonly registryPath: string) {}

  async list(): Promise<SessionRecord[]> {
    const data = await this.load();
    return [...data.sessions].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(sessionId: string): Promise<SessionRecord> {
    const data = await this.load();
    const session = data.sessions.find((candidate) => candidate.id === sessionId);

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    return session;
  }

  async add(session: SessionRecord): Promise<SessionRecord> {
    const data = await this.load();

    if (data.sessions.some((candidate) => candidate.id === session.id)) {
      throw new DuplicateSessionError(session.id);
    }

    const nextData: SessionRegistryData = {
      ...data,
      sessions: [...data.sessions, session],
    };

    const saved = await this.save(nextData);
    return saved.sessions.find((candidate) => candidate.id === session.id) ?? session;
  }

  async update(sessionId: string, update: (session: SessionRecord) => SessionRecord): Promise<SessionRecord> {
    const data = await this.load();
    let updatedSession: SessionRecord | undefined;

    const sessions = data.sessions.map((session) => {
      if (session.id !== sessionId) {
        return session;
      }

      updatedSession = touchSession(update(session));
      return updatedSession;
    });

    if (!updatedSession) {
      throw new SessionNotFoundError(sessionId);
    }

    await this.save({
      ...data,
      sessions,
    });

    return updatedSession;
  }

  private async load(): Promise<SessionRegistryData> {
    let raw: string;

    try {
      raw = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return newSessionRegistryData();
      }

      throw error;
    }

    return sessionRegistrySchema.parse(JSON.parse(raw));
  }

  private async save(data: SessionRegistryData): Promise<SessionRegistryData> {
    const parsed = sessionRegistrySchema.parse(data);
    await mkdir(dirname(this.registryPath), { recursive: true });

    const tempPath = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await rename(tempPath, this.registryPath);
    return parsed;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
