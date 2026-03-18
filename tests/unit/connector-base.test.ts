/**
 * Unit tests for connector-base.ts
 * Tests RateLimiter, SessionManager, and CommandHandler
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  RateLimiter,
  SessionManager,
  CommandHandler,
  BaseConnector,
  type BaseSession,
  type SessionStats,
} from "../../src/connector-base"
import { ensureSessionDir, getSessionDir } from "../../src/session-utils"

// =============================================================================
// RateLimiter
// =============================================================================

describe("RateLimiter", () => {
  let limiter: RateLimiter

  beforeEach(() => {
    limiter = new RateLimiter()
  })

  test("allows first message from user", () => {
    expect(limiter.check("user1", 5)).toBe(true)
  })

  test("blocks rapid subsequent messages", () => {
    expect(limiter.check("user1", 5)).toBe(true)
    expect(limiter.check("user1", 5)).toBe(false)
  })

  test("allows messages after limit expires", async () => {
    expect(limiter.check("user1", 0.1)).toBe(true) // 100ms limit
    
    await new Promise(resolve => setTimeout(resolve, 150))
    
    expect(limiter.check("user1", 0.1)).toBe(true)
  })

  test("tracks users independently", () => {
    expect(limiter.check("user1", 5)).toBe(true)
    expect(limiter.check("user2", 5)).toBe(true)
    expect(limiter.check("user1", 5)).toBe(false)
    expect(limiter.check("user2", 5)).toBe(false)
  })

  test("clear removes all tracking", () => {
    limiter.check("user1", 5)
    limiter.check("user2", 5)
    
    limiter.clear()
    
    expect(limiter.check("user1", 5)).toBe(true)
    expect(limiter.check("user2", 5)).toBe(true)
  })

  test("handles zero limit (always allow)", () => {
    expect(limiter.check("user1", 0)).toBe(true)
    expect(limiter.check("user1", 0)).toBe(true)
  })
})

// =============================================================================
// SessionManager
// =============================================================================

describe("SessionManager", () => {
  // Mock session type for testing
  interface MockSession extends BaseSession {
    extra?: string
  }

  let manager: SessionManager<MockSession>

  function createMockSession(overrides?: Partial<MockSession>): MockSession {
    return {
      client: {} as any, // Mock client
      createdAt: new Date(),
      messageCount: 0,
      lastActivity: new Date(),
      inputChars: 0,
      outputChars: 0,
      ...overrides,
    }
  }

  beforeEach(() => {
    manager = new SessionManager<MockSession>()
  })

  describe("CRUD operations", () => {
    test("get returns undefined for non-existent session", () => {
      expect(manager.get("nonexistent")).toBeUndefined()
    })

    test("set and get session", () => {
      const session = createMockSession({ extra: "test" })
      manager.set("session1", session)
      
      const retrieved = manager.get("session1")
      expect(retrieved).toBe(session)
      expect(retrieved?.extra).toBe("test")
    })

    test("has returns correct boolean", () => {
      expect(manager.has("session1")).toBe(false)
      
      manager.set("session1", createMockSession())
      
      expect(manager.has("session1")).toBe(true)
    })

    test("delete removes session", () => {
      manager.set("session1", createMockSession())
      expect(manager.has("session1")).toBe(true)
      
      const result = manager.delete("session1")
      
      expect(result).toBe(true)
      expect(manager.has("session1")).toBe(false)
    })

    test("delete returns false for non-existent session", () => {
      expect(manager.delete("nonexistent")).toBe(false)
    })

    test("clear removes all sessions", () => {
      manager.set("session1", createMockSession())
      manager.set("session2", createMockSession())
      
      manager.clear()
      
      expect(manager.has("session1")).toBe(false)
      expect(manager.has("session2")).toBe(false)
    })
  })

  describe("trackMessage", () => {
    test("updates session stats", () => {
      const session = createMockSession({
        messageCount: 5,
        inputChars: 100,
        outputChars: 200,
      })
      manager.set("session1", session)

      manager.trackMessage("session1", 50, 100)

      const updated = manager.get("session1")!
      expect(updated.messageCount).toBe(6)
      expect(updated.inputChars).toBe(150)
      expect(updated.outputChars).toBe(300)
    })

    test("updates lastActivity", () => {
      const oldDate = new Date(Date.now() - 10000)
      const session = createMockSession({ lastActivity: oldDate })
      manager.set("session1", session)

      manager.trackMessage("session1", 10, 20)

      const updated = manager.get("session1")!
      expect(updated.lastActivity.getTime()).toBeGreaterThan(oldDate.getTime())
    })

    test("does nothing for non-existent session", () => {
      // Should not throw
      manager.trackMessage("nonexistent", 100, 200)
    })
  })

  describe("getStats", () => {
    test("returns null for non-existent session", () => {
      expect(manager.getStats("nonexistent")).toBeNull()
    })

    test("calculates correct stats", () => {
      const now = Date.now()
      const fiveMinutesAgo = new Date(now - 5 * 60 * 1000)
      const twoMinutesAgo = new Date(now - 2 * 60 * 1000)

      const session = createMockSession({
        createdAt: fiveMinutesAgo,
        lastActivity: twoMinutesAgo,
        inputChars: 1000,  // 250 tokens
        outputChars: 2000, // 500 tokens
      })
      manager.set("session1", session)

      const stats = manager.getStats("session1")!

      expect(stats.age).toBe(5)
      expect(stats.lastActivity).toBe(2)
      expect(stats.inputTokens).toBe(250)
      expect(stats.outputTokens).toBe(500)
      expect(stats.totalTokens).toBe(750)
      expect(parseFloat(stats.contextPercent)).toBeCloseTo(0.375, 1)
    })

    test("handles zero chars", () => {
      const session = createMockSession({
        inputChars: 0,
        outputChars: 0,
      })
      manager.set("session1", session)

      const stats = manager.getStats("session1")!

      expect(stats.inputTokens).toBe(0)
      expect(stats.outputTokens).toBe(0)
      expect(stats.totalTokens).toBe(0)
      expect(stats.contextPercent).toBe("0.00")
    })
  })
})

// =============================================================================
// CommandHandler
// =============================================================================

describe("CommandHandler", () => {
  describe("formatStatusMessage", () => {
    test("formats status with all fields", () => {
      const stats: SessionStats = {
        age: 10,
        lastActivity: 2,
        inputTokens: 1000,
        outputTokens: 2000,
        totalTokens: 3000,
        contextPercent: "1.50",
      }

      const result = CommandHandler.formatStatusMessage(15, stats)

      expect(result).toContain("Messages: 15")
      expect(result).toContain("Age: 10 min")
      expect(result).toContain("Last active: 2 min ago")
      expect(result).toContain("3,000") // totalTokens with locale formatting
      expect(result).toContain("1.50%")
      expect(result).toContain("Input:")
      expect(result).toContain("Output:")
    })

    test("formats large numbers with locale separators", () => {
      const stats: SessionStats = {
        age: 60,
        lastActivity: 5,
        inputTokens: 50000,
        outputTokens: 100000,
        totalTokens: 150000,
        contextPercent: "75.00",
      }

      const result = CommandHandler.formatStatusMessage(100, stats)

      expect(result).toContain("150,000")
    })
  })

  describe("formatHelpMessage", () => {
    test("includes trigger and bot name", () => {
      const result = CommandHandler.formatHelpMessage("!oc", "TestBot")

      expect(result).toContain("TestBot")
      expect(result).toContain("!oc")
      expect(result).toContain("/status")
      expect(result).toContain("/clear")
      expect(result).toContain("/help")
    })
  })

  describe("formatNoSessionMessage", () => {
    test("returns appropriate message", () => {
      const result = CommandHandler.formatNoSessionMessage()
      expect(result.toLowerCase()).toContain("no")
      expect(result.toLowerCase()).toContain("session")
    })
  })

  describe("formatSessionClearedMessage", () => {
    test("returns appropriate message", () => {
      const result = CommandHandler.formatSessionClearedMessage()
      expect(result.toLowerCase()).toContain("cleared")
    })
  })

  describe("formatUnknownCommandMessage", () => {
    test("includes the unknown command", () => {
      const result = CommandHandler.formatUnknownCommandMessage("/foo")
      expect(result).toContain("/foo")
      expect(result.toLowerCase()).toContain("unknown")
    })
  })

  describe("formatConnectionErrorMessage", () => {
    test("returns appropriate error message", () => {
      const result = CommandHandler.formatConnectionErrorMessage()
      expect(result.toLowerCase()).toContain("sorry")
      expect(result.toLowerCase()).toContain("connect")
    })
  })

  describe("formatProcessingErrorMessage", () => {
    test("returns appropriate error message", () => {
      const result = CommandHandler.formatProcessingErrorMessage()
      expect(result.toLowerCase()).toContain("sorry")
      expect(result.toLowerCase()).toContain("wrong")
    })
  })
})

describe("BaseConnector session cache cleanup", () => {
  interface MockSession extends BaseSession {}

  class TestConnector extends BaseConnector<MockSession> {
    constructor() {
      super({
        connector: "slack",
        trigger: "!oc",
        botName: "TestBot",
        rateLimitSeconds: 5,
        sessionRetentionDays: 7,
      })
    }

    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async sendMessage(_id: string, _text: string): Promise<void> {}

    setSession(id: string, session: MockSession): void {
      this.sessionManager.set(id, session)
    }

    async runCommand(id: string, command: string): Promise<string[]> {
      const sent: string[] = []
      await this.handleCommand(id, command, async (text) => {
        sent.push(text)
      })
      return sent
    }

    async runDisconnectAll(): Promise<void> {
      await this.disconnectAllSessions()
    }
  }

  let connector: TestConnector
  let sessionBaseDir: string

  const createMockSession = (): MockSession => ({
    client: { disconnect: async () => {} } as any,
    createdAt: new Date(),
    messageCount: 0,
    lastActivity: new Date(),
    inputChars: 0,
    outputChars: 0,
  })

  beforeEach(() => {
    sessionBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sessions-"))
    process.env.SESSION_BASE_DIR = sessionBaseDir
    connector = new TestConnector()
  })

  afterEach(() => {
    delete process.env.SESSION_BASE_DIR
    fs.rmSync(sessionBaseDir, { recursive: true, force: true })
  })

  test("/clear removes session cache directory", async () => {
    const id = "C123:1711111111.001"
    const sessionDir = getSessionDir("slack", id)
    ensureSessionDir(sessionDir)
    connector.setSession(id, createMockSession())

    const sent = await connector.runCommand(id, "/clear")

    expect(sent[0]).toContain("Session cleared")
    expect(fs.existsSync(sessionDir)).toBe(false)
  })

  test("disconnectAllSessions removes all session cache directories", async () => {
    const ids = ["C123:1711111111.001", "C123:1711111111.002"]
    const dirs = ids.map((id) => getSessionDir("slack", id))

    for (const [i, id] of ids.entries()) {
      ensureSessionDir(dirs[i])
      connector.setSession(id, createMockSession())
    }

    await connector.runDisconnectAll()

    for (const dir of dirs) {
      expect(fs.existsSync(dir)).toBe(false)
    }
  })
})
